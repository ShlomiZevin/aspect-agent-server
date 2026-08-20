const { Pool } = require('pg');
const sqlGeneratorService = require('./sql-generator.service');
const slowQueryService = require('./slow-query.service');
const emptyResultDiagnosis = require('./empty-result-diagnosis.service');
const periodCoverage = require('./period-coverage.service');
const dataThrough = require('./data-through.service');

const QUERY_TIMEOUT_MS = parseInt(process.env.QUERY_TIMEOUT_MS || '15000');
const SCHEMA_RE = /^[a-z0-9_]+$/i;
const TABLE_RE  = /^[a-z0-9_]+$/i;

/**
 * Data Query Service
 *
 * Generic service for querying customer data schemas.
 * Handles the full flow: question → SQL → results.
 *
 * Accepts an optional pool in the constructor so zer4u (and future schemas
 * on dedicated databases) can use their own connection without affecting others.
 */
class DataQueryService {
  constructor(pool = null) {
    if (pool) {
      this.pool = pool;
    } else {
      this.pool = new Pool({
        host:     process.env.DB_HOST,
        port:     process.env.DB_PORT,
        database: process.env.DB_NAME,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: 5
      });
      this.pool.on('error', (err) => {
        console.error('[data-query.service] Unexpected pool error:', err.message);
      });
    }
  }

