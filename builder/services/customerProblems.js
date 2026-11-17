/**
 * Customer-chat problems (task #985) — what went wrong for CUSTOMERS, in
 * plain Hebrew, for people who are not technical.
 *
 * Read by the management center's errors page (client `/manage/<slug>`,
 * API `builder/routes/manageRoute.js`) and by the Builder MCP
 * (`GET /builder/mcp/agents/:slug/customer-problems`). Both print the
 * sentences from THIS file, so the page and an AI assistant say the same
 * words. Change wording here, nowhere else.
 *
 * ── What counts as a problem ───────────────────────────────────────
 *
 *  1. Error Center rows (builder/services/errorCenter.js) with
 *     `source = 'customer'` — the outside chat only, never the Builder's
 *     test chat or simulations. Groups an admin marked "Ignored" in
 *     Admin → Errors are left out (known and harmless). The rows of ONE
 *     customer turn (a model call that was retried, then the add-on, then
 *     the turn) become ONE problem: keyed by the turn's reply message, or
 *     — for errors with no reply message — by conversation + area + a
 *     10-minute bucket.
 *  2. "No reply" — computed at read time, nothing is written: a customer
 *     conversation (`metadata.kind = 'live'`) whose LAST customer message
 *     has no non-empty assistant message after it, NO_REPLY_MINUTES after
 *     it was sent. (The runtime reserves an empty assistant row at the
 *     start of every turn, so "non-empty" is what tells a real answer.)
 *     It catches what throws nothing: a turn killed with its instance, a
 *     reply that never got written. Skipped when an Error Center problem
 *     already covers that turn.
 *  3. "Slow reply" — the customer got an answer, but it took longer than
 *     SLOW_REPLY_MS: read from `messages.metadata.replyTiming`, which the
 *     runtime writes on every reply since round 3 (builder/runtime/replyTiming.js).
 *     Older replies have no timing and never show. Chip "nothing to do",
 *     unless the agent had SLOW_REPEAT_PER_DAY slow replies that day.
 *
 * Every row carries `audience` ('real' | 'test', #968, fail closed) so the
 * page can tag test conversations — rows are never hidden for it.
 *
 * ── Did the customer get an answer? ────────────────────────────────
 *
 *  A turn's reply message with text → answered (the platform got past
 *  the error); missing or empty → no answer. Errors with no reply message:
 *  answered when an assistant message with text came after the error.
 *  Errors only in the background lanes (offline, Profiler, Live Brain)
 *  happen after the reply — the customer did not notice.
 *
 * Nothing here exposes codes, stacks or model names: the page links to
 * Admin → Errors for those.
 */

const db = require('../../services/db.pg');
const { audienceOf } = require('../runtime/conversationAudience');

/** A customer message still unanswered after this many minutes is a problem. */
const NO_REPLY_MINUTES = 3;
/** A reply that took longer than this (from the customer's message to the reply) is a "slow reply". */
const SLOW_REPLY_MS = 60 * 1000;
/** This many slow replies of one agent on one day (Israel time) = it repeats → call Shlomi. */
const SLOW_REPEAT_PER_DAY = 3;
const MAX_PROBLEMS = 200;
const LAST_MESSAGE_CHARS = 280;
const TZ = 'Asia/Jerusalem';
const RANGES = ['today', 'week'];

// ─── The plain-language table — one place ──────────────────────────

/**
 * The "what to do" chips — EVERY row has one, so the reader always knows
 * whether to act. `tone: 'act'` = someone should act (pink); `'ok'` =
 * nothing to do (green).
 */
const ACTIONS = {
  customer:  { id: 'customer', text: 'כדאי לפנות ללקוח', tone: 'act' },
  shlomi:    { id: 'shlomi', text: 'פנו לשלומי', tone: 'act' },
  auto:      { id: 'auto', text: 'תוקן אוטומטית – לא צריך לעשות כלום', tone: 'ok' },
  answered:  { id: 'answered', text: 'לא צריך לעשות כלום', tone: 'ok' },
  unnoticed: { id: 'unnoticed', text: 'לא צריך לעשות כלום', tone: 'ok' },
};

/** The one line under the customer's message: how it ended. */
const OUTCOMES = {
  noAnswer:      'לא התקבלה תשובה לאחר מכן',
  answeredLater: 'בסוף הלקוח קיבל תשובה',
  answered:      'השיחה המשיכה כרגיל',
  background:    'השיחה המשיכה כרגיל',
  triggerFailed: 'ההודעה לא יצאה',
};

