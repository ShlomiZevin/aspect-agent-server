/**
 * The task board's own database connection.
 *
 * Separate pool, separate database (`aspect_tasks_db`), deliberately NOT
 * services/db.pg. The isolation Shlomi asked for is physical: there is no
 * connection here that can see the platform DB, so no query against this pool
 * can reach LYBI's board however it is written.
 *
 * Host, port and credentials are shared with the platform DB because it is the
 * same Cloud SQL instance -- only the database name differs. That keeps one set
 * of credentials to rotate and one instance to back up, while still giving the
 * two boards no table in common.
 */
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const schema = require('./schema');

const DB_NAME = process.env.TASKS_DB_NAME || 'aspect_tasks_db';

let pool = null;
let db = null;

function config() {
  const isUnixSocket = process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/');
  const base = {
    database: DB_NAME,
    user: process.env.DB_USER || 'agent_admin',
    password: process.env.DB_PASSWORD,
    // Smaller than the platform pool on purpose: this board serves a handful of
    // people, and the instance's connection budget is shared with everything
    // else. Ten idle connections for a task list would be rude.
    max: parseInt(process.env.TASKS_DB_POOL_MAX || '4', 10),
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  if (isUnixSocket) return { ...base, host: process.env.DB_HOST };
  return {
    ...base,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
}

function getPool() {
  if (pool) return pool;
  pool = new Pool(config());

  // Without this a network drop or a Cloud SQL failover surfaces as an
  // unhandled 'error' event on an idle client, which takes the whole process
  // down. That exact crash has already happened once on the platform pool.
  pool.on('error', err => {
    console.error('[taskboard] idle client error (pool will recover):', err.message);
  });

  return pool;
}

/** Drizzle handle for `aspect_tasks_db`. Lazily built on first use. */
function getDb() {
  if (!db) db = drizzle(getPool(), { schema });
  return db;
}

/** Raw query escape hatch, for the few places a hand-written statement is clearer. */
function query(text, params) {
  return getPool().query(text, params);
}

/** Verifies the connection and that the schema is actually there. */
async function check() {
  const { rows } = await query(
    `SELECT current_database() AS db,
            (SELECT count(*)::int FROM information_schema.tables
              WHERE table_schema = 'public') AS tables`
  );
  return rows[0];
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

module.exports = { getDb, getPool, query, check, close, DB_NAME };
