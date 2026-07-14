/**
 * DataReloadService — Generic orchestration for schema reload operations.
 *
 * Two independent operations:
 *   startLoad()     → import CSVs into shadow schema → atomic schema swap → status='completed'
 *   startIndexing() → create indexes on live schema (independent, any time after import)
 *
 * Index runs are tracked separately (triggered_by='index') so the UI can show
 * last import and last index as independent operations.
 */

const gcsService = require('./gcs.service');
const providerConfigService = require('./provider-config.service');
const { getGcsFolder } = require('./gcs-folder.service');

class DataReloadService {
  constructor(db) {
    this.db = db;
    this.reloaders = {};
    this.currentRuns = {};
    this.subscribers = {};
    this.logBuffers = {};
  }

  // ── Registry ────────────────────────────────────────────────────────────────

  registerReloader(schemaName, config) {
    this.reloaders[schemaName] = config;
    console.log(`[DataReloadService] Registered reloader for schema: ${schemaName}`);
  }

  /**
   * Start periodic cleanup — every 30 minutes, mark runs stuck > 3h as failed.
   * Call once after server startup (complements the one-time startup cleanup).
   */
  startPeriodicCleanup() {
    const INTERVAL_MS = 30 * 60 * 1000;
    setInterval(() => {
      this.cleanupStaleRuns().catch(err =>
        console.error('[DataReloadService] Periodic cleanup error:', err.message)
      );
    }, INTERVAL_MS);
  }

