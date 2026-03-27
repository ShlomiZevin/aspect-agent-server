/**
 * DataReloadService — Generic orchestration for schema reload operations.
 *
 * Provides:
 *   - Reloader registry (each schema registers its own reload function)
 *   - Shadow schema swap (zero downtime)
 *   - In-memory state tracking for active runs
 *   - SSE log streaming to dashboard subscribers
 *   - DB persistence of run history
 *
 * Usage:
 *   const service = new DataReloadService(db);
 *   service.registerReloader('zer4u', {
 *     reloadFn: require('./scripts/reload-zer4u-zero-downtime').reloadZer4u,
 *     gcsFolderPrefix: 'zer4u/',
 *   });
 */

const gcsService = require('./gcs.service');

class DataReloadService {
  constructor(db) {
    this.db = db;                // db.pg.js singleton (has .query() and .getClient())
    this.reloaders = {};         // { schemaName: { reloadFn, gcsFolderPrefix } }
    this.currentRuns = {};       // { schemaName: RunState }
    this.subscribers = {};       // { schemaName: Set<callback> }
    this.logBuffers = {};        // { schemaName: LogEntry[] } — in-memory during run
  }

  // ── Registry ────────────────────────────────────────────────────────────────

  registerReloader(schemaName, config) {
    // config: { reloadFn(targetSchema, emitLog) => Promise<result>, gcsFolderPrefix }
    this.reloaders[schemaName] = config;
    console.log(`[DataReloadService] Registered reloader for schema: ${schemaName}`);
  }

