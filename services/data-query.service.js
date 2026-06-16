const { Pool } = require('pg');
const sqlGeneratorService = require('./sql-generator.service');
const slowQueryService = require('./slow-query.service');

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
    this.pool = pool || new Pool({
      host:     process.env.DB_HOST,
      port:     process.env.DB_PORT,
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 5
    });
  }

  /**
   * Query data by asking a natural language question.
   *
   * @param {string} question - Natural language question
   * @param {string} customerSchema - Customer schema name (e.g., 'zer4u')
   * @param {Object} options
   * @param {number} options.maxRows - Hard row cap applied after generation (default: 100)
   * @param {number} options.timeout - Statement timeout in ms (default: QUERY_TIMEOUT_MS)
   * @param {string} options.agentName - Schema-level agent identifier for slow-query logging (e.g., 'zer4u')
   * @param {string} options.llmAgentName - Canonical agent name for LLM usage logging (e.g., 'Zer4U' from agent config)
   * @param {string} options.conversationId - Conversation ID for usage logging
   * @param {number|string} options.userId - User ID for usage logging
   * @returns {Promise<Object>} { sql, data, rowCount, explanation, confidence, duration, columns }
   */
  async queryByQuestion(question, customerSchema, options = {}) {
    const {
      maxRows = 100,
      timeout = QUERY_TIMEOUT_MS,
      agentName = customerSchema,
      llmAgentName,
      conversationId,
      userId,
    } = options;

    console.log(`Data Query: question for schema "${customerSchema}": "${question}"`);

    const startTime = Date.now();
    // Up to 3 attempts: the LLM occasionally emits SQL that errors at execution
    // (ambiguous column, SUM on a TEXT column, a wrong column name). On a non-timeout
    // execution error we feed the exact DB error back to the generator so it fixes
    // that specific problem, then re-run. Only the FINAL outcome is logged, so a
    // question that succeeds on retry records no error.
    const MAX_ATTEMPTS = 3;
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
        });
        sql = generated.sql;
        explanation = generated.explanation;
        confidence = generated.confidence;
        // Safety guard: sql-generator validates too, but enforce here as the last line of defence
        this._validateSQL(sql);
        // Ensure the query can't return more rows than the caller allows
        sql = this._enforceLimit(sql, maxRows);
        console.log(`   [attempt ${attempt}] Generated SQL (confidence: ${confidence}): ${sql}`);
      } catch (error) {
        const duration = Date.now() - startTime;
        slowQueryService.logSlowQuery({
          agentName, schemaName: customerSchema, question, sql: '',
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

        return {
          sql, explanation, confidence,
          data: result.rows,
          rowCount: result.rows.length,
          duration,
          columns: result.fields?.map(f => f.name) || [],
        };

      } catch (error) {
        const duration = Date.now() - startTime;
        const isTimeout = error.message?.includes('canceling statement due to statement timeout')
          || error.message?.includes('Query read timeout')
          || error.code === '57014';

        // Retry on a fixable (non-timeout) error while attempts remain; timeouts get one
        // retry too (the model may rewrite to a materialized view), but no more.
        const canRetry = attempt < MAX_ATTEMPTS && (!isTimeout || attempt < 2);
        if (canRetry) {
          console.log(`   [attempt ${attempt}] SQL ${isTimeout ? 'timeout' : 'error'}, retrying: ${error.message}`);
          prevError = isTimeout ? `Query timed out after ${timeout}ms — rewrite it to be cheaper (use a materialized view, narrow the date range).` : error.message;
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
          message: isTimeout ? this._getTimeoutMessage() : error.message,
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
    const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'TRUNCATE', 'ALTER', 'CREATE'];
    const upper = sql.toUpperCase();
    for (const kw of forbidden) {
      if (upper.includes(kw)) throw new Error(`SQL contains forbidden keyword: ${kw}`);
    }
  }

  /** @private — guards getSampleData / getTableStats against injection via identifier args */
  _validateIdentifiers(schema, table) {
    if (!SCHEMA_RE.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
    if (!TABLE_RE.test(table))   throw new Error(`Invalid table name: ${table}`);
  }

  /** @private */
  _getTimeoutMessage() {
    return `The query took too long and was automatically stopped after ${QUERY_TIMEOUT_MS / 1000} seconds.\n\nIt has been logged in the Query Optimizer dashboard where an admin can analyze it and create the necessary database indexes to make similar queries much faster.\n\nIn the meantime, try asking a more specific question or narrowing the time range (e.g. "last week" instead of "last year").`;
  }

  async close() {
    await this.pool.end();
  }
}

const instance = new DataQueryService();
module.exports = instance;
module.exports.DataQueryService = DataQueryService;
