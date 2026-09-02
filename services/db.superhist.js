/**
 * The Social Supermarket (הסופר החברתי) database pool.
 *
 * Its data lives in the `superhist` schema inside the same database as zer4u,
 * hypertoy, thestock and zolstock (the aspect-data-db Cloud SQL instance), so
 * this re-exports the zer4u pool — no separate connection is needed.
 *
 * If it is ever moved to a dedicated instance, replace the re-export with a
 * standalone Pool built from SUPERHIST_DB_* env vars; nothing else changes.
 */

const { getPool, endPool } = require('./db.zer4u');

module.exports = { getPool, endPool };
