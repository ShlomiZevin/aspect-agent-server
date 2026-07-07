/**
 * Aspect BI dashboards persistence.
 *
 * Dashboards live in the main platform DB (db.pg singleton — already
 * initialized by server startup) in their own table, created lazily so the BI
 * module needs no migration step. The whole dashboard definition (widgets,
 * their query specs, global filters) is one JSONB document — the server never
 * interprets it beyond storing/returning it; queries always go through
 * /api/bi/query which validates specs independently.
 */

const db = require('../../services/db.pg');

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS bi_dashboards (
      id         SERIAL PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      name       TEXT NOT NULL,
      definition JSONB NOT NULL DEFAULT '{"widgets":[]}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  ensured = true;
}

async function listDashboards(datasetId) {
  await ensureTable();
  const result = await db.query(
    `SELECT id, dataset_id, name, updated_at,
            jsonb_array_length(COALESCE(definition->'widgets', '[]'::jsonb)) AS widget_count
     FROM bi_dashboards
     WHERE ($1::text IS NULL OR dataset_id = $1)
     ORDER BY updated_at DESC`,
    [datasetId || null]
  );
  return result.rows;
}

async function getDashboard(id) {
  await ensureTable();
  const result = await db.query('SELECT * FROM bi_dashboards WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function createDashboard({ datasetId, name, definition }) {
  await ensureTable();
  const result = await db.query(
    `INSERT INTO bi_dashboards (dataset_id, name, definition)
     VALUES ($1, $2, $3) RETURNING *`,
    [datasetId, name, JSON.stringify(definition || { widgets: [] })]
  );
  return result.rows[0];
}

async function updateDashboard(id, { name, definition }) {
  await ensureTable();
  const result = await db.query(
    `UPDATE bi_dashboards
     SET name       = COALESCE($2, name),
         definition = COALESCE($3, definition),
         updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, definition ? JSON.stringify(definition) : null]
  );
  return result.rows[0] || null;
}

async function deleteDashboard(id) {
  await ensureTable();
  const result = await db.query('DELETE FROM bi_dashboards WHERE id = $1', [id]);
  return result.rowCount > 0;
}

module.exports = { listDashboards, getDashboard, createDashboard, updateDashboard, deleteDashboard };
