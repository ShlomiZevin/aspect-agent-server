/**
 * New Deli database pool.
 *
 * New Deli data lives in the 'newdeli' schema inside the same database as
 * zer4u (aspect-data-db Cloud SQL instance).  We simply re-export the zer4u
 * pool — no separate connection is needed.
 *
 * If New Deli data is ever migrated to a dedicated instance, replace the
 * re-export here with a standalone Pool configured from NEWDELI_DB_* env vars
 * without changing any other file.
 */

const { getPool, endPool } = require('./db.zer4u');

module.exports = { getPool, endPool };
