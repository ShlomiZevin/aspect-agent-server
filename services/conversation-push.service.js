/**
 * conversation-push.service — deliver a proactive message to an open
 * chat, wherever that chat happens to be connected.
 *
 * See docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * ── Why this isn't a Set of response objects ───────────────────────
 *
 * The obvious implementation — keep the open SSE responses in a Set and
 * write to them — works perfectly in development and silently loses most
 * messages in production. Cloud Run runs 1–3 copies of this server
 * behind a load balancer (deploy.sh: --min-instances 1 --max-instances
 * 3). The customer's chat holds its connection to ONE copy. The trigger
 * that decides to nudge them may fire on a DIFFERENT copy, which has no
 * connection to that customer and no way to reach the copy that does.
 *
 * The bridge is Postgres `LISTEN`/`NOTIFY`, which every copy already has
 * a connection to. The firing copy issues one NOTIFY; whichever copy is
 * holding that conversation's subscribers forwards it down. No new
 * infrastructure, no service discovery, no sticky sessions.
 *
 * ── The message is already saved before any of this runs ───────────
 *
 * Push is a nicety, not the delivery mechanism. `runProactive` writes
 * the message to `messages` first, so a customer whose tab is closed —
 * or whose push is dropped for any reason — simply sees it the next time
 * the conversation loads, like any other message. Nothing here is
 * allowed to fail loudly, because nothing here is load-bearing.
 *
 * LISTEN is per-connection, so this checks out ONE client from the pool
 * and keeps it. That is the whole cost: one connection per server copy,
 * held only once something actually subscribes.
 */

const db = require('./db.pg');

/** Postgres channel names are identifiers; keep them short and safe. */
const CHANNEL = 'conversation_push';

/** conversationId → Set of subscriber callbacks on THIS copy. */
const subscribers = new Map();

let listenClient = null;
let connecting = null;

/**
 * Open (once) the dedicated LISTEN connection.
 *
 * Deliberately lazy: a server copy that never has an open chat never
 * holds a connection for this. Re-entrant — concurrent callers await the
 * same promise rather than opening several.
 */
async function ensureListening() {
  if (listenClient) return listenClient;
  if (connecting) return connecting;

  connecting = (async () => {
    // db.pg exports a singleton whose `pool` is set on initialize().
    const pool = db.pool;
    if (!pool) throw new Error('Database not initialised — no pool for LISTEN');
    const client = await pool.connect();

    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL) return;
      let payload;
      try { payload = JSON.parse(msg.payload); } catch { return; }
      const set = subscribers.get(Number(payload.conversationId));
      if (!set) return;
      for (const fn of set) {
        // One bad subscriber must not stop the others receiving it.
        try { fn(payload); } catch (err) {
          console.error('[conversation-push] subscriber threw:', err.message);
        }
      }
    });

    // A dropped LISTEN connection is silent otherwise: the server keeps
    // running and simply stops delivering, which looks like "proactive
    // is broken" with nothing in the logs. Reconnect on the next
    // subscribe instead of pretending we're still listening.
    client.on('error', (err) => {
      console.error('[conversation-push] LISTEN connection error:', err.message);
      try { client.release(true); } catch { /* already gone */ }
      listenClient = null;
      connecting = null;
    });

    await client.query(`LISTEN ${CHANNEL}`);
    listenClient = client;
    connecting = null;
    console.log('[conversation-push] listening for cross-instance pushes');
    return client;
  })().catch(err => {
    connecting = null;
    throw err;
  });

  return connecting;
}

/**
 * Subscribe an open chat to one conversation.
 *
 * @param {number} conversationId
 * @param {(payload: object) => void} onPush
 * @returns {Promise<() => void>} unsubscribe
 */
async function subscribe(conversationId, onPush) {
  const id = Number(conversationId);
  await ensureListening();

  let set = subscribers.get(id);
  if (!set) { set = new Set(); subscribers.set(id, set); }
  set.add(onPush);

  return () => {
    const s = subscribers.get(id);
    if (!s) return;
    s.delete(onPush);
    if (s.size === 0) subscribers.delete(id);
  };
}

/**
 * Announce something new on a conversation to every copy.
 *
 * Best-effort by design — see the header. A failed NOTIFY costs the
 * customer a refresh, never the message.
 *
 * @param {number} conversationId
 * @param {object} payload  small: ids and a type, not the message body.
 *   Kept small deliberately — Postgres caps a NOTIFY payload at 8000
 *   bytes, and an assistant message can exceed that. Subscribers fetch
 *   the message by id, so the wire format can never be the limit.
 */
async function push(conversationId, payload) {
  try {
    await db.query('SELECT pg_notify($1, $2)', [
      CHANNEL,
      JSON.stringify({ conversationId: Number(conversationId), ...payload }),
    ]);
  } catch (err) {
    console.error('[conversation-push] notify failed (message is still saved):', err.message);
  }
}

/** How many chats this copy is currently holding — for health output. */
function stats() {
  return {
    listening: !!listenClient,
    conversations: subscribers.size,
    subscribers: Array.from(subscribers.values()).reduce((n, s) => n + s.size, 0),
  };
}

module.exports = { subscribe, push, stats, CHANNEL };
