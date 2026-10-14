/**
 * How much each Intelligence dataset is actually used — chat conversations and
 * custom apps — for the admin overviews (the cross-client table and one
 * project's own Overview page).
 *
 * Dataset ids are agent slugs (see datasets/registry), so a dataset's
 * conversations are its agent's. Everything here reads the platform DB only.
 */
const db = require('../../services/db.pg');
const { FROM_OUTSIDE } = require('../../otto/services/mcp.service');

// Test traffic writes real conversation rows: the customer-replay batteries
// (`replay-*`, 222 of zolstock's 667 rows in 2026-10) and Builder Playground
// sessions (`playground-*`). Counting them would report our own testing as
// client usage.
const REAL_CONVERSATION = `
  c.last_user_message_at IS NOT NULL
  AND (c.external_id IS NULL
       OR (c.external_id NOT LIKE 'replay-%' AND c.external_id NOT LIKE 'playground-%'))`;

function emptyCounts() {
  return { conversations: 0, conversations30d: 0, users: 0, lastConversationAt: null, ottoApps: 0, mcpApps: 0, publishedApps: 0 };
}

/**
 * @param {string[]} datasetIds
 * @returns {Promise<Record<string, ReturnType<typeof emptyCounts>>>}
 *   Apps exclude archived ones. Otto vs MCP is by origin: a screen created
 *   through the AI builder door opens its conversation with FROM_OUTSIDE.
 */
async function getActivityCounts(datasetIds) {
  const out = Object.fromEntries(datasetIds.map(id => [id, emptyCounts()]));
  if (datasetIds.length === 0) return out;

  const [conv, apps] = await Promise.all([
    db.query(
      `SELECT a.url_slug AS id,
              count(c.id)::int AS conversations,
              count(c.id) FILTER (WHERE c.created_at > NOW() - INTERVAL '30 days')::int AS conversations30d,
              count(DISTINCT c.user_id)::int AS users,
              max(c.last_user_message_at) AS last_conversation_at
         FROM agents a
         JOIN conversations c ON c.agent_id = a.id
        WHERE a.url_slug = ANY($1) AND ${REAL_CONVERSATION}
        GROUP BY a.url_slug`,
      [datasetIds]
    ),
    db.query(
      `SELECT dataset_id AS id,
              count(*) FILTER (WHERE conversation->0->>'content' IS DISTINCT FROM $2)::int AS otto,
              count(*) FILTER (WHERE conversation->0->>'content' = $2)::int AS mcp,
              count(*) FILTER (WHERE status = 'active')::int AS published
         FROM custom_modules
        WHERE dataset_id = ANY($1) AND status <> 'archived'
        GROUP BY dataset_id`,
      [datasetIds, FROM_OUTSIDE]
    ),
  ]);

  for (const r of conv.rows) {
    Object.assign(out[r.id], {
      conversations: r.conversations,
      conversations30d: r.conversations30d,
      users: r.users,
      lastConversationAt: r.last_conversation_at,
    });
  }
  for (const r of apps.rows) {
    Object.assign(out[r.id], { ottoApps: r.otto, mcpApps: r.mcp, publishedApps: r.published });
  }
  return out;
}

/**
 * One dataset's real conversations, most recently active first — the
 * Intelligence > Conversations admin page. `firstQuestion` is the opening user
 * message (what the conversation was about); `externalId` + `userId` are what
 * the admin's existing per-user conversation viewer opens by (rows without an
 * external id cannot be opened there).
 */
async function listConversations(datasetId, { limit = 300 } = {}) {
  // messages has no index on conversation_id, so per-conversation subqueries
  // re-scan the whole table once per row (3.9s for 300 rows). One grouped pass
  // over messages for the selected conversations does the same in one scan.
  const { rows } = await db.query(
    `WITH conv AS (
       SELECT c.id, c.external_id, c.user_id, c.channel, c.created_at, c.last_user_message_at
         FROM conversations c
         JOIN agents a ON a.id = c.agent_id
        WHERE a.url_slug = $1 AND ${REAL_CONVERSATION}
        ORDER BY c.last_user_message_at DESC
        LIMIT $2
     ),
     msg AS (
       SELECT m.conversation_id,
              count(*)::int AS message_count,
              (array_agg(left(m.content, 240) ORDER BY m.created_at, m.id)
                 FILTER (WHERE m.role = 'user'))[1] AS first_question
         FROM messages m
        WHERE m.conversation_id IN (SELECT id FROM conv)
        GROUP BY m.conversation_id
     )
     SELECT conv.*, u.email AS user_email, u.name AS user_name, u.external_id AS user_external_id,
            COALESCE(msg.message_count, 0) AS message_count, msg.first_question
       FROM conv
       LEFT JOIN msg ON msg.conversation_id = conv.id
       LEFT JOIN users u ON u.id = conv.user_id
      ORDER BY conv.last_user_message_at DESC`,
    [datasetId, limit]
  );
  return rows.map(r => ({
    id: r.id,
    externalId: r.external_id,
    userId: r.user_id,
    user: r.user_email || r.user_name || r.user_external_id || null,
    channel: r.channel,
    startedAt: r.created_at,
    lastMessageAt: r.last_user_message_at,
    messageCount: r.message_count,
    firstQuestion: r.first_question,
  }));
}

/**
 * Every custom app of one dataset (archived included, newest activity first)
 * — the Intelligence > Apps admin page. `origin` is where it was built: Otto
 * inside the Intelligence Center, or the AI builder door (MCP).
 */
async function listApps(datasetId) {
  const { rows } = await db.query(
    `SELECT m.id, m.title, m.summary, m.status, m.created_by, m.created_at, m.updated_at,
            (m.conversation->0->>'content' = $2) AS from_mcp,
            creator.email AS creator_email, creator.name AS creator_name,
            b.status AS build_status, b.finished_at AS build_finished_at
       FROM custom_modules m
       LEFT JOIN LATERAL (
         -- created_by is the viewer id (users.external_id); one per id, even if
         -- the same visitor exists under more than one tenant
         SELECT email, name FROM users WHERE external_id = m.created_by ORDER BY id LIMIT 1
       ) creator ON true
       LEFT JOIN LATERAL (
         SELECT status, finished_at FROM custom_module_builds
          WHERE dataset_id = m.dataset_id AND screen_id = m.id
          ORDER BY started_at DESC LIMIT 1
       ) b ON true
      WHERE m.dataset_id = $1
      ORDER BY m.updated_at DESC`,
    [datasetId, FROM_OUTSIDE]
  );
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    origin: r.from_mcp ? 'mcp' : 'otto',
    createdBy: r.creator_email || r.creator_name || r.created_by || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastBuild: r.build_status ? { status: r.build_status, finishedAt: r.build_finished_at } : null,
  }));
}

module.exports = { getActivityCounts, listConversations, listApps };
