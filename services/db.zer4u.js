/**
 * Zer4U dedicated database pool.
 *
 * All zer4u data operations (CSV import, indexing, materialized views,
 * and business queries) use this pool — isolated from the operational DB.
 *
 * Config priority:
 *   1. ZER4U_DB_* env vars  →  dedicated Cloud SQL instance (aspect-data-db)
 *   2. DB_* env vars        →  fallback to shared DB (local dev / first run)
 */

require('dotenv').config();
const { Pool, types } = require('pg');

// Postgres DATE columns (OID 1082) are parsed by `pg` into JS Date objects
// anchored to the SERVER's local timezone (e.g. local midnight). Formatting
// that back out via .toISOString()/UTC shifts the calendar date by a day in
// any non-UTC timezone — a DATE column has no time-of-day to begin with, so
// there's no "correct" instant to construct. Keep it as the plain
// "YYYY-MM-DD" string Postgres already sends over the wire; every consumer
// (chat table, popup, Excel export) just uses the string as-is.
types.setTypeParser(1082, (val) => val);

let _pool = null;

function getPool(options = {}) {
  if (_pool) return _pool;

  const host     = process.env.ZER4U_DB_HOST     || process.env.DB_HOST;
  const port     = process.env.ZER4U_DB_PORT     || process.env.DB_PORT     || 5432;
  const database = process.env.ZER4U_DB_NAME     || process.env.DB_NAME;
  const user     = process.env.ZER4U_DB_USER     || process.env.DB_USER;
  const password = process.env.ZER4U_DB_PASSWORD || process.env.DB_PASSWORD;

  const isUnixSocket = host && host.startsWith('/cloudsql/');

  const config = isUnixSocket
    ? { host, database, user, password, ...options }
    : { host, port: parseInt(port), database, user, password, ...options };

  _pool = new Pool({
    max: 10,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    connectionTimeoutMillis: 60000,
    idleTimeoutMillis: 600000,
    ...config,
  });

  const label = isUnixSocket ? `socket:${host}/${database}` : `${host}:${port}/${database}`;
  console.log(`[db.zer4u] Pool created → ${label}`);

  // Idle clients can be killed by the DB side (schema-swap reload, Cloud SQL
  // restart, admin command) — without this handler that surfaces as an
  // unhandled 'error' event on the pool and crashes the whole process.
  _pool.on('error', (err) => {
    console.error('[db.zer4u] Unexpected pool error (connection killed?):', err.message);
  });

  return _pool;
}

/**
 * End the pool (call on graceful shutdown or after CLI scripts finish).
 */
async function endPool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = { getPool, endPool };
