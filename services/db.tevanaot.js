/**
 * Teva Naot database pool.
 *
 * Teva Naot data lives in the 'tevanaot' schema inside the same aspect-data-db
 * Cloud SQL instance as zer4u, newdeli, thestock, hypertoy and zolstock. We
 * re-export the shared pool — no separate connection needed.
 */

const { getPool, endPool } = require('./db.zer4u');

module.exports = { getPool, endPool };
