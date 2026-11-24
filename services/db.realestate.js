/**
 * Real-estate developer demo ("אופק יזמות") database pool.
 *
 * Synthetic demo data, not a real client feed — it lives in the `realestate`
 * schema inside the same database as zer4u, hypertoy, aspect etc. (the
 * aspect-data-db Cloud SQL instance), so this re-exports the zer4u pool. See
 * scripts/seed-realestate-synthetic.js for how the schema is built and seeded.
 */

const { getPool, endPool } = require('./db.zer4u');

module.exports = { getPool, endPool };
