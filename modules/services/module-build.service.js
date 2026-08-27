/**
 * Aspect Modules — the nightly build hook.
 *
 * Called from the reload pipeline's phase 2, after the dataset's own indexes
 * and materialized views are built into the SHADOW schema and BEFORE the
 * atomic swap. Each live module re-renders its infrastructure from its stored
 * binding, so the module's views arrive with the swap rather than being built
 * against a live schema afterwards.
 *
 * Target and source are both the shadow schema here — it holds a full freshly
 * loaded copy of the data, which is exactly why the views can be built into
 * it and swapped in as one unit.
 *
 * ── TWO PROPERTIES THIS MUST HAVE ──
 *
 * 1. A MODULE MUST NEVER FAIL THE RELOAD. The reload is the platform's most
 *    important scheduled job and every dataset depends on it; an optional
 *    module breaking it would be a catastrophic trade. A failed module build
 *    marks that module `degraded`, emits `nightly_build_failed`, and lets the
 *    swap proceed. The module keeps serving its LAST GOOD build until the
 *    next successful reload clears the state — stale-but-correct beats gone.
 *    This is the same log-and-surface philosophy as reload-freshness.
 *
 * 2. NO MODULE ⇒ NOTHING HAPPENS. A schema with no enabled+ready module
 *    returns immediately, having issued no query and touched nothing. That is
 *    the byte-identical guarantee (plan guardrail #8) at the one point where
 *    the framework reaches into a path every dataset already uses.
 */

const moduleService = require('./module.service');
const notificationService = require('../notification.service');

/**
 * Build every live module's infrastructure into the shadow schema.
 *
 * @param {string} datasetId   the dataset/schema id (they are the same value)
 * @param {string} shadowSchema  where to build — holds the fresh data copy
 * @param {object} pool        the dataset's pg pool
 * @param {function} emitLog   the reload's own logger (step, message)
 * @returns {{built: object[], failed: object[], skipped: boolean}}
 */
async function buildModulesInShadow(datasetId, shadowSchema, pool, emitLog = () => {}) {
  const log = (msg) => emitLog('creating_views', `[modules] ${msg}`);

  let live;
  try {
    live = await moduleService.getLiveModules(datasetId);
  } catch (err) {
    // Even the LOOKUP must not break a reload. If the platform DB is
    // unreachable mid-reload, the dataset's own build is unaffected and must
    // continue.
    log(`could not read module state (${err.message}) — skipping module builds`);
    return { built: [], failed: [], skipped: true, error: err.message };
  }

  if (!live.length) return { built: [], failed: [], skipped: true };

  log(`${live.length} live module(s) to build into ${shadowSchema}`);
  const built = [];
  const failed = [];

  for (const { descriptor, row } of live) {
    const started = Date.now();
    try {
      if (!row.binding) throw new Error('module is ready but has no stored binding');

      const statements = descriptor.hooks.renderInfra(
        row.binding, { target: shadowSchema, source: shadowSchema }) || [];

      const client = await pool.connect();
      try {
        // Long MV builds are legitimate; waiting forever on someone else's
        // lock is not — that was the shape of the zer4u crash loop.
        await client.query('SET statement_timeout = 0');
        await client.query("SET lock_timeout = '2min'");
        for (const stmt of statements) await client.query(stmt);
      } finally {
        client.release();
      }

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      log(`${descriptor.id}: built ${statements.length} statement(s) in ${secs}s`);
      built.push({ moduleId: descriptor.id, statements: statements.length, seconds: Number(secs) });

      // Recovering from a previous bad night is part of the contract: a
      // module left `degraded` goes back to `ready` once it builds cleanly.
      if (row.status === 'degraded') {
        await moduleService.setStatus(datasetId, descriptor.id, 'ready', 'nightly-build');
        log(`${descriptor.id}: recovered from degraded`);
      }
    } catch (err) {
      // Property 1: degrade the module, never the reload.
      log(`${descriptor.id}: BUILD FAILED — ${err.message} (module degraded, reload continues)`);
      failed.push({ moduleId: descriptor.id, error: err.message });

      await moduleService.setStatus(datasetId, descriptor.id, 'degraded', 'nightly-build')
        .catch(e => log(`${descriptor.id}: could not mark degraded: ${e.message}`));

      await notificationService.emit({
        datasetId,
        moduleId: descriptor.id,
        event: 'nightly_build_failed',
        payload: { shadowSchema, error: err.message },
      });
    }
  }

  return { built, failed, skipped: false };
}

/**
 * Which views each live module expects to exist after a swap — handed to the
 * freshness assertion so a module view that silently failed to arrive is
 * surfaced rather than discovered by a client.
 */
async function expectedViews(datasetId) {
  const live = await moduleService.getLiveModules(datasetId).catch(() => []);
  const out = [];
  for (const { descriptor, row } of live) {
    if (!row.binding || typeof descriptor.hooks.renderInfra !== 'function') continue;
    try {
      const statements = descriptor.hooks.renderInfra(row.binding, { target: 'x', source: 'x' }) || [];
      for (const s of statements) {
        const m = /CREATE MATERIALIZED VIEW\s+x\.(\w+)/i.exec(s);
        if (m) out.push({ moduleId: descriptor.id, view: m[1] });
      }
    } catch { /* a module that cannot render is already degraded elsewhere */ }
  }
  return out;
}

module.exports = { buildModulesInShadow, expectedViews };
