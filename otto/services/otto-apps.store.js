/**
 * Saved Otto screens.
 *
 * One JSON blob per dataset in the generic `provider_config` TABLE, written
 * with Drizzle — exactly what insights/services/intelligence-config.service.js
 * does, and for the same reason: the table is a generic key/value store, so a
 * new feature needs no migration and no table of its own while it is still
 * finding its shape.
 *
 * NOT services/provider-config.service.js. That service sits on the same table
 * but is the API-key manager: it validates every key against a fixed allowlist
 * and throws `Unknown config key` for anything else. Writing through it looked
 * right and failed at runtime the first time a screen was saved.
 *
 * Storage is the PLATFORM database, never a dataset schema: a dataset schema is
 * dropped and rebuilt on every import, and anything a user built would vanish
 * with it. That is the trap taskboard/README.md and the replenishment module
 * both call out.
 *
 * When screens become a real product surface they get their own table with
 * promoted columns for owner and visibility, the way intelligence_insights did.
 * The record shape here is deliberately close to that.
 */

const db = require('../../services/db.pg');
const { providerConfig } = require('../../db/schema');
const { eq } = require('drizzle-orm');

const KEY = datasetId => `otto_apps_${datasetId}`;
const MAX_APPS = 50;

async function readAll(datasetId) {
  try {
    const drizzle = db.getDrizzle();
    const [row] = await drizzle
      .select()
      .from(providerConfig)
      .where(eq(providerConfig.key, KEY(datasetId)))
      .limit(1);
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A malformed blob must not take the Apps list down with it — an empty
    // list is recoverable, a 500 on the surface that lists everything is not.
    return [];
  }
}

async function writeAll(datasetId, apps) {
  const drizzle = db.getDrizzle();
  const value = JSON.stringify(apps.slice(0, MAX_APPS));
  await drizzle
    .insert(providerConfig)
    .values({ key: KEY(datasetId), value })
    .onConflictDoUpdate({ target: providerConfig.key, set: { value, updatedAt: new Date() } });
}

/** Summaries for the Apps list — the HTML is heavy and nobody needs it there. */
async function list(datasetId) {
  const apps = await readAll(datasetId);
  return apps.map(({ html, ...rest }) => ({ ...rest, sizeKb: Math.round((html || '').length / 1024) }));
}

async function get(datasetId, appId) {
  const apps = await readAll(datasetId);
  return apps.find(a => a.id === appId) || null;
}

/**
 * Saving the same screen twice replaces it rather than adding a second copy —
 * the builder hands back the id it was given, so "save" after a revision means
 * the same screen, not a new one.
 */
async function save(datasetId, app) {
  const apps = await readAll(datasetId);
  const now = new Date().toISOString();
  const existing = app.id ? apps.findIndex(a => a.id === app.id) : -1;

  const record = {
    id: app.id || `app-${Date.now()}`,
    title: app.title,
    summary: app.summary || '',
    icon: app.icon || 'grid',
    plan: app.plan || null,
    html: app.html,
    createdBy: app.createdBy || 'demo',
    createdAt: existing >= 0 ? apps[existing].createdAt : now,
    updatedAt: now,
  };

  if (existing >= 0) apps[existing] = record;
  else apps.unshift(record);

  await writeAll(datasetId, apps);
  return record;
}

async function remove(datasetId, appId) {
  const apps = await readAll(datasetId);
  const next = apps.filter(a => a.id !== appId);
  if (next.length === apps.length) return false;
  await writeAll(datasetId, next);
  return true;
}

module.exports = { list, get, save, remove };
