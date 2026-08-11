/**
 * Nightly regeneration of the shared "Suggested reports" set.
 *
 * WHY THIS EXISTS. The product tells users reports are "updated every night"
 * and to "check back after tonight's run" — but nothing ever called
 * bootstrap() except a manual admin POST, so on 2026-08-11 the database held
 * zero system-owned reports and every new visitor saw an empty feed forever.
 * The scheduling machinery was already there (one Cloud Scheduler job ticking
 * scheduler-tick.service.js every minute); insights simply were not wired into
 * it.
 *
 * SELF-CHECKING, NOT CLOCK-DRIVEN. This deliberately does not take a scheduled
 * hour. Reports must be regenerated AFTER that schema's data load finishes, or
 * they describe yesterday's data — the exact staleness the rest of the pipeline
 * exists to prevent. So it uses the same shape as ensureIndexed(): run every
 * tick, no-op unless "data is loaded AND today's set hasn't been built yet".
 *
 * Each run REPLACES the previous set rather than appending, so suggestions stay
 * a small current set instead of growing without bound.
 */

const registry = require('../datasets/registry');
const intelligenceConfigService = require('./intelligence-config.service');
const store = require('./insights-store.service');

/** Matches BOOTSTRAP_USER_ID in investigation.service.js — the owner of shared suggestions. */
const SYSTEM_USER = 'system';

/** Guards against a second tick starting a run while the first is still going (a full set takes minutes). */
const running = new Set();

function israelDayStamp(date = new Date()) {
  // "2026-08-11" in Israel time — the unit of "once a day" here.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * @returns {Promise<string[]>} dataset ids whose suggestions were regenerated on this call.
 */
async function ensureInsightsRefreshed({ log = console.log, force = false, onlyDataset = null } = {}) {
  const investigation = require('./investigation.service'); // lazy — avoids a require cycle
  const today = israelDayStamp();
  const done = [];

  const configs = await intelligenceConfigService.getAllConfigs();
  for (const config of configs) {
    if (!config.enabled) continue;
    if (onlyDataset && config.id !== onlyDataset) continue;
    if (running.has(config.id)) continue;

    const existing = await store.listByUser(config.id, SYSTEM_USER);
    // Already refreshed today? Nothing to do. `createdAt` is epoch ms on every
    // insight, so the day stamp of the newest one is the last run's date.
    if (!force && existing.length > 0) {
      const newest = Math.max(...existing.map(i => i.createdAt || 0));
      if (israelDayStamp(new Date(newest)) === today) continue;
    }

    running.add(config.id);
    try {
      log(`[insights-refresh] regenerating suggestions for ${config.id}`);
      const created = await investigation.bootstrap(config.id);
      if (created.length === 0) {
        log(`[insights-refresh] ${config.id}: produced nothing — keeping the previous set`);
        continue;
      }
      // Only drop the old set once the new one exists, so a failed run never
      // leaves users with no suggestions at all.
      const newIds = new Set(created.map(i => i.id));
      for (const old of existing) {
        if (!newIds.has(old.id)) await store.remove(config.id, SYSTEM_USER, old.id).catch(() => {});
      }
      log(`[insights-refresh] ${config.id}: ${created.length} suggestion(s), replaced ${existing.length}`);
      done.push(config.id);
    } catch (err) {
      log(`[insights-refresh] ${config.id} failed: ${err.message}`);
    } finally {
      running.delete(config.id);
    }
  }
  return done;
}

module.exports = { ensureInsightsRefreshed, SYSTEM_USER };