  /**
   * Mark any stale 'running' records as 'failed' on server startup.
   * If the server restarted mid-reload, those records would be stuck as 'running' forever.
   */
  async cleanupStaleRuns() {
    try {
      const result = await this.db.query(`
        UPDATE public.data_reload_runs
        SET status = 'failed',
            completed_at = NOW(),
            error_message = 'Server restarted during reload'
        WHERE status = 'running'
        RETURNING id, schema_name
      `);
      if (result.rows.length > 0) {
        result.rows.forEach(r => {
          console.log(`[DataReloadService] Marked stale run #${r.id} (${r.schema_name}) as failed`);
        });
      }
    } catch (err) {
      console.error('[DataReloadService] Failed to cleanup stale runs:', err.message);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Start a reload. Rejects with {code:409} if already running.
   * Returns runId immediately; reload runs in background.
   */
  async startReload(schemaName, triggeredBy = 'manual') {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 400, message: `No reloader registered for schema: ${schemaName}` };

    const current = this.currentRuns[schemaName];
    if (current && current.status === 'running') {
      throw { code: 409, message: `Reload already in progress for schema: ${schemaName}` };
    }

    const runId = await this._createRunInDB(schemaName, triggeredBy);

    this.currentRuns[schemaName] = {
      id: runId,
      status: 'running',
      step: 'starting',
      triggeredBy,
      startedAt: new Date().toISOString(),
      totalFiles: null,
      filesLoaded: 0,
      totalRows: 0,
    };
    this.logBuffers[schemaName] = [];

    // Fire and forget — result tracked via _finishRun
    this._executeReload(runId, schemaName).catch(err => {
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

  /** Returns last N runs from DB for a schema (without log_entries for list view). */
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

  /** Returns log_entries for a specific run (for "View Log" in history). */
  async getRunLogs(runId) {
    const result = await this.db.query(
      `SELECT log_entries FROM public.data_reload_runs WHERE id = $1`,
      [runId]
    );
    return result.rows[0]?.log_entries || [];
  }

  /** Returns GCS source files for this schema. */
  async getSourceFiles(schemaName) {
    const reloader = this.reloaders[schemaName];
    if (!reloader) throw { code: 404, message: `No reloader for schema: ${schemaName}` };
    return await gcsService.listCSVFiles(reloader.gcsFolderPrefix);
  }

  /**
   * Subscribe to live log events for a schema.
   * If a reload is running, replays the current log buffer then streams live.
   * Returns an unsubscribe function.
   */
  subscribeLogs(schemaName, callback) {
    if (!this.subscribers[schemaName]) this.subscribers[schemaName] = new Set();
    this.subscribers[schemaName].add(callback);

    // Replay buffered logs so new subscriber catches up
    const buffer = this.logBuffers[schemaName];
    if (buffer && buffer.length > 0) {
      buffer.forEach(entry => callback({ type: 'log', data: entry }));
    }

    // Send current run state
    const current = this.currentRuns[schemaName];
    if (current) {
      callback({ type: 'status', data: { status: current.status, step: current.step } });
    }

    return () => {
      this.subscribers[schemaName]?.delete(callback);
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  async _executeReload(runId, schemaName) {
    const reloader = this.reloaders[schemaName];
    const shadowSchema = `${schemaName}_new`;

    const emitLog = (step, message, data) => {
      this._emitLog(schemaName, step, message, data);
      // Update current step
      if (this.currentRuns[schemaName]) {
        this.currentRuns[schemaName].step = step;
      }
    };

    try {
      // ── Run client-specific reload into shadow schema ─────────────
      // Note: createSchema() inside reloadFn handles DROP+CREATE of the shadow schema
      const result = await reloader.reloadFn(shadowSchema, emitLog);

      // Update stats from reload result
      if (this.currentRuns[schemaName]) {
        Object.assign(this.currentRuns[schemaName], {
          totalFiles: result.totalFiles,
          filesLoaded: result.filesLoaded,
          totalRows: result.totalRows,
        });
      }

      // ── Atomic schema swap ───────────────────────────────────────
      emitLog('swapping', `Swapping schemas: ${shadowSchema} → ${schemaName}`);
      const client = await this.db.getClient();
      try {
        await client.query('BEGIN');
        await client.query(`DROP SCHEMA IF EXISTS ${schemaName}_old CASCADE`);
        await client.query(`ALTER SCHEMA ${schemaName} RENAME TO ${schemaName}_old`);
        await client.query(`ALTER SCHEMA ${shadowSchema} RENAME TO ${schemaName}`);
        await client.query('COMMIT');
      } catch (swapErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw swapErr;
      } finally {
        client.release();
      }

      // ── Cleanup old schema ───────────────────────────────────────
      emitLog('cleanup', `Dropping ${schemaName}_old...`);
      await this.db.query(`DROP SCHEMA IF EXISTS ${schemaName}_old CASCADE`);

      // ── Done ─────────────────────────────────────────────────────
      emitLog('completed', `Reload complete: ${result.filesLoaded}/${result.totalFiles} files, ${result.totalRows.toLocaleString()} rows`);
      await this._finishRun(runId, schemaName, 'completed', result);

    } catch (err) {
      // On any error: drop shadow schema, live schema is untouched
      await this.db.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`).catch(() => {});
      emitLog('failed', `Reload failed: ${err.message}`);
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

    // Buffer for replay + DB persistence
    if (this.logBuffers[schemaName]) {
      this.logBuffers[schemaName].push(entry);
    }

    // Push to SSE subscribers
    const subs = this.subscribers[schemaName];
    if (subs && subs.size > 0) {
      const logEvent = { type: 'log', data: entry };
      subs.forEach(cb => {
        try { cb(logEvent); } catch (e) { /* subscriber disconnected */ }
      });

      // Also push progress event if data has file progress
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

    // Update in-memory state
    if (this.currentRuns[schemaName]) {
      this.currentRuns[schemaName].status = status;
      this.currentRuns[schemaName].completedAt = new Date().toISOString();
    }

    // Notify subscribers of completion event, then clear them
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

    // Clear log buffer (saved to DB)
    delete this.logBuffers[schemaName];
  }
}

module.exports = DataReloadService;