// The "for dummies" test, for every sentence below: say what the CUSTOMER
// experienced, never how the agent works inside (no "stage", "add-on",
// "model", "credit", "database"). One short sentence.
const SMALL_GLITCH = 'הלקוח קיבל תשובה, אבל משהו קטן מאחורי הקלעים לא עבד';
const TEMP_GLITCH = 'הייתה תקלה זמנית, והלקוח קיבל תשובה בכל זאת';
const BUSY_WAIT = 'הלקוח חיכה קצת יותר מהרגיל בגלל עומס';

/**
 * Per Error Center kind:
 *   problem   — what happened, when the customer got NO answer
 *   handled   — what happened, when the customer got an answer anyway
 *   ask       — who should act when there was no answer: 'customer' | 'shlomi'
 *   transient — passes by itself (so an answered turn reads "fixed automatically")
 *   icon      — the row's picture on the page
 */
const KINDS = {
  model_no_credit:    { problem: 'הסוכנת הפסיקה לענות ללקוחות', handled: SMALL_GLITCH, ask: 'shlomi', transient: false, icon: 'alert' },
  model_rate_limit:   { problem: 'הלקוח לא קיבל תשובה בגלל עומס', handled: BUSY_WAIT, ask: 'customer', transient: true, icon: 'busy' },
  model_timeout:      { problem: 'הלקוח חיכה ולא קיבל תשובה', handled: 'הלקוח חיכה לתשובה יותר מהרגיל', ask: 'customer', transient: true, icon: 'clock' },
  model_refusal:      { problem: 'הסוכנת לא הסכימה לענות ללקוח', handled: SMALL_GLITCH, ask: 'customer', transient: false, icon: 'alert' },
  model_bad_answer:   { problem: 'הלקוח קיבל תשובה ריקה או חלקית', handled: SMALL_GLITCH, ask: 'customer', transient: false, icon: 'alert' },
  model_other:        { problem: 'הסוכנת לא הצליחה לענות בגלל תקלה זמנית', handled: TEMP_GLITCH, ask: 'customer', transient: true, icon: 'busy' },
  database:           { problem: 'הלקוח לא קיבל תשובה בגלל תקלה במערכת', handled: SMALL_GLITCH, ask: 'shlomi', transient: false, icon: 'alert' },
  external:           { problem: 'הלקוח לא קיבל תשובה בגלל תקלה זמנית', handled: TEMP_GLITCH, ask: 'customer', transient: true, icon: 'busy' },
  server_unavailable: { problem: 'המערכת הייתה עמוסה וההודעה של הלקוח לא נקלטה', handled: BUSY_WAIT, ask: 'shlomi', transient: true, icon: 'busy' },
  user_input:         { problem: 'ההודעה של הלקוח לא נקלטה', handled: 'הלקוח קיבל תשובה, אבל חלק מההודעה שלו לא נקלט', ask: 'customer', transient: false, icon: 'message' },
  code:               { problem: 'הלקוח לא קיבל תשובה בגלל תקלה במערכת', handled: SMALL_GLITCH, ask: 'shlomi', transient: false, icon: 'alert' },
};

/** Any kind not in the table above — never an empty row. */
const FALLBACK = { problem: 'הלקוח לא קיבל תשובה בגלל תקלה', handled: SMALL_GLITCH, ask: 'shlomi', transient: false, icon: 'alert' };

/** Cases that are not a kind. */
const SPECIAL = {
  noReply:    { title: 'הלקוח שלח הודעה ולא קיבל תשובה', icon: 'message' },
  background: { title: SMALL_GLITCH, icon: 'sparkle' },
  trigger:    { title: 'הודעה שהיינו אמורים לשלוח ללקוח לא נשלחה', icon: 'bell' },
  slowReply:  { title: 'התשובה ללקוח לקחה יותר מדקה', icon: 'clock' },
};

/** "התשובה הגיעה אחרי 75 שניות" / "… אחרי 3 דקות" — the slow reply's outcome line. */
function slowOutcome(replyMs) {
  const sec = Math.round(Number(replyMs) / 1000);
  return sec < 120 ? `התשובה הגיעה אחרי ${sec} שניות` : `התשובה הגיעה אחרי ${Math.round(sec / 60)} דקות`;
}

