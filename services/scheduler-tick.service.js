/**
 * The single "tick" dispatcher - called once a minute by the one Cloud
 * Scheduler job (data-loader-tick). Reads every schema's schedule from
 * schedule-config.service and fires the matching action when the current
 * Israel time falls inside that job's window.
 *
 * Both ensureLoaded and syncClient are safe to call repeatedly within a
 * window - ensureLoaded already no-ops if a run is in progress or already
 * completed today (see data-reload.service.js), so re-checking every minute
 * is just a cheap retry-until-it-works, not a duplicate-run risk.
 */

const scheduleConfig = require('./schedule-config.service');
const insightsRefresh = require('../insights/services/insights-refresh.service');
const mvRefresh = require('../insights/services/mv-refresh.service');

const IMPORT_WINDOW_MINUTES = 5 * 60; // retry every tick for up to 5h, mirrors the old ensure-loaded sweep
const DRIVE_SYNC_WINDOW_MINUTES = 15; // a few retries, then stop - sync failures are rarer/cheaper to just re-trigger manually

function getIsraelTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return { hour, minute };
}

/** True if `now` (hour/minute) falls within `windowMinutes` after `start` (hour/minute), wrapping past midnight. */
function isWithinWindow(now, start, windowMinutes) {
  const nowTotal = now.hour * 60 + now.minute;
  const startTotal = start.hour * 60 + start.minute;
  const diff = ((nowTotal - startTotal) % 1440 + 1440) % 1440;
  return diff < windowMinutes;
}

/**
 * @param {Object} deps
 * @param {import('./data-reload.service')} deps.dataReloadService
 * @param {typeof import('./drive-to-gcs.service')} deps.driveToGcs
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<Object>} what fired, for the response/logs
 */
async function runTick({ dataReloadService, driveToGcs, log = console.log }) {
  const now = getIsraelTime();
  const schedules = await scheduleConfig.getAllSchedules();
  const fired = [];

  for (const entry of schedules) {
    if (!entry.enabled) continue;
    const start = { hour: entry.hour, minute: entry.minute };

    if (entry.jobType === 'import' && isWithinWindow(now, start, IMPORT_WINDOW_MINUTES)) {
      fired.push(`${entry.schemaName}:import`);
      // Awaited (not fire-and-forget): ensureLoaded's own busy-check only
      // becomes true once its DB row is actually committed. Firing every
      // schema's check in parallel let them all read "nobody running yet"
      // before any of them had written that row - on 2026-08-25/26 this let
      // zer4u/hypertoy/zolstock all start indexing in the same tick, exactly
      // the pile-up _otherSchemaBusy exists to prevent. Awaiting here makes
      // each schema's start-or-skip decision land before the next one checks.
      await dataReloadService.ensureLoaded(entry.schemaName).catch(err =>
        log(`[tick] ${entry.schemaName} ensureLoaded error: ${err.message}`));
    }

    if (entry.jobType === 'drive_sync' && isWithinWindow(now, start, DRIVE_SYNC_WINDOW_MINUTES)) {
      fired.push(`${entry.schemaName}:drive_sync`);
      driveToGcs.syncClient(entry.schemaName).catch(err =>
        log(`[tick] ${entry.schemaName} drive-sync error: ${err.message}`));
    }
  }

  // Indexing always self-checks for "import done, not yet indexed" - no
  // schedule needed, every schema, every tick (cheap no-op when there's
  // nothing to do).
  //
  // Awaited sequentially, same reasoning as the import branch above: this
  // loop is what actually raced on 2026-08-25/26 (zer4u/hypertoy/zolstock
  // cron-index all started within 4ms of each other, all reading "no other
  // schema busy" before any of them had written its own running row). One
  // schema's ensureIndexed() only resolves after its start/skip decision -
  // including the DB insert if it started - is committed, so awaiting here
  // closes the race instead of firing all schemas' checks in parallel.
  for (const schemaName of scheduleConfig.SCHEMAS) {
    if (!dataReloadService.reloaders[schemaName]) continue;
    await dataReloadService.ensureIndexed(schemaName).catch(err =>
      log(`[tick] ${schemaName} ensureIndexed error: ${err.message}`));
  }

  // Materialized views, refreshed when they fall behind their source.
  //
  // DELIBERATELY OFF BY DEFAULT (MV_REFRESH_ENABLED). A plain REFRESH takes
  // ACCESS EXCLUSIVE and blocks every read of that view for its whole
  // duration, and none of zolstock's four views has the UNIQUE index that
  // CONCURRENTLY requires — so on that client this is a full-outage rebuild
  // of an 868 MB view whose cost has not been measured yet. Enabling a job
  // like that by default, on every tenant at once, is how a correctness fix
  // turns into an availability incident.
  //
  // It also refuses to run while an import window is open for that schema:
  // rebuilding a view from a table that is actively being written is both
  // wasted work (the result is stale on arrival) and load applied at exactly
  // the moment the database has least to spare.
  if (process.env.MV_REFRESH_ENABLED === 'true') {
    const importing = new Set(
      schedules
        .filter(e => e.enabled && e.jobType === 'import' && isWithinWindow(now, { hour: e.hour, minute: e.minute }, IMPORT_WINDOW_MINUTES))
        .map(e => e.schemaName)
    );
    for (const schemaName of scheduleConfig.SCHEMAS) {
      if (importing.has(schemaName)) continue;
      try {
        const r = await mvRefresh.ensureMVsRefreshed(schemaName, { log });
        if (r.action === 'refreshed') fired.push(`${schemaName}:mv_refresh`);
      } catch (err) {
        log(`[tick] ${schemaName} mv-refresh error: ${err.message}`);
      }
    }
  }

  // Suggested reports, regenerated once a day PER SCHEMA — the same
  // self-checking shape as ensureIndexed above rather than a clock-based job,
  // and for the same reason: it must run AFTER that schema's data load, not at
  // a fixed hour. A report built before the load lands describes yesterday's
  // data, which is precisely the staleness the whole pipeline exists to avoid.
  // ensureInsightsRefreshed() no-ops unless the data is loaded and today's set
  // hasn't been generated yet, so re-checking every minute is a cheap
  // retry-until-it-works, not a duplicate-run risk.
  const refreshed = await insightsRefresh.ensureInsightsRefreshed({ log }).catch(err => {
    log(`[tick] insights refresh error: ${err.message}`);
    return [];
  });
  for (const id of refreshed) fired.push(`${id}:insights_refresh`);

  return { time: `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`, fired };
}

module.exports = { runTick, isWithinWindow, getIsraelTime };