  /**
   * Query data by asking a natural language question.
   *
   * @param {string} question - Natural language question
   * @param {string} customerSchema - Customer schema name (e.g., 'zer4u')
   * @param {Object} options
   * @param {number} options.maxRows - Safety-valve row cap applied only when the generated SQL
   *   has no LIMIT of its own (default: 20000). This is not a business limit — callers should not
   *   need to pass a low value just to keep chat replies short; that's the crew's job when it
   *   decides how much of `data` to write out in prose. The full `data` array (up to this cap)
   *   always flows through to the data_table viewer/Excel export, so that surface never truncates
   *   in practice.
   * @param {number} options.timeout - Statement timeout in ms (default: QUERY_TIMEOUT_MS)
   * @param {string} options.agentName - Schema-level agent identifier for slow-query logging (e.g., 'zer4u')
   * @param {string} options.llmAgentName - Canonical agent name for LLM usage logging (e.g., 'Zer4U' from agent config)
   * @param {string} options.conversationId - Conversation ID for usage logging
   * @param {number|string} options.userId - User ID for usage logging
   * @returns {Promise<Object>} { sql, data, rowCount, explanation, confidence, duration, columns }
   */
  async queryByQuestion(question, customerSchema, options = {}) {
    const {
      maxRows = 1000000,
      timeout = QUERY_TIMEOUT_MS,
      agentName = customerSchema,
      llmAgentName,
      conversationId,
      userId,
    } = options;

    console.log(`Data Query: question for schema "${customerSchema}": "${question}"`);

    // Anchor relative expressions to the data, not the wall clock. Insights
    // has always passed this; chat never did, so "the last 7 days" asked in
    // chat searched a week that the export does not contain and came back
    // empty. Resolved here rather than in each agent's crew file so every
    // client — including the next one added — gets it without a code change.
    let dataThroughDate = options.dataThroughDate;
    if (!dataThroughDate) {
      dataThroughDate = await dataThrough.resolveDataThrough(this.pool, customerSchema).catch(() => null);
    }

    const startTime = Date.now();
    // Up to 3 attempts: the LLM occasionally emits SQL that errors at execution
    // (ambiguous column, SUM on a TEXT column, a wrong column name). On a non-timeout
    // execution error we feed the exact DB error back to the generator so it fixes
    // that specific problem, then re-run. Only the FINAL outcome is logged, so a
    // question that succeeds on retry records no error.
    const MAX_ATTEMPTS = 3;
    const BUDGET_MULTIPLIER = 2.5; // total query-phase wall clock, as a multiple of one timeout
    let prevError = null, prevSql = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let sql, explanation, confidence;

      // Step 1: Generate SQL — no DB connection held during the LLM call
      try {
        const generated = await sqlGeneratorService.generateSQL(question, customerSchema, {
          agentName: llmAgentName || agentName,
          conversationId,
          userId,
          previousError: attempt > 1 ? prevError : undefined,
          previousSql: attempt > 1 ? prevSql : undefined,
          // The date the data actually ends, so relative windows anchor to it
          // instead of CURRENT_DATE — see _buildDataRecencySection.
          dataThroughDate,
        });
        sql = generated.sql;
        explanation = generated.explanation;
        confidence = generated.confidence;
        // Log the raw SQL BEFORE validation — otherwise a validation rejection
        // (e.g. the forbidden-keyword guard) leaves no trace of what was
        // actually generated, in either the console or the slow-query DB row,
        // making false positives there un-debuggable after the fact.
        console.log(`   [attempt ${attempt}] Generated SQL (confidence: ${confidence}): ${sql}`);
        // Safety guard: sql-generator validates too, but enforce here as the last line of defence
        this._validateSQL(sql);
        // Ensure the query can't return more rows than the caller allows
        sql = this._enforceLimit(sql, maxRows);
      } catch (error) {
        const duration = Date.now() - startTime;
        // Real bug found 2026-08-07 via scripts/test-insights-battery.js: a
        // GENERATION-step failure (most commonly the LLM's own JSON response
        // being malformed — e.g. "Bad escaped character in JSON" from an
        // unescaped backslash inside the "sql" string it wrote) used to
        // return here immediately with ZERO retries, despite MAX_ATTEMPTS=3
        // existing right here in this same loop and already being used for
        // the EXECUTION-step error a few lines below. One JSON hiccup was
        // killing the whole investigation outright even though attempts
        // remained. Now retries the same way execution errors already do,
        // reusing the identical previousError/previousSql self-correction
        // channel sql-generator.service.js already reads — just fed a
        // parse-failure message instead of a Postgres error message.
        const canRetry = attempt < MAX_ATTEMPTS;
        if (canRetry) {
          console.log(`   [attempt ${attempt}] SQL generation failed, retrying: ${error.message}`);
          prevError = `Your previous response could not be parsed as valid JSON: ${error.message}. Common cause: a literal backslash inside the "sql" string (e.g. a regex or LIKE pattern) written as \\d instead of \\\\d, or a raw line break instead of \\n. Re-check escaping and return valid JSON this time.`;
          prevSql = null; // no valid SQL was produced — nothing real to show back
          continue;
        }
        slowQueryService.logSlowQuery({
          agentName, schemaName: customerSchema, question, sql: sql ?? '',
          durationMs: duration, queryType: 'error', errorMessage: error.message,
        }).catch(() => {});
        return { error: true, timeout: false, message: error.message, sql: null, explanation: null, confidence: null, data: [], rowCount: 0 };
      }

      // Step 2: Execute — connection acquired only now
      const client = await this.pool.connect();
      try {
        await client.query(`SET statement_timeout = ${timeout}`);
        const result = await client.query(sql);
        const duration = Date.now() - startTime;

        console.log(`   Query done in ${duration}ms, ${result.rows.length} rows (attempt ${attempt})`);

        if (duration > slowQueryService.threshold) {
          slowQueryService.logSlowQuery({
            agentName, schemaName: customerSchema, question, sql,
            durationMs: duration, rowsReturned: result.rows.length, queryType: 'slow',
          }).catch(() => {});
        }

        // Zero rows is ambiguous — a genuine "none" and an unsatisfiable
        // predicate look identical to the caller. Probe for the second case
        // so the answer can say which one it is. Only runs on empty results,
        // so it costs nothing on the normal path.
        let emptyReason = null;
        if (result.rows.length === 0) {
          emptyReason = await emptyResultDiagnosis
            .diagnoseEmptyResult(this.pool, sql, { schemaHint: customerSchema })
            .catch(() => null);
          if (emptyReason) console.log(`   Empty result explained: ${emptyReason.relation}."${emptyReason.column}" is all-NULL`);
        }

        // Structural, not prose: an answer whose newest period is four days
        // long must say so in both surfaces, and a model cannot forget a field.
        const coverage = periodCoverage.computeCoverage({ dataThroughDate, sql, rows: result.rows });

        return {
          sql, explanation, confidence,
          data: result.rows,
          rowCount: result.rows.length,
          duration,
          columns: result.fields?.map(f => f.name) || [],
          emptyReason,
          dataThroughDate: dataThroughDate || null,
          coverage,
        };

      } catch (error) {
        const duration = Date.now() - startTime;
        const isTimeout = error.message?.includes('canceling statement due to statement timeout')
          || error.message?.includes('Query read timeout')
          || error.code === '57014';

        // Retry on a fixable (non-timeout) error while attempts remain; timeouts get one
        // retry too (the model may rewrite to a materialized view), but no more.
        // A timeout retry is only worth taking if there is time left to take it.
        // Two full 75s timeouts plus generation overhead is ~3 minutes of dead
        // wall-clock for a question that is expensive for structural reasons —
        // the budget stops that at the point it stops being a retry and starts
        // being a second failure.
        const budgetLeft = (Date.now() - startTime) + timeout <= timeout * BUDGET_MULTIPLIER;
        const canRetry = attempt < MAX_ATTEMPTS && (!isTimeout || (attempt < 2 && budgetLeft));
        if (canRetry) {
          console.log(`   [attempt ${attempt}] SQL ${isTimeout ? 'timeout' : 'error'}, retrying: ${error.message}`);
          prevError = isTimeout ? await this._timeoutHint(customerSchema, timeout) : error.message;
          prevSql = sql;
          continue;
        }

        slowQueryService.logSlowQuery({
          agentName, schemaName: customerSchema, question, sql: sql ?? '',
          durationMs: duration, queryType: isTimeout ? 'timeout' : 'error',
          errorMessage: error.message,
        }).catch(() => {});

        return {
          error: true, timeout: isTimeout,
          // Report the timeout THIS query actually ran under, not the module
          // default — Insights passes 75s, so a message saying "stopped after
          // 15 seconds" sent anyone debugging it looking in the wrong place.
          message: isTimeout ? this._getTimeoutMessage(timeout) : error.message,
          sql, explanation, confidence, data: [], rowCount: 0,
        };

      } finally {
        await client.query('RESET statement_timeout').catch(() => {});
        client.release();
      }
    }
  }

  /**
   * Execute a pre-generated SQL query directly (admin use only).
   *
   * @param {string} sql - The SQL query to execute
   * @param {Object} options
   * @returns {Promise<Object>} { data, rowCount, columns, duration }
   */
  async executeSQL(sql, options = {}) {
    const { timeout = 30000 } = options;

    this._validateSQL(sql);

    const client = await this.pool.connect();
    try {
      await client.query(`SET statement_timeout = ${timeout}`);
      const startTime = Date.now();
      const result = await client.query(sql);
      const duration = Date.now() - startTime;

      console.log(`   executeSQL done in ${duration}ms, ${result.rows.length} rows`);
      return {
        data: result.rows,
        rowCount: result.rows.length,
        columns: result.fields?.map(f => f.name) || [],
        duration,
      };
    } catch (error) {
      console.error('SQL execution failed:', error.message);
      throw error;
    } finally {
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
  }

  /**
   * Get sample data from a table.
   * @param {string} customerSchema
   * @param {string} tableName
   * @param {number} limit
   */
  async getSampleData(customerSchema, tableName, limit = 10) {
    this._validateIdentifiers(customerSchema, tableName);
    return this.executeSQL(`SELECT * FROM ${customerSchema}.${tableName} LIMIT ${parseInt(limit)}`);
  }

  /**
   * Get row count, column count, and 5-row sample for a table.
   * @param {string} customerSchema
   * @param {string} tableName
   */
  async getTableStats(customerSchema, tableName) {
    this._validateIdentifiers(customerSchema, tableName);

    // Use pool.query() (not a single client) so the three queries run truly in parallel,
    // each on its own connection automatically acquired and released by the pool.
    const [countResult, colResult, sampleResult] = await Promise.all([
      this.pool.query(`SELECT COUNT(*) AS count FROM ${customerSchema}.${tableName}`),
      this.pool.query(
        `SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [customerSchema, tableName]
      ),
      this.pool.query(`SELECT * FROM ${customerSchema}.${tableName} LIMIT 5`),
    ]);

    return {
      rowCount:    parseInt(countResult.rows[0].count),
      columnCount: parseInt(colResult.rows[0].count),
      sampleData:  sampleResult.rows,
    };
  }

  /** @private — injected at the end of generated SQL when no LIMIT is present */
  _enforceLimit(sql, maxRows) {
    if (/\bLIMIT\b/i.test(sql)) return sql;
    const clean = sql.trimEnd().replace(/;+$/, '');
    return `${clean}\nLIMIT ${maxRows}`;
  }

  /** @private — rejects any SQL that contains DDL/DML keywords */
  _validateSQL(sql) {
    // Word-boundary match, not a raw substring check — `upper.includes('CREATE')`
    // used to false-positive on any query selecting a `created_at` column
    // (contains "CREATE"), `updated_at` (contains "UPDATE"), or an alias like
    // `dropoff_rate`/`drop_pct` (contains "DROP"), rejecting perfectly valid
    // SELECTs. \b anchors require an actual word-break around the keyword, so
    // real DDL/DML ("CREATE TABLE", "DROP INDEX") still matches.
    const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'TRUNCATE', 'ALTER', 'CREATE'];
    const upper = sql.toUpperCase();
    for (const kw of forbidden) {
      if (new RegExp(`\\b${kw}\\b`).test(upper)) throw new Error(`SQL contains forbidden keyword: ${kw}`);
    }
  }

  /** @private — guards getSampleData / getTableStats against injection via identifier args */
  _validateIdentifiers(schema, table) {
    if (!SCHEMA_RE.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
    if (!TABLE_RE.test(table))   throw new Error(`Invalid table name: ${table}`);
  }

  /** @private */
  /**
   * A timeout is not a fixable-error retry: the shape is expensive for
   * structural reasons, so "try again" without telling the model what is
   * cheaper just buys the same timeout twice. The schema's real
   * pre-aggregated views are read live from pg_matviews rather than named in
   * a per-client string — every dataset gets whatever it actually has, and a
   * schema with no views gets honest advice instead of a phantom table name.
   */
  async _timeoutHint(customerSchema, timeout) {
    let views = [];
    try {
      const { rows } = await this.pool.query(
        'SELECT matviewname FROM pg_matviews WHERE schemaname = $1 ORDER BY matviewname',
        [customerSchema]
      );
      views = rows.map(r => `${customerSchema}.${r.matviewname}`);
    } catch { /* the hint is best-effort; a failed lookup must not mask the timeout */ }

    const base = `Query timed out after ${timeout}ms. Do NOT re-send the same shape — it will time out again. Rewrite it to read less data.`;
    return views.length
      ? `${base} This schema has pre-aggregated materialized views that are far cheaper than the raw fact table: ${views.join(', ')}. Use the one whose grain matches the question. If none matches the grain, aggregate from the closest coarser view rather than the fact table, or narrow the date range.`
      : `${base} There are no pre-aggregated views in this schema, so narrow the date range, reduce the number of grouping columns, or drop joins that are not needed for the answer.`;
  }

  _getTimeoutMessage(timeoutMs = QUERY_TIMEOUT_MS) {
    return `The query took too long and was automatically stopped after ${Math.round(timeoutMs / 1000)} seconds.\n\nIt has been logged in the Query Optimizer dashboard where an admin can analyze it and create the necessary database indexes to make similar queries much faster.\n\nIn the meantime, try asking a more specific question or narrowing the time range (e.g. "last week" instead of "last year").`;
  }

  async close() {
    await this.pool.end();
  }
}

const instance = new DataQueryService();
module.exports = instance;
module.exports.DataQueryService = DataQueryService;
