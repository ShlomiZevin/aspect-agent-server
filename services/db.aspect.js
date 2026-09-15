/**
 * TechZone (the Aspect demo agent's Technology vertical) database pool.
 *
 * This is synthetic demo data, not a real client feed — it lives in the
 * `aspect` schema inside the same database as zer4u, hypertoy, superhist etc.
 * (the aspect-data-db Cloud SQL instance), so this re-exports the zer4u pool —
 * no separate connection is needed. See scripts/seed-aspect-synthetic.js for
 * how the schema is built and seeded (a one-off generator, not the GCS
 * import pipeline the real clients use — there is no client file drop here).
 */

const { getPool, endPool } = require('./db.zer4u');

module.exports = { getPool, endPool };