  /**
   * Mark any stale 'running' records as 'failed' on server startup.
   * For import runs: also drop the shadow schema.
   * For index runs: no cleanup needed (live schema is still intact).
   */
  async cleanupStaleRuns() {
    try {
      // Only mark as failed if the run is old enough that it couldn't still be
      // running on another Cloud Run instance. Cloud Run can spin up a second
      // instance while an import is in progress; without this guard the new
      // instance would immediately kill the live run in the DB.
      // Max import time is ~2 hours, so 3 hours is a safe threshold.
      const result = await this.db.query(`
        UPDATE public.data_reload_runs
        SET status        = 'failed',
            completed_at  = NOW(),
            error_message = 'Server restarted during reload'
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '5 hours'
        RETURNING id, schema_name, triggered_by, started_at
      `);
      if (result.rows.length > 0) {
        for (const r of result.rows) {
          console.log(`[DataReloadService] Marked stale run #${r.id} (${r.schema_name}) as failed`);
          // Only drop shadow schema for import runs (index runs operate on live schema).
          // Skip drop if the run started within the last 30 minutes — it may have been
          // kicked off just before a deployment and could still be running on the old revision.
          if (!r.triggered_by.includes('index')) {
            const ageMinutes = (Date.now() - new Date(r.started_at).getTime()) / 60000;
            const shadowSchema = `${r.schema_name}_new`;
            console.log(`[DataReloadService] Dropping leftover shadow schema ${shadowSchema}...`);
            this.db.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`).then(() => {
              console.log(`[DataReloadService] Dropped ${shadowSchema}`);
            }).catch(e => {
              console.error(`[DataReloadService] Failed to drop ${shadowSchema}:`, e.message);
            });
          }
        }
      }
    } catch (err) {
      console.error('[DataReloadService] Failed to cleanup stale runs:', err.message);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Throws 409 if any operation is currently running for this schema.
   * Checks both in-memory state (fast path) and DB (survives server restarts).
   */
  async _assertNotBusy(schemaName) {
    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      throw { code: 409, message: `Schema ${schemaName} already has a running ${current.phase || 'operation'} in memory.` };
    }
    const activeRes = await this.db.query(
      `SELECT id, triggered_by FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'running'
       LIMIT 1`,
      [schemaName]
    );
    if (activeRes.rows.length > 0) {
      const r = activeRes.rows[0];
      throw { code: 409, message: `Schema ${schemaName} already has a running operation in DB (run #${r.id}, by ${r.triggered_by}).` };
    }
  }

  /**
   * Import: scan GCS → create tables → COPY data → schema swap → completed.
   * Rejects with {code:409} if already running (checks memory + DB).
   * Returns runId immediately; import runs in background.
   */
  async startLoad(schemaName, triggeredBy = 'manual') {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 400, message: `No reloader registered for schema: ${schemaName}` };

    await this._assertNotBusy(schemaName);

    const runId = await this._createRunInDB(schemaName, `${triggeredBy}-import`);

    this.currentRuns[schemaName] = {
      id: runId,
      status: 'running',
      phase: 'import',
      step: 'starting',
      triggeredBy,
      startedAt: new Date().toISOString(),
      totalFiles: null,
      filesLoaded: 0,
      totalRows: 0,
    };
    this.logBuffers[schemaName] = [];

    this._executeLoad(runId, schemaName).catch(err => {
      console.error(`[DataReloadService] Unhandled load error for ${schemaName}:`, err.message);
    });

    return runId;
  }

  /**
   * Indexing: create indexes + views on the live schema (independent of import).
   * Can be called at any time as long as no other operation is running.
   * Creates its own run record (triggered_by='index').
   * Returns runId immediately; indexing runs in background.
   */
  async startIndexing(schemaName, triggeredBy = 'manual', options = {}) {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 400, message: `No reloader registered for schema: ${schemaName}` };

    await this._assertNotBusy(schemaName);

    const { force = false } = options;
    const runType = force ? 'full-index' : 'index';
    const runId = await this._createRunInDB(schemaName, `${triggeredBy}-${runType}`);

    this.currentRuns[schemaName] = {
      id: runId,
      status: 'running',
      phase: 'indexing',
      step: 'indexing',
      triggeredBy,
      startedAt: new Date().toISOString(),
    };
    this.logBuffers[schemaName] = [];

    this._executeIndexing(runId, schemaName, options).catch(err => {
      console.error(`[DataReloadService] Unhandled indexing error for ${schemaName}:`, err.message);
    });

    return runId;
  }

  /**
   * Idempotent check called by Cloud Scheduler at 07:00, 08:00, 09:00, 10:00, 11:00.
   * Starts import only if:
   *   1. Nothing is currently running
   *   2. No completed import exists today (since midnight UTC)
   * This enables automatic retry: if 07:00 run fails, 08:00 will retry, etc.
   * Returns { action: 'started'|'skipped', reason?, runId? }
   */
  async ensureLoaded(schemaName) {
    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      return { action: 'skipped', reason: `${current.phase} already running in memory` };
    }

    const activeRes = await this.db.query(
      `SELECT id FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'running' AND started_at > NOW() - INTERVAL '5 hours'
       LIMIT 1`,
      [schemaName]
    );
    if (activeRes.rows.length > 0) {
      return { action: 'skipped', reason: `run #${activeRes.rows[0].id} still running in DB` };
    }

    const completedTodayRes = await this.db.query(
      `SELECT id FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'completed'
         AND total_files IS NOT NULL
         AND started_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
       LIMIT 1`,
      [schemaName]
    );
    if (completedTodayRes.rows.length > 0) {
      return { action: 'skipped', reason: `import already completed today (run #${completedTodayRes.rows[0].id})` };
    }

    const runId = await this.startLoad(schemaName, 'cron');
    console.log(`[DataReloadService] ensure-loaded: started run #${runId} for ${schemaName}`);
    return { action: 'started', runId };
  }

  /**
   * Idempotent check called by Cloud Scheduler every 15 min.
   * Starts indexing only if:
   *   1. Nothing is currently running (in-memory or DB within last 3h)
   *   2. There is a completed cron import with no run started after it
   * Returns { action: 'started'|'skipped', reason?, runId? }
   */
  async ensureIndexed(schemaName) {
    // Self-heal first: if a previous index run built the shadow but its worker
    // died before swapping, just complete the swap (don't rebuild everything).
    const healed = await this.ensureSwapped(schemaName);
    if (healed.action === 'swapped') {
      return { action: 'started', runId: healed.runId, selfHeal: true };
    }

    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      return { action: 'skipped', reason: `${current.phase} already running in memory` };
    }

    const activeRes = await this.db.query(
      `SELECT id FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'running' AND started_at > NOW() - INTERVAL '5 hours'
       LIMIT 1`,
      [schemaName]
    );
    if (activeRes.rows.length > 0) {
      return { action: 'skipped', reason: `run #${activeRes.rows[0].id} still running in DB` };
    }

    const importRes = await this.db.query(
      `SELECT id, completed_at FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'completed'
         AND total_files IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
      [schemaName]
    );
    if (importRes.rows.length === 0) {
      return { action: 'skipped', reason: 'no completed import found' };
    }
    const lastImport = importRes.rows[0];

    const completedIndexRes = await this.db.query(
      `SELECT id FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'completed'
         AND (triggered_by LIKE '%-index' OR triggered_by LIKE '%-full-index' OR triggered_by IN ('index', 'cron')) AND started_at > $2
       LIMIT 1`,
      [schemaName, lastImport.completed_at]
    );
    if (completedIndexRes.rows.length > 0) {
      return { action: 'skipped', reason: `indexing already completed after last import (run #${completedIndexRes.rows[0].id})` };
    }

    const runId = await this.startIndexing(schemaName, 'cron');
    console.log(`[DataReloadService] ensure-indexed: started run #${runId} for ${schemaName} after import #${lastImport.id}`);
    return { action: 'started', runId, afterImport: lastImport.id };
  }

  /**
   * Full reload: import + swap + indexing, chained automatically.
   * Used by nightly cron / Cloud Scheduler via POST /reload.
   * Returns importRunId immediately; both phases run in background.
   */
  async startReload(schemaName, triggeredBy = 'manual') {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 400, message: `No reloader registered for schema: ${schemaName}` };

    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      throw {
        code: 409,
        message: `Schema ${schemaName} is already running. Cannot start reload.`,
      };
    }

