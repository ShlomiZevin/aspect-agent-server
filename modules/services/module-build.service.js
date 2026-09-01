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
const registry = require('../registry');
const datasetRegistry = require('../../insights/datasets/registry');
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
/**
 * Modules this loop has anything to build.
 *
 * An APP module owns its own storage — its own database, for the task board —
 * so it has no binding, no renderInfra and nothing for a reload to rebuild.
 * Running it through here threw "module is ready but has no stored binding" on
 * the first line and marked a module that was working perfectly `degraded`, on
 * every single reload.
 *
 * Filtered once rather than guarded at each of the three call sites below, so a
 * fourth cannot reintroduce it, and by the registry's predicate rather than a
 * local kind test, so it cannot drift from what the other host paths believe.
 */
function withInfrastructure(live) {
  return live.filter(({ descriptor }) => registry.runsHooks(descriptor));
}

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

  live = withInfrastructure(live);
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
  const live = withInfrastructure(await moduleService.getLiveModules(datasetId).catch(() => []));
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


/**
 * Build a module's infrastructure DIRECTLY INTO THE LIVE SCHEMA, now.
 *
 * WHY THIS EXISTS ALONGSIDE THE NIGHTLY HOOK — the two are not alternatives:
 *
 * A module cannot own its tables independently of the reload. Measured, not
 * assumed: a materialized view placed in its OWN schema and reading the
 * dataset's tables binds to those tables by OID, not by name. After the
 * atomic swap it silently keeps serving the OLD data, and then
 * `DROP SCHEMA <ds>_old CASCADE` deletes the module's view outright. So the
 * views MUST be rebuilt inside the reload, into the shadow, to survive the
 * swap — that is buildModulesInShadow() above.
 *
 * But that alone would mean a module enabled at 10am produces nothing until
 * the next night's reload, which is not a product. This builds it now, into
 * the live schema, so the module is usable within minutes of being set up.
 * The nightly hook then re-creates the same views from the same binding when
 * the schema is replaced.
 *
 * Not cheap — it is the same scan the nightly does — so it is called at the
 * points where a human is deliberately setting the module up (end of a
 * successful init, or the admin's explicit "Build now"), never implicitly.
 */
async function buildModulesInLive(datasetId, moduleId, pool, emitLog = () => {}) {
  const log = (msg) => emitLog('creating_views', `[modules] ${msg}`);
  const entry = datasetRegistry.get(datasetId);
  if (!entry) return { built: [], failed: [], skipped: true, error: `unknown dataset ${datasetId}` };

  const live = withInfrastructure(await moduleService.getLiveModules(datasetId).catch(() => []));
  const targets = moduleId ? live.filter(x => x.descriptor.id === moduleId) : live;
  if (!targets.length) return { built: [], failed: [], skipped: true };

  const usePool = pool || entry.getPool();
  const built = [], failed = [];

  for (const { descriptor, row } of targets) {
    const started = Date.now();
    try {
      if (!row.binding) throw new Error('module is ready but has no stored binding');
      // Target and source are the SAME schema here: the live one already holds
      // the data. (During a reload they are both the shadow, for the same
      // reason. They differ only during init, where the scratch target is
      // empty.)
      const statements = descriptor.hooks.renderInfra(
        row.binding, { target: entry.schemaName, source: entry.schemaName }) || [];

      const client = await usePool.connect();
      try {
        await client.query('SET statement_timeout = 0');
        await client.query("SET lock_timeout = '2min'");
        for (const stmt of statements) await client.query(stmt);
      } finally {
        client.release();
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      log(`${descriptor.id}: built into live schema ${entry.schemaName} in ${secs}s`);
      built.push({ moduleId: descriptor.id, seconds: Number(secs) });
    } catch (err) {
      log(`${descriptor.id}: live build FAILED — ${err.message}`);
      failed.push({ moduleId: descriptor.id, error: err.message });
    }
  }
  return { built, failed, skipped: false };
}

module.exports = { buildModulesInShadow, buildModulesInLive, expectedViews };
