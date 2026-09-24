/**
 * Partner origins — extra websites allowed to call this server from a
 * browser, added at runtime by design partners who build their own chat
 * face on top of an agent.
 *
 * ── Why this can never break an existing site ─────────────────────
 *
 * The production CORS check in server.js runs its hardcoded allowlist
 * FIRST and unchanged. This module is consulted only for an origin that
 * list already rejects, and it can only answer "also allow" — never
 * "deny" something that was allowed. `has()` is synchronous, never
 * touches the database on the request path, and never throws: any
 * failure (DB not up yet, table unreachable, bad JSON) means "not a
 * partner", which is exactly today's behaviour.
 *
 * ── Storage ─────────────────────────────────────────────────────────
 *
 * One row in the generic `provider_config` table, key
 * `partner_cors_origins`, value a JSON array of origins. Written here
 * directly rather than through provider-config.service, whose key
 * whitelist drives the admin Settings screen — this list is not an admin
 * setting and should not appear there.
 *
 * Every Cloud Run instance keeps its own in-memory copy and refreshes it
 * in the background at most every REFRESH_MS, so an origin added on one
 * instance reaches the others within that window, with no restart.
 */

const { eq } = require('drizzle-orm');
const db = require('./db.pg');
const { providerConfig } = require('../db/schema');

const KEY = 'partner_cors_origins';
const REFRESH_MS = 30 * 1000;

let origins = new Set();
let loadedAt = 0;
let refreshing = null;

async function readFromDb() {
  const [row] = await db.getDrizzle()
    .select({ value: providerConfig.value })
    .from(providerConfig)
    .where(eq(providerConfig.key, KEY))
    .limit(1);
  const parsed = row && row.value ? JSON.parse(row.value) : [];
  return Array.isArray(parsed) ? parsed.filter(o => typeof o === 'string') : [];
}

async function writeToDb(list) {
  const value = JSON.stringify(list);
  await db.getDrizzle()
    .insert(providerConfig)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: providerConfig.key, set: { value, updatedAt: new Date() } });
}

/** Background refresh. Failures keep the last good copy. */
function refresh() {
  if (refreshing) return refreshing;
  refreshing = readFromDb()
    .then(list => { origins = new Set(list); loadedAt = Date.now(); })
    .catch(() => { /* DB not ready or unreachable — keep what we have */ })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * Is this origin a registered partner? Synchronous and never throws —
 * called from inside the CORS check on every cross-origin request.
 */
function has(origin) {
  try {
    if (Date.now() - loadedAt > REFRESH_MS) refresh();
    return origins.has(origin);
  } catch {
    return false;
  }
}

/**
 * Reduce whatever a partner typed to the exact string a browser sends as
 * `Origin`: scheme + host (+ port), lower-case, no path, no slash.
 * Returns null for anything that is not a usable web origin.
 */
function normalize(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
  return `${u.protocol}//${u.host}`.toLowerCase();
}

async function list() {
  const current = await readFromDb();
  origins = new Set(current);
  loadedAt = Date.now();
  return current;
}

/** Returns { origin, added } — `added` false when it was already there. */
async function add(origin) {
  const current = await readFromDb();
  if (current.includes(origin)) {
    origins = new Set(current);
    loadedAt = Date.now();
    return { origin, added: false };
  }
  const next = [...current, origin].sort();
  await writeToDb(next);
  origins = new Set(next);
  loadedAt = Date.now();
  return { origin, added: true };
}

/** Returns true when it was there and is now gone. */
async function remove(origin) {
  const current = await readFromDb();
  if (!current.includes(origin)) return false;
  const next = current.filter(o => o !== origin);
  await writeToDb(next);
  origins = new Set(next);
  loadedAt = Date.now();
  return true;
}

module.exports = { has, normalize, list, add, remove, refresh };