const BACKGROUND_AREAS = new Set(['offline', 'profiler', 'live-brain']);
/** Which row of a turn speaks for it: the most customer-visible area first. */
const AREA_ORDER = ['turn', 'server', 'model', 'addon', 'trigger', 'offline', 'profiler', 'live-brain', 'simulation'];

/**
 * The plain words for one problem.
 * @param {object} p
 * @param {'error'|'no_reply'|'slow_reply'} p.type
 * @param {number} [p.replyMs]          slow reply: how long it took
 * @param {boolean} [p.repeats]         slow reply: the agent had SLOW_REPEAT_PER_DAY or more that day
 * @param {string} [p.kind] [p.area]   the row that speaks for the turn
 * @param {boolean} [p.answered]        did the customer get an answer
 * @param {boolean} [p.backgroundOnly]  every error was in a background lane
 * @returns {{ title: string, action: {text,tone}, outcome: string, icon: string }}
 */
function plainWords({ type, kind, area, answered, backgroundOnly, replyMs, repeats }) {
  if (type === 'slow_reply') {
    return { title: SPECIAL.slowReply.title, action: repeats ? ACTIONS.shlomi : ACTIONS.answered, outcome: slowOutcome(replyMs), icon: SPECIAL.slowReply.icon };
  }
  if (type === 'no_reply') {
    return { title: SPECIAL.noReply.title, action: ACTIONS.customer, outcome: OUTCOMES.noAnswer, icon: SPECIAL.noReply.icon };
  }
  if (area === 'trigger') {
    return { title: SPECIAL.trigger.title, action: ACTIONS.customer, outcome: OUTCOMES.triggerFailed, icon: SPECIAL.trigger.icon };
  }
  if (backgroundOnly && answered) {
    return { title: SPECIAL.background.title, action: ACTIONS.unnoticed, outcome: OUTCOMES.background, icon: SPECIAL.background.icon };
  }
  const k = KINDS[kind] || FALLBACK;
  if (answered) {
    return k.transient
      ? { title: k.handled, action: ACTIONS.auto, outcome: OUTCOMES.answeredLater, icon: k.icon }
      : { title: k.handled, action: ACTIONS.answered, outcome: OUTCOMES.answered, icon: k.icon };
  }
  return { title: k.problem, action: ACTIONS[k.ask] || ACTIONS.shlomi, outcome: OUTCOMES.noAnswer, icon: k.icon };
}

// ─── Reads ─────────────────────────────────────────────────────────

const iso = v => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const clip = s => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > LAST_MESSAGE_CHARS ? `${t.slice(0, LAST_MESSAGE_CHARS - 1)}…` : t;
};

/** Israel midnight today and six days before, and the server's now. */
async function bounds() {
  const { rows } = await db.query(
    `SELECT (date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}') AS today,
            ((date_trunc('day', now() AT TIME ZONE '${TZ}') - interval '6 days') AT TIME ZONE '${TZ}') AS week,
            now() AS now`,
  );
  return { today: new Date(rows[0].today), week: new Date(rows[0].week), now: new Date(rows[0].now) };
}

/** Builder agents' display names (active version), optionally one slug. */
async function agentNames(slug) {
  const { rows } = await db.query(
    `SELECT a.slug, COALESCE(NULLIF(v.body->>'name', ''), a.slug) AS name, a.archived_at
       FROM builder_agents a
       LEFT JOIN builder_agent_versions v ON v.id = a.active_version_id
      WHERE ($1::text IS NULL OR a.slug = $1)`,
    [slug || null],
  );
  return rows.map(r => ({ slug: r.slug, name: r.name, archived: !!r.archived_at }));
}

/** Does this agent exist in the Builder? */
async function agentExists(slug) {
  return (await agentNames(slug)).length > 0;
}

async function errorRows(from, slug) {
  const { rows } = await db.query(
    `SELECT e.agent_slug, e.conversation_id, e.message_id, e.area, e.kind, e.created_at
       FROM error_events e
       LEFT JOIN error_groups g ON g.agent_slug = e.agent_slug AND g.fingerprint = e.fingerprint
      WHERE e.source = 'customer' AND e.created_at >= $1
        AND ($2::text IS NULL OR e.agent_slug = $2)
        AND g.status IS DISTINCT FROM 'ignored'
      ORDER BY e.created_at DESC
      LIMIT 2000`,
    [from, slug || null],
  );
  return rows;
}

