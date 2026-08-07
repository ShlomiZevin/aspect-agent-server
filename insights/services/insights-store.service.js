/**
 * Postgres-backed storage for generated Aspect Intelligence insights —
 * replaces the old insights/data/generated-insights.json local-file Map
 * (see db/migrations/037_add_intelligence_insights.sql and project memory:
 * that file lived in the deploy build context and got baked into every
 * Docker image via `COPY . .`, silently resetting live production insights
 * back to whatever stale snapshot happened to be on the deploying machine's
 * disk on every single deploy). One row per insight in the main platform DB
 * (the same db.pg pool every other cross-cutting service uses — NOT any
 * per-dataset business-data pool), keyed by (dataset_id, user_id,
 * insight_id). The full insight object is stored as one JSONB blob (`data`)
 * — investigation.service.js already treats an insight as one atomic JS
 * object everywhere, so this keeps that shape intact; `tracked` and
 * `tracked_order` are ALSO promoted to real columns purely so
 * listing/sorting/filtering doesn't need to parse every row's JSONB in JS.
 */
const db = require('../../services/db.pg');

const TABLE = 'intelligence_insights';
const COLS = 'data, tracked, tracked_order, created_at';

/** `data` already carries every field itself — `tracked`/`created_at` are real columns purely for indexing, so this is the one place that resolves them back onto the plain insight object callers expect. */
function rowToInsight(row) {
  const insight = { ...row.data, tracked: row.tracked, createdAt: Number(row.created_at) };
  if (row.tracked_order !== null) insight.trackedOrder = Number(row.tracked_order);
  return insight;
}

async function listByUser(datasetId, userId) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM ${TABLE} WHERE dataset_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
    [datasetId, userId]
  );
  return rows.map(rowToInsight);
}

/** Admin-only, cross-user: every generated insight for this dataset regardless of which session created it. */
async function listAll(datasetId) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM ${TABLE} WHERE dataset_id = $1 ORDER BY created_at DESC`,
    [datasetId]
  );
  return rows.map(rowToInsight);
}

async function getById(datasetId, userId, insightId) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM ${TABLE} WHERE dataset_id = $1 AND user_id = $2 AND insight_id = $3`,
    [datasetId, userId, insightId]
  );
  return rows[0] ? rowToInsight(rows[0]) : null;
}

/** Admin-only: finds an insight regardless of which session owns it, returning its owning userId alongside it — the admin monitoring page has no specific userId to scope by. @returns {Promise<{userId: string, insight: Object}|null>} */
async function getByIdAny(datasetId, insightId) {
  const { rows } = await db.query(
    `SELECT user_id, ${COLS} FROM ${TABLE} WHERE dataset_id = $1 AND insight_id = $2`,
    [datasetId, insightId]
  );
  return rows[0] ? { userId: rows[0].user_id, insight: rowToInsight(rows[0]) } : null;
}

async function insert(datasetId, userId, insight) {
  await db.query(
    `INSERT INTO ${TABLE} (dataset_id, user_id, insight_id, data, tracked, tracked_order, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [datasetId, userId, insight.id, JSON.stringify(insight), !!insight.tracked, insight.trackedOrder ?? null, insight.createdAt]
  );
}

async function remove(datasetId, userId, insightId) {
  const { rowCount } = await db.query(
    `DELETE FROM ${TABLE} WHERE dataset_id = $1 AND user_id = $2 AND insight_id = $3`,
    [datasetId, userId, insightId]
  );
  return rowCount > 0;
}

/** Admin-only, cross-user version of remove — see getByIdAny. */
async function removeAny(datasetId, insightId) {
  const { rowCount } = await db.query(`DELETE FROM ${TABLE} WHERE dataset_id = $1 AND insight_id = $2`, [datasetId, insightId]);
  return rowCount > 0;
}

async function writeBack(datasetId, userId, insight) {
  await db.query(
    `UPDATE ${TABLE} SET data = $4, tracked = $5, tracked_order = $6 WHERE dataset_id = $1 AND user_id = $2 AND insight_id = $3`,
    [datasetId, userId, insight.id, JSON.stringify(insight), !!insight.tracked, insight.trackedOrder ?? null]
  );
}

/**
 * Generic read-modify-write: loads the row, applies `mutate` to the plain
 * insight object (same in-place-mutation style the rest of
 * investigation.service.js already uses, e.g. `insight.tracked = true`),
 * writes it back. Used for every single-insight update (markViewed,
 * setTracked, caching an actionPlan) so each keeps its existing simple
 * "just set a field" logic instead of a bespoke UPDATE per field.
 * @returns {Promise<Object|null>} the updated insight, or null if it doesn't exist
 */
async function updateInsight(datasetId, userId, insightId, mutate) {
  const current = await getById(datasetId, userId, insightId);
  if (!current) return null;
  mutate(current);
  await writeBack(datasetId, userId, current);
  return current;
}

/** Admin-only version of updateInsight — see getByIdAny. */
async function updateInsightAny(datasetId, insightId, mutate) {
  const found = await getByIdAny(datasetId, insightId);
  if (!found) return null;
  mutate(found.insight);
  await writeBack(datasetId, found.userId, found.insight);
  return found.insight;
}

async function listTracked(datasetId, userId) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM ${TABLE} WHERE dataset_id = $1 AND user_id = $2 AND tracked = true ORDER BY tracked_order ASC NULLS FIRST`,
    [datasetId, userId]
  );
  return rows.map(rowToInsight);
}

/**
 * "Manage tracking" drag-to-reorder — sequential, not batched: this list is
 * small (whatever one user has tracked, realistically single digits) and
 * reordering is a rare, deliberate action, not a hot path.
 */
async function reorderTracked(datasetId, userId, insightIds) {
  for (let i = 0; i < insightIds.length; i++) {
    await db.query(
      `UPDATE ${TABLE} SET tracked_order = $4 WHERE dataset_id = $1 AND user_id = $2 AND insight_id = $3 AND tracked = true`,
      [datasetId, userId, insightIds[i], i]
    );
  }
}

module.exports = { listByUser, listAll, getById, getByIdAny, insert, remove, removeAny, updateInsight, updateInsightAny, listTracked, reorderTracked };
