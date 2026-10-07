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

module.exports = { getActivityCounts };
