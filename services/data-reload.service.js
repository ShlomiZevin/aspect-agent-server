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
          AND started_at < NOW() - INTERVAL '3 hours'
        RETURNING id, schema_name, triggered_by, started_at
      `);
      if (result.rows.length > 0) {
        for (const r of result.rows) {
          console.log(`[DataReloadService] Marked stale run #${r.id} (${r.schema_name}) as failed`);
          // Only drop shadow schema for import runs (index runs operate on live schema).
          // Skip drop if the run started within the last 30 minutes — it may have been
          // kicked off just before a deployment and could still be running on the old revision.
          if (r.triggered_by !== 'index') {
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
   * Import: scan GCS → create tables → COPY data → schema swap → completed.
   * Rejects with {code:409} if already running.
   * Returns runId immediately; import runs in background.
   */
  async startLoad(schemaName, triggeredBy = 'manual') {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 400, message: `No reloader registered for schema: ${schemaName}` };

    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      throw {
        code: 409,
        message: `Schema ${schemaName} is busy (status: running). Cannot start a new load.`,
      };
    }

    const runId = await this._createRunInDB(schemaName, triggeredBy);

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
  async startIndexing(schemaName, triggeredBy = 'index') {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 400, message: `No reloader registered for schema: ${schemaName}` };

    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      throw {
        code: 409,
        message: `Schema ${schemaName} is already running (phase: ${current.phase || 'unknown'}). Cannot start indexing.`,
      };
    }

    const runId = await this._createRunInDB(schemaName, triggeredBy);

    this.currentRuns[schemaName] = {
      id: runId,
      status: 'running',
      phase: 'indexing',
      step: 'indexing',
      triggeredBy,
      startedAt: new Date().toISOString(),
    };
    this.logBuffers[schemaName] = [];

    this._executeIndexing(runId, schemaName).catch(err => {
      console.error(`[DataReloadService] Unhandled indexing error for ${schemaName}:`, err.message);
    });

    return runId;
  }

  /**
   * Idempotent check called by Cloud Scheduler every 15 min.
   * Starts indexing only if:
   *   1. Nothing is currently running (in-memory or DB within last 3h)
   *   2. There is a completed cron import with no run started after it
   * Returns { action: 'started'|'skipped', reason?, runId? }
   */
  async ensureIndexed(schemaName) {
    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      return { action: 'skipped', reason: `${current.phase} already running in memory` };
    }

    const activeRes = await this.db.query(
      `SELECT id FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'running' AND started_at > NOW() - INTERVAL '3 hours'
       LIMIT 1`,
      [schemaName]
    );
    if (activeRes.rows.length > 0) {
      return { action: 'skipped', reason: `run #${activeRes.rows[0].id} still running in DB` };
    }

    const importRes = await this.db.query(
      `SELECT id, completed_at FROM public.data_reload_runs
       WHERE schema_name = $1 AND status = 'completed'
         AND triggered_by = 'cron' AND total_files IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
      [schemaName]
    );
    if (importRes.rows.length === 0) {
      return { action: 'skipped', reason: 'no completed cron import found' };
    }
    const lastImport = importRes.rows[0];

    const afterRes = await this.db.query(
      `SELECT id, status FROM public.data_reload_runs
       WHERE schema_name = $1 AND started_at > $2
       LIMIT 1`,
      [schemaName, lastImport.completed_at]
    );
    if (afterRes.rows.length > 0) {
      const r = afterRes.rows[0];
      return { action: 'skipped', reason: `run #${r.id} (${r.status}) already exists after last import` };
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

    const runId = await this._createRunInDB(schemaName, triggeredBy);

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
   * Returns data freshness info: last successful run + last data date.
   * lastDataDate comes from the reloader's dataInfoFn (schema-specific).
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
    let lastDataDate = null;
    if (reloader?.dataInfoFn) {
      try {
        lastDataDate = await reloader.dataInfoFn(this.db);
      } catch {
        // dataInfoFn is optional and best-effort
      }
    }

    return { lastRun, lastDataDate };
  }

  /** Returns GCS source files for this schema. */
  async getSourceFiles(schemaName) {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 404, message: `No reloader for schema: ${schemaName}` };
    return await gcsService.listCSVFiles(reloader.gcsFolderPrefix);
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
      const result = await reloader.loadFn(shadowSchema, emitLog);

      // Update in-memory stats
      if (this.currentRuns[schemaName]) {
        Object.assign(this.currentRuns[schemaName], {
          totalFiles: result.totalFiles,
          filesLoaded: result.filesLoaded,
          totalRows: result.totalRows,
          step: 'swapping',
        });
      }

      // ── Atomic schema swap ────────────────────────────────────────
      emitLog('swapping', `Swapping schemas: ${shadowSchema} → ${schemaName}`);

      // Terminate idle/idle-in-transaction connections that reference the live schema
      // so ALTER SCHEMA can acquire its lock without waiting indefinitely.
      await this.db.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state IN ('idle', 'idle in transaction', 'idle in transaction (aborted)')
          AND query ILIKE '%${schemaName}%'
      `).catch(() => {});

      const swapClient = await this.db.getClient();
      try {
        await swapClient.query('BEGIN');
        await swapClient.query(`DROP SCHEMA IF EXISTS ${schemaName}_old CASCADE`);
        // Only rename live schema if it exists (absent on first import or after accidental drop)
        await swapClient.query(`
          DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '${schemaName}') THEN
              EXECUTE 'ALTER SCHEMA ${schemaName} RENAME TO ${schemaName}_old';
            END IF;
          END $$
        `);
        await swapClient.query(`ALTER SCHEMA ${shadowSchema} RENAME TO ${schemaName}`);
        await swapClient.query('COMMIT');
      } catch (swapErr) {
        await swapClient.query('ROLLBACK').catch(() => {});
        throw swapErr;
      } finally {
        swapClient.release();
      }

      // ── Done ──────────────────────────────────────────────────────
      emitLog('completed', `Import complete: ${result.filesLoaded}/${result.totalFiles} files, ${(result.totalRows ?? 0).toLocaleString()} rows`);
      await this._finishRun(runId, schemaName, 'completed', result);

    } catch (err) {
      await this.db.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`).catch(() => {});
      emitLog('failed', `Import failed: ${err.message}`);
      await this._finishRun(runId, schemaName, 'failed', null, err.message);
    }
  }

  /**
   * Indexing executor: create indexes + views on the live schema.
   * No swap — schema is already live.
   * On error: do NOT drop live schema (data is still accessible).
   */
  async _executeIndexing(runId, schemaName) {
    const reloader = this.reloaders[schemaName];

    const emitLog = (step, message, data) => {
      this._emitLog(schemaName, step, message, data);
      if (this.currentRuns[schemaName]) {
        this.currentRuns[schemaName].step = step;
      }
    };

    try {
      await reloader.indexFn(schemaName, emitLog);

      // Drop old schema now that indexing is done (was kept for index DDL reference)
      await this.db.query(`DROP SCHEMA IF EXISTS ${schemaName}_old CASCADE`).catch(() => {});

      emitLog('completed', 'Indexing complete');
      await this._finishRun(runId, schemaName, 'completed', null);

    } catch (err) {
      emitLog('failed', `Indexing failed: ${err.message}`);
      await this._finishRun(runId, schemaName, 'failed', null, err.message);
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
      if (this.logBuffers[schemaName].length % 20 === 0) {
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

    await this.db.query(
      `UPDATE public.data_reload_runs
       SET status        = $1,
           completed_at  = NOW(),
           total_files   = $2,
           files_loaded  = $3,
           total_rows    = $4,
           log_entries   = $5::jsonb,
           error_message = $6,
           step          = $7
       WHERE id = $8`,
      [
        status,
        result?.totalFiles ?? null,
        result?.filesLoaded ?? 0,
        result?.totalRows ?? 0,
        JSON.stringify(logs),
        errorMessage,
        status,
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