async function noReplyRows(from, slug) {
  const { rows } = await db.query(
    `SELECT c.id AS conversation_id, a.url_slug AS agent_slug, lu.id AS user_msg_id, lu.content AS user_msg,
            c.last_user_message_at AS at
       FROM conversations c
       JOIN agents a ON a.id = c.agent_id
       CROSS JOIN LATERAL (
         SELECT m.id, m.content FROM messages m
          WHERE m.conversation_id = c.id AND m.role = 'user'
          ORDER BY m.id DESC LIMIT 1
       ) lu
      WHERE c.kind = 'user' AND c.metadata->>'kind' = 'live'
        AND c.last_user_message_at >= $1
        AND c.last_user_message_at < now() - make_interval(mins => $3)
        AND ($2::text IS NULL OR a.url_slug = $2)
        AND NOT EXISTS (
          SELECT 1 FROM messages r
           WHERE r.conversation_id = c.id AND r.role = 'assistant' AND r.id > lu.id AND r.content <> ''
        )
      ORDER BY c.last_user_message_at DESC
      LIMIT ${MAX_PROBLEMS}`,
    [from, slug || null, NO_REPLY_MINUTES],
  );
  return rows;
}

/** Customer conversations with customer activity since `from`, per agent. */
async function servedCounts(from, slug) {
  const { rows } = await db.query(
    `SELECT a.url_slug AS slug, COUNT(*)::int AS n
       FROM conversations c JOIN agents a ON a.id = c.agent_id
      WHERE c.kind = 'user' AND c.metadata->>'kind' = 'live'
        AND c.last_user_message_at >= $1
        AND ($2::text IS NULL OR a.url_slug = $2)
      GROUP BY 1`,
    [from, slug || null],
  );
  return new Map(rows.map(r => [r.slug, r.n]));
}

