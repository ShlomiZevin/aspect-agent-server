/**
 * Zol Stock database pool.
 *
 * Zol Stock data lives in the 'zolstock' schema inside the same database as
 * zer4u / newdeli / thestock / hypertoy (aspect-data-db Cloud SQL instance).
 * We simply re-export the zer4u pool — no separate connection is needed.
 *
 * If Zol Stock data is ever migrated to a dedicated instance, replace the
 * re-export here with a standalone Pool configured from ZOLSTOCK_DB_* env vars
 * without changing any other file.
 */

const { getPool, endPool } = require('./db.zer4u');

module.exports = { getPool, endPool };
