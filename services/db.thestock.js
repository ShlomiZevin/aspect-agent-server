/**
 * The Stock database pool.
 *
 * The Stock data lives in the 'thestock' schema inside the same database as
 * zer4u and newdeli (aspect-data-db Cloud SQL instance). We simply re-export
 * the zer4u pool — no separate connection is needed.
 *
 * If The Stock data is ever migrated to a dedicated instance, replace the
 * re-export here with a standalone Pool configured from THESTOCK_DB_* env vars
 * without changing any other file.
 */

const { getPool, endPool } = require('./db.zer4u');

module.exports = { getPool, endPool };