/** One customer turn's errors → one group. */
function groupErrors(rows) {
  const groups = new Map();
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    const key = r.message_id
      ? `m${r.message_id}`
      : `c${r.conversation_id || 0}-${r.area}-${Math.floor(t / 600000)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, agentSlug: r.agent_slug, conversationId: r.conversation_id, messageId: r.message_id, rows: [], first: t, last: t };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.first = Math.min(g.first, t);
    g.last = Math.max(g.last, t);
  }
  for (const g of groups.values()) {
    const rank = r => { const i = AREA_ORDER.indexOf(r.area); return i < 0 ? 99 : i; };
    g.lead = [...g.rows].sort((a, b) => rank(a) - rank(b))[0];
    g.backgroundOnly = g.rows.every(r => BACKGROUND_AREAS.has(r.area));
  }
  return [...groups.values()];
}

/** For each error group: did the customer get an answer, and their last message before it. */
async function turnFacts(groups) {
  const facts = new Map();
  if (!groups.length) return facts;
  const withConv = groups.filter(g => g.conversationId);
  if (!withConv.length) return facts;
  const { rows } = await db.query(
    `SELECT k.key,
            (SELECT m.content FROM messages m
              WHERE m.conversation_id = k.conv AND m.role = 'user'
                AND (k.before_id IS NULL OR m.id < k.before_id)
                AND (k.before_id IS NOT NULL OR m.created_at <= (k.before_ts AT TIME ZONE 'UTC'))
              ORDER BY m.id DESC LIMIT 1) AS last_user,
            CASE WHEN k.before_id IS NOT NULL
                 THEN EXISTS (SELECT 1 FROM messages r WHERE r.id = k.before_id AND r.content <> '')
                 ELSE EXISTS (SELECT 1 FROM messages r WHERE r.conversation_id = k.conv AND r.role = 'assistant'
                               AND r.content <> '' AND r.created_at > (k.before_ts AT TIME ZONE 'UTC'))
            END AS answered
       FROM unnest($1::text[], $2::int[], $3::int[], $4::timestamptz[]) AS k(key, conv, before_id, before_ts)`,
    [
      withConv.map(g => g.key),
      withConv.map(g => g.conversationId),
      withConv.map(g => g.messageId || null),
      withConv.map(g => new Date(g.first).toISOString()),
    ],
  );
  for (const r of rows) facts.set(r.key, { lastUser: r.last_user, answered: !!r.answered });
  return facts;
}

/**
 * Customer replies that took longer than SLOW_REPLY_MS (task #985, round 3) —
 * read from `messages.metadata.replyTiming` (builder/runtime/replyTiming.js),
 * so only replies since that was deployed. Customer chat only.
 */
async function slowReplyRows(from, slug) {
  const { rows } = await db.query(
    `SELECT r.id AS reply_id, r.conversation_id, a.url_slug AS agent_slug,
            (r.metadata->'replyTiming'->>'replyMs')::numeric AS reply_ms,
            (r.metadata->'replyTiming'->>'receivedAt')::timestamptz AS at,
            to_char((r.metadata->'replyTiming'->>'receivedAt')::timestamptz AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day,
            (SELECT m.content FROM messages m
              WHERE m.conversation_id = r.conversation_id AND m.role = 'user' AND m.id < r.id
              ORDER BY m.id DESC LIMIT 1) AS user_msg
       FROM conversations c
       JOIN agents a ON a.id = c.agent_id
       JOIN messages r ON r.conversation_id = c.id
      WHERE c.kind = 'user' AND c.metadata->>'kind' = 'live'
        AND c.last_message_at >= $1
        AND ($2::text IS NULL OR a.url_slug = $2)
        AND r.role = 'assistant' AND r.metadata ? 'replyTiming'
        AND (r.metadata->'replyTiming'->>'replyMs')::numeric > $3
        AND (r.metadata->'replyTiming'->>'receivedAt')::timestamptz >= $1
      ORDER BY r.id DESC
      LIMIT ${MAX_PROBLEMS}`,
    [from, slug || null, SLOW_REPLY_MS],
  );
  return rows;
}

/** Per conversation: the customer's name and real / test (#968 — fail closed: no mark = test). */
async function customerInfo(conversationIds) {
  const ids = [...new Set(conversationIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT c.id, NULLIF(u.name, '') AS name, c.metadata->>'audience' AS audience
       FROM conversations c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map(r => [r.id, { name: r.name, audience: audienceOf({ audience: r.audience }) }]));
}

/**
 * The problems page / MCP read.
 *
 * @param {object} a
 * @param {string|null} a.slug       one agent, or null for every agent
 * @param {'today'|'week'} [a.range] default 'today' (Israel time; week = today + 6 days before)
 * @returns {Promise<{ range, from, checkedAt, newCount, noReplyMinutes, problems, agents }>}
 *   problems newest first; `isNew` = in the last 24 h (no read-tracking).
 *   agents: [{ slug, name, archived, conversations, problems, needsAction }] — every
 *   Builder agent in scope with its customer conversations and problems in the range.
 */
async function listProblems({ slug = null, range = 'today' } = {}) {
  const r = RANGES.includes(range) ? range : 'today';
  const b = await bounds();
  const from = r === 'today' ? b.today : b.week;
  const dayAgo = b.now.getTime() - 24 * 3600 * 1000;
  // One read covers both the range and "new" (24 h) — the week always reaches back past 24 h.
  const fetchFrom = new Date(Math.min(b.week.getTime(), dayAgo));

  const [errs, silent, slow, served, names] = await Promise.all([
    errorRows(fetchFrom, slug),
    noReplyRows(fetchFrom, slug),
    slowReplyRows(fetchFrom, slug),
    servedCounts(from, slug),
    agentNames(slug),
  ]);

  const groups = groupErrors(errs);
  const [facts, customers] = await Promise.all([
    turnFacts(groups),
    customerInfo([...groups.map(g => g.conversationId), ...silent.map(s => s.conversation_id), ...slow.map(s => s.conversation_id)]),
  ]);
  const who = id => (id && customers.get(id)) || { name: null, audience: null };
  const nameOf = new Map(names.map(n => [n.slug, n.name]));

  const all = [];
  for (const g of groups) {
    const f = facts.get(g.key) || { lastUser: null, answered: false };
    const words = plainWords({ type: 'error', kind: g.lead.kind, area: g.lead.area, answered: f.answered, backgroundOnly: g.backgroundOnly });
    all.push({
      id: g.key, type: 'error',
      at: new Date(g.first).toISOString(),
      agentSlug: g.agentSlug, agentName: nameOf.get(g.agentSlug) || g.agentSlug,
      conversationId: g.conversationId || null,
      customerName: who(g.conversationId).name,
      audience: who(g.conversationId).audience,
      lastCustomerMessage: f.lastUser ? clip(f.lastUser) : null,
      answered: f.answered,
      replyMs: null,
      ...words,
    });
  }
  for (const s of silent) {
    const at = new Date(s.at).getTime();
    const covered = groups.some(g => g.conversationId === s.conversation_id
      && ((g.messageId && g.messageId > s.user_msg_id) || (!g.messageId && g.last >= at - 10000)));
    if (covered) continue;
    all.push({
      id: `n${s.conversation_id}-${s.user_msg_id}`, type: 'no_reply',
      at: iso(s.at),
      agentSlug: s.agent_slug, agentName: nameOf.get(s.agent_slug) || s.agent_slug,
      conversationId: s.conversation_id,
      customerName: who(s.conversation_id).name,
      audience: who(s.conversation_id).audience,
      lastCustomerMessage: clip(s.user_msg),
      answered: false,
      replyMs: null,
      ...plainWords({ type: 'no_reply' }),
    });
  }
  // Slow replies — the customer got an answer, late. A turn that also has an
  // Error Center row is told by that row. "Repeats" = SLOW_REPEAT_PER_DAY or
  // more slow replies of the same agent on the same day.
  const slowPerDay = new Map();
  for (const s of slow) slowPerDay.set(`${s.agent_slug}|${s.day}`, (slowPerDay.get(`${s.agent_slug}|${s.day}`) || 0) + 1);
  for (const s of slow) {
    if (groups.some(g => g.messageId && g.messageId === s.reply_id)) continue;
    const replyMs = Math.round(Number(s.reply_ms));
    all.push({
      id: `s${s.reply_id}`, type: 'slow_reply',
      at: iso(s.at),
      agentSlug: s.agent_slug, agentName: nameOf.get(s.agent_slug) || s.agent_slug,
      conversationId: s.conversation_id,
      customerName: who(s.conversation_id).name,
      audience: who(s.conversation_id).audience,
      lastCustomerMessage: s.user_msg ? clip(s.user_msg) : null,
      answered: true,
      replyMs,
      ...plainWords({ type: 'slow_reply', replyMs, repeats: (slowPerDay.get(`${s.agent_slug}|${s.day}`) || 0) >= SLOW_REPEAT_PER_DAY }),
    });
  }
  all.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  for (const p of all) p.isNew = new Date(p.at).getTime() >= dayAgo;

  const inRange = all.filter(p => new Date(p.at).getTime() >= from.getTime());
  const problemsBySlug = new Map();
  const actBySlug = new Map();
  for (const p of inRange) {
    problemsBySlug.set(p.agentSlug, (problemsBySlug.get(p.agentSlug) || 0) + 1);
    if (p.action.tone === 'act') actBySlug.set(p.agentSlug, (actBySlug.get(p.agentSlug) || 0) + 1);
  }

  // Every Builder agent in scope, plus any slug that only shows up in the data.
  const agentSlugs = new Set([...names.map(n => n.slug), ...served.keys(), ...problemsBySlug.keys()]);
  const agents = [...agentSlugs].map(s => {
    const n = names.find(x => x.slug === s);
    return {
      slug: s,
      name: n ? n.name : s,
      archived: n ? n.archived : false,
      conversations: served.get(s) || 0,
      problems: problemsBySlug.get(s) || 0,
      // Rows whose chip says someone should act (contact the customer / call Shlomi).
      needsAction: actBySlug.get(s) || 0,
    };
  }).sort((x, y) => (y.conversations - x.conversations) || (y.problems - x.problems) || x.name.localeCompare(y.name));

  return {
    range: r,
    from: from.toISOString(),
    checkedAt: b.now.toISOString(),
    newCount: all.filter(p => p.isNew).length,
    noReplyMinutes: NO_REPLY_MINUTES,
    slowReplySeconds: SLOW_REPLY_MS / 1000,
    problems: inRange.slice(0, MAX_PROBLEMS),
    agents,
  };
}

module.exports = {
  listProblems, agentExists, plainWords,
  ACTIONS, OUTCOMES, KINDS, FALLBACK, SPECIAL, RANGES, NO_REPLY_MINUTES, SLOW_REPLY_MS, SLOW_REPEAT_PER_DAY,
  _internal: { groupErrors },
};
