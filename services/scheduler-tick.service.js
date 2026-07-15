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
      dataReloadService.ensureLoaded(entry.schemaName).catch(err =>
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
  for (const schemaName of scheduleConfig.SCHEMAS) {
    if (!dataReloadService.reloaders[schemaName]) continue;
    dataReloadService.ensureIndexed(schemaName).catch(err =>
      log(`[tick] ${schemaName} ensureIndexed error: ${err.message}`));
  }

  return { time: `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`, fired };
}

module.exports = { runTick, isWithinWindow, getIsraelTime };