    const runId = await this._createRunInDB(schemaName, `${triggeredBy}-import`);

    this.currentRuns[schemaName] = {
      id: runId,
      status: 'running',
      phase: 'import',
      step: 'starting',
      triggeredBy,
      startedAt: new Date().toISOString(),
      totalFiles: null,
      filesLoaded: 0,
      totalRows: 0,
    };
    this.logBuffers[schemaName] = [];

    // Chain: import (with swap) → then indexing automatically
    this._executeLoad(runId, schemaName)
      .then(async () => {
        const state = this.currentRuns[schemaName];
        if (state && state.status === 'completed' && state.id === runId) {
          // Import done — start independent index run
          await this.startIndexing(schemaName, triggeredBy);
        }
      })
      .catch(err => {
        console.error(`[DataReloadService] Unhandled reload error for ${schemaName}:`, err.message);
      });

    return runId;
  }

  /** Returns current run state (if running) or last run from DB. */
  async getStatus(schemaName) {
    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      return { ...current, isLive: true };
    }

    const result = await this.db.query(
      `SELECT * FROM public.data_reload_runs
       WHERE schema_name = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [schemaName]
    );
    return result.rows[0] || null;
  }

  /** Returns last N runs from DB for a schema. */
  async getHistory(schemaName, limit = 20) {
    const result = await this.db.query(
      `SELECT id, schema_name, status, triggered_by, step,
              started_at, completed_at,
              total_files, files_loaded, total_rows,
              error_message, error_step
       FROM public.data_reload_runs
       WHERE schema_name = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [schemaName, limit]
    );
    return result.rows;
  }

  /** Returns log_entries for a specific run. */
  async getRunLogs(runId) {
    const result = await this.db.query(
      `SELECT log_entries FROM public.data_reload_runs WHERE id = $1`,
      [runId]
    );
    return result.rows[0]?.log_entries || [];
  }

  /**
   * Returns data freshness info: last successful run + data coverage window.
   * lastDataDate comes from the reloader's dataInfoFn (schema-specific).
   * firstDataDate (and a consistent lastDataDate) come from the optional
   * dataRangeFn when a reloader provides one — it returns { first, last } so the
   * UI can show how far back the data reaches, not just how recent it is.
   */
  async getDataInfo(schemaName) {
    const runResult = await this.db.query(
      `SELECT id, status, triggered_by, started_at, completed_at, total_rows
       FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`,
      [schemaName]
    );
    const lastRun = runResult.rows[0] || null;

    const reloader = this.reloaders[schemaName];
    let firstDataDate = null;
    let lastDataDate = null;

    if (reloader?.dataRangeFn) {
      try {
        const range = await reloader.dataRangeFn(reloader.pool || this.db);
        firstDataDate = range?.first || null;
        lastDataDate = range?.last || null;
      } catch {
        // dataRangeFn is optional and best-effort
      }
    }

    // Fall back to dataInfoFn for the end date when no range fn is available.
    if (lastDataDate == null && reloader?.dataInfoFn) {
      try {
        lastDataDate = await reloader.dataInfoFn(reloader.pool || this.db);
      } catch {
        // dataInfoFn is optional and best-effort
      }
    }

    return { lastRun, firstDataDate, lastDataDate };
  }

  /** Returns GCS source files for this schema. */
  async getSourceFiles(schemaName) {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 404, message: `No reloader for schema: ${schemaName}` };
    const folder = await getGcsFolder(schemaName, reloader.gcsFolderPrefix);
    return await gcsService.listCSVFiles(folder);
  }

  /**
   * Subscribe to live log events for a schema.
   * Replays current log buffer then streams live.
   * Returns an unsubscribe function.
   */
  subscribeLogs(schemaName, callback) {
    if (!this.subscribers[schemaName]) this.subscribers[schemaName] = new Set();
    this.subscribers[schemaName].add(callback);

    const buffer = this.logBuffers[schemaName];
    if (buffer && buffer.length > 0) {
      buffer.forEach(entry => callback({ type: 'log', data: entry }));
    }

    const current = this.currentRuns[schemaName];
    if (current) {
      callback({ type: 'status', data: { status: current.status, step: current.step, phase: current.phase } });
    }

    return () => {
      this.subscribers[schemaName]?.delete(callback);
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  /**
   * Import executor: load data into shadow schema, then swap atomically into live.
   * On success: status='completed' directly (no 'loaded' intermediate state).
   */
  async _executeLoad(runId, schemaName) {
    const reloader = this.reloaders[schemaName];
    const shadowSchema = `${schemaName}_new`;

    const emitLog = (step, message, data) => {
      this._emitLog(schemaName, step, message, data);
      if (this.currentRuns[schemaName]) {
        this.currentRuns[schemaName].step = step;
      }
    };

    try {
      // Resolve the import window (trailing months of fact data to load; 0 = all).
      // DB override > env (ZER4U_IMPORT_MONTHS) > 0. The reloader decides how to apply it.
      let importMonths = 0;
      try {
        const raw = await providerConfigService.get(`${schemaName}_import_months`);
        importMonths = raw != null ? (parseInt(raw, 10) || 0) : 0;
      } catch (e) {
        console.warn(`[DataReloadService] Could not resolve import window for ${schemaName}: ${e.message}`);
      }

      const result = await reloader.loadFn(shadowSchema, emitLog, { importMonths });

      // Update in-memory stats
      if (this.currentRuns[schemaName]) {
        Object.assign(this.currentRuns[schemaName], {
          totalFiles: result.totalFiles,
          filesLoaded: result.filesLoaded,
          totalRows: result.totalRows,
          step: 'completed',
        });
      }

      // ── Done — swap happens after indexing ────────────────────────
      emitLog('completed', `Import complete: ${result.filesLoaded}/${result.totalFiles} files, ${(result.totalRows ?? 0).toLocaleString()} rows.`);
      await this._finishRun(runId, schemaName, 'completed', result);

    } catch (err) {
      await this.db.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`).catch(() => {});
      emitLog('failed', `Import failed: ${err.message}`);
      await this._finishRun(runId, schemaName, 'failed', null, err.message);
    }
  }

  /**
   * Indexing executor.
   * If a shadow schema ({schemaName}_new) exists (post-import case):
   *   - index the shadow using the live schema as DDL reference
   *   - atomically swap shadow → live after indexing
   *   - drop the old live schema
   * Otherwise (manual re-index):
   *   - index the live schema directly (no swap needed)
   */
  async _executeIndexing(runId, schemaName, options = {}) {
    const reloader = this.reloaders[schemaName];
    const shadowSchema = `${schemaName}_new`;

    const emitLog = (step, message, data) => {
      this._emitLog(schemaName, step, message, data);
      if (this.currentRuns[schemaName]) {
        this.currentRuns[schemaName].step = step;
      }
    };

    try {
      // Determine whether we have a freshly-loaded shadow schema to index+swap,
      // or whether we're re-indexing the live schema directly.
      const dbForCheck = reloader.pool || this.db;
      const shadowExists = (await dbForCheck.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [shadowSchema]
      )).rowCount > 0;

      if (shadowExists) {
        // If the shadow is ALREADY fully built (MVs present and all populated,
        // which the index phase finishes right before the swap), a prior worker
        // most likely died at the ~instant swap. Re-running indexFn would redo
        // 15+ min of DROP+CREATE MV work AND risk the same mid-swap kill. So when
        // already built, skip the rebuild and just complete the swap.
        const built = await this._isShadowBuilt(schemaName, shadowSchema, dbForCheck);

        if (built) {
          emitLog('swapping', `Shadow ${shadowSchema} already built — skipping rebuild, completing swap only...`);
        } else {
          // Post-import: index shadow, then swap
          emitLog('creating_indexes', `Indexing shadow schema ${shadowSchema} (reference: ${schemaName})...`);
          await reloader.indexFn(shadowSchema, emitLog, schemaName, options);
        }

        // ── Atomic schema swap (hardened; shared with self-heal) ──
        const swapPool = reloader.pool || this.db;
        await this._swapSchemas(schemaName, shadowSchema, swapPool, emitLog);
      } else {
        // Manual re-index: index live schema directly
        emitLog('creating_indexes', `Re-indexing live schema ${schemaName}...`);
        await reloader.indexFn(schemaName, emitLog);
      }

      emitLog('completed', 'Indexing complete');
      await this._finishRun(runId, schemaName, 'completed', null);

    } catch (err) {
      emitLog('failed', `Indexing failed: ${err.message}`);
      await this._finishRun(runId, schemaName, 'failed', null, err.message);
    }
  }

  /**
   * Complete the atomic schema swap: shadowSchema → schemaName, keeping the old
   * as schemaName_old then dropping it. Hardened against lock blockers / hangs:
   * statement_timeout=0 + lock_timeout, terminate other backends on the
   * (dedicated) DB before each attempt, retry up to 3x. Shared by the index
   * pipeline and by ensureSwapped (self-heal).
   */
  async _swapSchemas(schemaName, shadowSchema, swapPool, emitLog) {
    emitLog('swapping', `Swapping schemas: ${shadowSchema} → ${schemaName}...`);
    const swapClient = await swapPool.connect();
    try {
      await swapClient.query('SET statement_timeout = 0');
      await swapClient.query("SET lock_timeout = '45s'");

      const MAX_SWAP_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
        try {
          // Release blockers: kill every other backend on this DB. On the
          // dedicated zer4u DB these are agent-query / pool connections that
          // will simply reconnect on their next query.
          await swapClient.query(`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
          `).catch(() => {});

          await swapClient.query('BEGIN');
          await swapClient.query(`DROP SCHEMA IF EXISTS ${schemaName}_old CASCADE`);
          await swapClient.query(`
            DO $$ BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '${schemaName}') THEN
                EXECUTE 'ALTER SCHEMA ${schemaName} RENAME TO ${schemaName}_old';
              END IF;
            END $$
          `);
          await swapClient.query(`ALTER SCHEMA ${shadowSchema} RENAME TO ${schemaName}`);
          await swapClient.query('COMMIT');
          emitLog('swapping', `Schema swap complete: ${schemaName} is now live${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          break;
        } catch (swapErr) {
          await swapClient.query('ROLLBACK').catch(() => {});
          if (attempt === MAX_SWAP_ATTEMPTS) throw swapErr;
          emitLog('swapping', `Swap attempt ${attempt}/${MAX_SWAP_ATTEMPTS} failed (${swapErr.message}); retrying...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    } finally {
      swapClient.release();
    }

    await swapPool.query(`DROP SCHEMA IF EXISTS ${schemaName}_old CASCADE`).catch(() => {});

    // Regenerate schema description cache in background — read schema + store cache in zer4u DB
    const schemaDescriptorService = require('./schema-descriptor.service');
    schemaDescriptorService.getDescription(schemaName, true, swapPool, swapPool)
      .then(() => emitLog('swapping', `Schema description cache updated`))
      .catch(err => console.warn(`⚠️  Schema description regen failed: ${err.message}`));
  }

  /**
   * Is the freshly-loaded shadow schema fully built and ready for the atomic swap?
   *
   * MV-based schemas (zer4u/thestock/newdeli/zolstock): "built" = the shadow's
   * materialized views are all present and populated — the index/MV phase does
   * this right before the swap. Unchanged from the original check.
   *
   * Index-only schemas (e.g. hypertoy, ~2M rows, plain indexes and no MVs): there
   * are no MVs to look for, so "built" = every valid index on the live schema also
   * exists and is valid on the shadow. Without this branch the MV check is always
   * false for such schemas, so self-heal never completes their swap and every
   * import needs a manual "Create Indexes" re-run.
   *
   * Conservative: requires shadow ⊇ live valid indexes, so it can only delay an
   * auto-swap, never swap an unfinished shadow. A freshly-imported shadow with no
   * indexes is correctly NOT "built".
   */
  async _isShadowBuilt(liveSchema, shadowSchema, pool) {
    const res = await pool.query(
      `WITH live_mv AS (
         SELECT count(*) AS n FROM pg_matviews WHERE schemaname = $1
       ),
       shadow_mv AS (
         SELECT count(*) AS n FROM pg_matviews WHERE schemaname = $2
       ),
       shadow_mv_unpop AS (
         SELECT count(*) AS n FROM pg_matviews WHERE schemaname = $2 AND ispopulated = false
       ),
       live_idx AS (
         SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_index   i ON i.indexrelid = c.oid
          WHERE n.nspname = $1 AND i.indisvalid AND i.indisready
       ),
       shadow_idx AS (
         SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_index   i ON i.indexrelid = c.oid
          WHERE n.nspname = $2 AND i.indisvalid AND i.indisready
       )
       SELECT CASE
         WHEN (SELECT n FROM live_mv) > 0 THEN
           (SELECT n FROM shadow_mv) > 0 AND (SELECT n FROM shadow_mv_unpop) = 0
         ELSE
           (SELECT count(*) FROM live_idx) > 0
           AND NOT EXISTS (
             SELECT 1 FROM live_idx l
              WHERE l.relname NOT IN (SELECT relname FROM shadow_idx)
           )
       END AS built`,
      [liveSchema, shadowSchema]
    );
    return res.rows[0].built;
  }

  /**
   * Periodic self-heal sweep. The indexing worker can be killed by the platform
   * right after the MVs finish but before the swap runs (the swap is the very
   * last step). This timer calls ensureSwapped for every registered schema, so a
   * built-but-unswapped shadow gets swapped automatically within one interval —
   * no manual "Create Indexes" re-run needed. ensureSwapped is a cheap no-op when
   * there is nothing to swap or a build is running on this instance.
   */
  startSelfHealLoop(intervalMs = 60000) {
    if (this._selfHealTimer) return;
    this._selfHealTimer = setInterval(async () => {
      for (const schemaName of Object.keys(this.reloaders)) {
        try {
          const r = await this.ensureSwapped(schemaName);
          if (r.action === 'swapped') {
            console.log(`[DataReloadService] self-heal sweep: swapped ${schemaName} (run #${r.runId})`);
          }
        } catch {
          // never let the sweep throw
        }
      }
    }, intervalMs);
    if (this._selfHealTimer.unref) this._selfHealTimer.unref();
    console.log(`[DataReloadService] self-heal sweep started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  /**
   * Self-heal: if a fully-built shadow schema (indexed + materialized views)
   * exists but was never swapped — e.g. the platform killed the background
   * worker right at the swap step — complete the swap automatically.
   *
   * Safe for the periodic/cron path: it only acts once the shadow's marker MV
   * (mv_sales_by_month) exists, which proves the index+MV phase finished and
   * only the ~instant rename remains. Skips if a build is running on THIS
   * instance. Returns { action: 'swapped'|'skipped'|'failed', ... }.
   */
  async ensureSwapped(schemaName) {
    const reloader = this.reloaders[schemaName];
    if (!reloader) return { action: 'skipped', reason: 'no reloader' };

    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      return { action: 'skipped', reason: `${current.phase || 'operation'} running on this instance` };
    }

    const pool = reloader.pool || this.db;
    const shadow = `${schemaName}_new`;
    let hasShadow;
    try {
      hasShadow = (await pool.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [shadow]
      )).rowCount > 0;
    } catch (e) {
      return { action: 'skipped', reason: `check failed: ${e.message}` };
    }
    if (!hasShadow) return { action: 'skipped', reason: 'no shadow schema' };

    let built;
    try {
      built = await this._isShadowBuilt(schemaName, shadow, pool);
    } catch (e) {
      return { action: 'skipped', reason: `built check failed: ${e.message}` };
    }
    if (!built) return { action: 'skipped', reason: 'shadow not fully built yet' };

    // The index run that built this shadow but stalled at the swap is the most
    // recent 'running' run. Re-use its id and finish it as 'completed' — its work
    // (index + MVs) really did succeed; only the ~instant rename was left. This
    // keeps the history clean (one Completed run, not a Failed + a separate one).
    const stalledRes = await this.db.query(
      `SELECT id FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [schemaName]
    );
    const runId = stalledRes.rows[0]?.id ?? await this._createRunInDB(schemaName, 'self-heal-swap');

    this.currentRuns[schemaName] = {
      id: runId, status: 'running', phase: 'swapping', step: 'swapping',
      triggeredBy: 'self-heal', startedAt: new Date().toISOString(),
    };
    this.logBuffers[schemaName] = [];
    const emitLog = (step, message, data) => {
      this._emitLog(schemaName, step, message, data);
      if (this.currentRuns[schemaName]) this.currentRuns[schemaName].step = step;
    };

    try {
      emitLog('swapping', `Self-heal: shadow ${shadow} is built but unswapped — finishing swap...`);
      await this._swapSchemas(schemaName, shadow, pool, emitLog);
      emitLog('completed', 'Indexing complete (swap finished by self-heal)');
      await this._finishRun(runId, schemaName, 'completed', null);
      // Clean up any other stale 'running' rows for this schema.
      await this.db.query(
        `UPDATE public.data_reload_runs
         SET status = 'failed', completed_at = NOW(), error_message = 'Superseded by self-heal swap'
         WHERE schema_name = $1 AND status = 'running' AND id <> $2`,
        [schemaName, runId]
      ).catch(() => {});
      console.log(`[DataReloadService] self-heal: swapped ${shadow} → ${schemaName} (run #${runId})`);
      return { action: 'swapped', runId };
    } catch (err) {
      emitLog('failed', `Self-heal swap failed: ${err.message}`);
      await this._finishRun(runId, schemaName, 'failed', null, err.message);
      return { action: 'failed', error: err.message };
    }
  }

  _emitLog(schemaName, step, message, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: step === 'failed' ? 'error' : 'info',
      step,
      message,
      ...(data ? { data } : {}),
    };

    const progressOnly = data?.progressOnly === true;

    if (!progressOnly && this.logBuffers[schemaName]) {
      this.logBuffers[schemaName].push(entry);
      const len = this.logBuffers[schemaName].length;
      if (len === 1 || len % 5 === 0) {
        const runId = this.currentRuns[schemaName]?.id;
        if (runId) {
          const logs = this.logBuffers[schemaName];
          this.db.query(
            `UPDATE public.data_reload_runs SET log_entries = $1::jsonb WHERE id = $2`,
            [JSON.stringify(logs), runId]
          ).catch(() => {});
        }
      }
    }

    const subs = this.subscribers[schemaName];
    if (subs && subs.size > 0) {
      if (!progressOnly) {
        const logEvent = { type: 'log', data: entry };
        subs.forEach(cb => {
          try { cb(logEvent); } catch (e) { /* subscriber disconnected */ }
        });
      }

      if (data && (data.filesCompleted !== undefined || data.totalFiles !== undefined)) {
        const current = this.currentRuns[schemaName] || {};
        const progressEvent = {
          type: 'progress',
          data: {
            step,
            filesCompleted: data.filesCompleted ?? current.filesLoaded ?? 0,
            totalFiles: data.totalFiles ?? current.totalFiles ?? 0,
            currentFile: data.file,
            currentFileRows: data.rowsLoaded,
            totalRows: current.totalRows ?? 0,
          },
        };
        subs.forEach(cb => {
          try { cb(progressEvent); } catch (e) { /* subscriber disconnected */ }
        });
      }
    }

    console.log(`[DataReload:${schemaName}] [${step}] ${message}`);
  }

  async _createRunInDB(schemaName, triggeredBy) {
    const result = await this.db.query(
      `INSERT INTO public.data_reload_runs (schema_name, triggered_by, status)
       VALUES ($1, $2, 'running')
       RETURNING id`,
      [schemaName, triggeredBy]
    );
    return result.rows[0].id;
  }

  async _finishRun(runId, schemaName, status, result, errorMessage = null) {
    const logs = this.logBuffers[schemaName] || [];
    const qualityStats = result?.qualityReport ?? null;

    await this.db.query(
      `UPDATE public.data_reload_runs
       SET status        = $1,
           completed_at  = NOW(),
           total_files   = $2,
           files_loaded  = $3,
           total_rows    = $4,
           log_entries   = $5::jsonb,
           error_message = $6,
           step          = $7,
           quality_stats = $8::jsonb
       WHERE id = $9`,
      [
        status,
        result?.totalFiles ?? null,
        result?.filesLoaded ?? 0,
        result?.totalRows ?? 0,
        JSON.stringify(logs),
        errorMessage,
        status,
        qualityStats ? JSON.stringify(qualityStats) : null,
        runId,
      ]
    );

    // On successful reload, persist the last data date into agents.data_updated_at
    // so that agent crews can surface it to users without an extra query at runtime.
    if (status === 'completed') {
      const reloader = this.reloaders[schemaName];
      if (reloader?.dataInfoFn) {
        try {
          const dataDate = await reloader.dataInfoFn(this.db);
          if (dataDate) {
            await this.db.query(
              `UPDATE agents SET data_updated_at = $1 WHERE url_slug = $2`,
              [dataDate, schemaName]
            );
            console.log(`[DataReloadService] Updated agents.data_updated_at for ${schemaName}: ${dataDate}`);
          }
        } catch (err) {
          console.warn(`[DataReloadService] Failed to update agents.data_updated_at for ${schemaName}:`, err.message);
        }
      }
    }

    if (this.currentRuns[schemaName]) {
      this.currentRuns[schemaName].status = status;
      this.currentRuns[schemaName].completedAt = new Date().toISOString();
    }

    const subs = this.subscribers[schemaName];
    if (subs && subs.size > 0) {
      const completionEvent = {
        type: status === 'completed' ? 'complete' : 'error',
        data: {
          status,
          totalFiles: result?.totalFiles,
          filesLoaded: result?.filesLoaded,
          totalRows: result?.totalRows,
          errorMessage,
        },
      };
      subs.forEach(cb => {
        try { cb(completionEvent); } catch (e) { /* subscriber disconnected */ }
      });
      subs.clear();
    }

    delete this.logBuffers[schemaName];
  }
}

module.exports = DataReloadService;
