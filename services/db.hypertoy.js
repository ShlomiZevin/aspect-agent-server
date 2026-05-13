/**
 * Hyper Toy database pool.
 *
 * Hyper Toy data lives in the 'hypertoy' schema inside the same aspect-data-db
 * Cloud SQL instance as zer4u, newdeli, and thestock. We re-export the shared
 * pool — no separate connection needed.
 */

const { getPool, endPool } = require('./db.zer4u');

module.exports = { getPool, endPool };
