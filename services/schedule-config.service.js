/**
 * Data-loader schedule storage.
 *
 * Replaces one-Cloud-Scheduler-job-per-task-per-schema with a single row per
 * (schema, jobType) in the `provider_config` table (reusing its existing
 * key/value shape, not the ENV_FALLBACKS-gated API-key mechanism - schedule
 * entries have no sensible env-var fallback). One Cloud Scheduler job
 * ("data-loader-tick", every minute) reads all of these and dispatches -
 * see server.js POST /api/admin/scheduler/tick.
 */

const db = require('./db.pg');
const { providerConfig } = require('../db/schema');
const { eq } = require('drizzle-orm');

const SCHEMAS = ['zer4u', 'newdeli', 'thestock', 'hypertoy', 'zolstock', 'tevanaot'];
const JOB_TYPES = ['import', 'drive_sync'];

function keyFor(schemaName, jobType) {
  return `${schemaName}_${jobType}_schedule`;
}

function defaultEntry() {
  return { enabled: false, hour: 1, minute: 0 };
}

function parseEntry(raw) {
  if (!raw) return defaultEntry();
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      hour: Number.isInteger(parsed.hour) ? parsed.hour : 1,
      minute: Number.isInteger(parsed.minute) ? parsed.minute : 0,
    };
  } catch {
    return defaultEntry();
  }
}

async function getSchedule(schemaName, jobType) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(providerConfig).where(eq(providerConfig.key, keyFor(schemaName, jobType))).limit(1);
  return parseEntry(row?.value);
}

async function setSchedule(schemaName, jobType, entry) {
  const value = JSON.stringify({
    enabled: !!entry.enabled,
    hour: Math.max(0, Math.min(23, parseInt(entry.hour, 10) || 0)),
    minute: Math.max(0, Math.min(59, parseInt(entry.minute, 10) || 0)),
  });
  const drizzle = db.getDrizzle();
  await drizzle
    .insert(providerConfig)
    .values({ key: keyFor(schemaName, jobType), value })
    .onConflictDoUpdate({ target: providerConfig.key, set: { value, updatedAt: new Date() } });
  return parseEntry(value);
}

/** All (schema, jobType) schedule entries in one query - used by the tick dispatcher and the Settings reference tab. */
async function getAllSchedules() {
  const drizzle = db.getDrizzle();
  const rows = await drizzle.select().from(providerConfig);
  const byKey = new Map(rows.map(r => [r.key, r.value]));
  const result = [];
  for (const schemaName of SCHEMAS) {
    for (const jobType of JOB_TYPES) {
      result.push({ schemaName, jobType, ...parseEntry(byKey.get(keyFor(schemaName, jobType))) });
    }
  }
  return result;
}

module.exports = { getSchedule, setSchedule, getAllSchedules, SCHEMAS, JOB_TYPES };
