/**
 * One customer conversation, the basic facts — the management center's
 * "צפייה" window (task #985). Plain facts only: who, when, how long, which
 * phase (crew) it is in, real or test, and the WHOLE conversation as the
 * customer saw it (#1001 follow-up — it used to be the last 8 messages),
 * with each customer-chat problem (customerProblems.problemsOfConversation,
 * the same words as the problems page) placed under the message it happened
 * on (`anchorMessageId`). The full story (add-on runs, thinking, memory)
 * stays in the Builder; the window links there for the Lybi team.
 *
 * Customer chat only (`kind = 'user'`, `metadata.kind = 'live'`): Builder
 * test chats and simulations are never shown here. The conversation must
 * belong to the agent in the address — the route has already checked that
 * the person may open that agent.
 */

const db = require('../../services/db.pg');
const { audienceOf } = require('../runtime/conversationAudience');
const customerProblems = require('./customerProblems');

/** The newest this many messages are shown (`truncated` says when there are more). */
const MAX_MESSAGES = 1000;
/** One message's text is cut after this many characters (a pasted document, not a chat line). */
const MESSAGE_CHARS = 8000;

const clip = s => {
  const t = String(s || '').trim();
  return t.length > MESSAGE_CHARS ? `${t.slice(0, MESSAGE_CHARS - 1)}…` : t;
};
const iso = v => (v ? new Date(v).toISOString() : null);

/**
 * @param {{ slug: string, conversationId: number|string }} a
 * @returns {Promise<null | {
 *   id, agentSlug, agentName, customerName, audience, channel, status,
 *   startedAt, lastActivityAt, lastCustomerAt, messageCount, customerMessages,
 *   phase, messages: Array<{ id, role: 'customer'|'agent', text, at }>, shownMessages,
 *   truncated, problems: Array<CustomerProblem & { messageId, anchorMessageId }>
 * }>}  null = no such customer conversation on this agent.
 */
async function getConversation({ slug, conversationId }) {
  const id = Number(conversationId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const { rows } = await db.query(
    `SELECT c.id, c.channel, c.status, c.created_at, c.last_message_at, c.last_user_message_at,
            c.metadata->>'audience' AS audience,
            NULLIF(u.name, '') AS customer_name,
            a.url_slug AS agent_slug,
            (SELECT COALESCE(NULLIF(v.body->>'name', ''), b.slug)
               FROM builder_agents b LEFT JOIN builder_agent_versions v ON v.id = b.active_version_id
              WHERE b.slug = a.url_slug LIMIT 1) AS agent_name,
            (SELECT COALESCE(NULLIF(cv.body->>'name', ''), cr.id)
               FROM builder_crews cr LEFT JOIN builder_crew_versions cv ON cv.id = cr.active_version_id
              WHERE cr.id = c.metadata->>'currentCrewId') AS phase,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant') AND m.content <> '') AS message_count,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.conversation_id = c.id AND m.role = 'user') AS customer_messages
       FROM conversations c
       JOIN agents a ON a.id = c.agent_id
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = $1 AND a.url_slug = $2
        AND c.kind = 'user' AND c.metadata->>'kind' = 'live'`,
    [id, String(slug)],
  );
  const c = rows[0];
  if (!c) return null;

  const [{ rows: msgs }, problems] = await Promise.all([
    db.query(
      `SELECT id, role, content, created_at FROM (
         SELECT m.id, m.role, m.content, m.created_at FROM messages m
          WHERE m.conversation_id = $1 AND m.role IN ('user', 'assistant') AND m.content <> ''
          ORDER BY m.id DESC LIMIT ${MAX_MESSAGES}
       ) last ORDER BY id ASC`,
      [id],
    ),
    customerProblems.problemsOfConversation({ slug: c.agent_slug, conversationId: id, since: c.created_at }),
  ]);
  const messages = msgs.map(m => ({ id: m.id, role: m.role === 'user' ? 'customer' : 'agent', text: clip(m.content), at: iso(m.created_at) }));

  return {
    id: c.id,
    agentSlug: c.agent_slug,
    agentName: c.agent_name || c.agent_slug,
    customerName: c.customer_name || null,
    audience: audienceOf({ audience: c.audience }),
    channel: c.channel || null,
    status: c.status || null,
    startedAt: iso(c.created_at),
    lastActivityAt: iso(c.last_message_at),
    lastCustomerAt: iso(c.last_user_message_at),
    messageCount: Number(c.message_count) || 0,
    customerMessages: Number(c.customer_messages) || 0,
    phase: c.phase || null,
    messages,
    shownMessages: messages.length,
    /** More messages than shown — the newest MAX_MESSAGES are. */
    truncated: (Number(c.message_count) || 0) > messages.length,
    problems: problems.map(p => ({ ...p, anchorMessageId: anchorOf(p, messages) })),
  };
}

/**
 * The shown message a problem belongs under: its own message (the reply, or
 * the unanswered customer message); else — its reply was never sent (an
 * empty reply is not shown) or it has no message — the last shown message
 * before it (by id, else by time). null = before the first shown message.
 */
function anchorOf(p, messages) {
  if (!messages.length) return null;
  if (p.messageId) {
    if (messages.some(m => m.id === p.messageId)) return p.messageId;
    const before = messages.filter(m => m.id < p.messageId);
    if (before.length) return before[before.length - 1].id;
  }
  const t = new Date(p.at).getTime();
  const earlier = messages.filter(m => m.at && new Date(m.at).getTime() <= t);
  return earlier.length ? earlier[earlier.length - 1].id : null;
}

module.exports = { getConversation, MAX_MESSAGES, _internal: { anchorOf } };
