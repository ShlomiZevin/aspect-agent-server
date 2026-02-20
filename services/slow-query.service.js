const { Pool } = require('pg');

const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '5000');

/**
 * Slow Query Service
 *
 * Logs queries that exceed the threshold and provides analysis
 * using EXPLAIN + Claude-powered index recommendations.
 */
class SlowQueryService {
  constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 5,
    });
  }

  get threshold() {
    return SLOW_QUERY_THRESHOLD_MS;
  }

  /**
   * Log a query entry — slow, error, or timeout.
   * Called by data-query.service. Never throws (fire-and-forget safe).
   *
   * @param {Object} opts
   * @param {string} opts.agentName       - e.g. 'aspect'
   * @param {string} opts.schemaName      - e.g. 'zer4u'
   * @param {string} opts.question        - original user question
   * @param {string} opts.sql             - generated SQL (may be null on early errors)
   * @param {number} opts.durationMs      - how long it ran before completing/failing
   * @param {number} [opts.rowsReturned]  - rows returned (slow queries only)
   * @param {'slow'|'error'|'timeout'} [opts.queryType='slow'] - entry type
   * @param {string} [opts.errorMessage]  - error text (error/timeout entries)
   */
  async logSlowQuery({ agentName, schemaName, question, sql, durationMs, rowsReturned, queryType = 'slow', errorMessage }) {
    try {
      const result = await this.pool.query(
        `INSERT INTO public.slow_queries
           (agent_name, schema_name, question, sql, duration_ms, rows_returned, query_type, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [agentName, schemaName, question, sql ?? '', durationMs, rowsReturned ?? null, queryType, errorMessage ?? null]
      );
      const icon = queryType === 'slow' ? '📝' : queryType === 'timeout' ? '⏱️' : '🔴';
      console.log(`${icon} Query logged [${queryType}] (${durationMs}ms) for ${agentName} — id=${result.rows[0].id}`);
      return result.rows[0];
    } catch (err) {
      // Never crash the main flow
      console.error('⚠️  Failed to log query entry:', err.message);
    }
  }

  /**
   * List slow queries (non-dismissed), newest first.
   */
  async getSlowQueries({ agentName, limit = 50, offset = 0 } = {}) {
    const params = [];
    let where = 'WHERE dismissed_at IS NULL';

    if (agentName) {
      params.push(agentName);
      where += ` AND agent_name = $${params.length}`;
    }

    params.push(limit, offset);
    const result = await this.pool.query(
      `SELECT * FROM public.slow_queries
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return result.rows;
  }

  /**
   * Get a single slow query by id.
   */
  async getSlowQuery(id) {
    const result = await this.pool.query(
      'SELECT * FROM public.slow_queries WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Run EXPLAIN (FORMAT JSON) on the query's SQL, then use Claude to
   * generate an index recommendation. Stores result in the DB.
   */
  async analyzeQuery(slowQueryId) {
    const sq = await this.getSlowQuery(slowQueryId);
    if (!sq) throw new Error(`Slow query ${slowQueryId} not found`);

    // Run EXPLAIN without ANALYZE to avoid re-executing the slow query
    let plan = null;
    let explainError = null;
    try {
      const explainResult = await this.pool.query(
        `EXPLAIN (FORMAT JSON) ${sq.sql}`
      );
      plan = explainResult.rows[0]['QUERY PLAN'];
    } catch (err) {
      explainError = err.message;
      console.warn('⚠️  EXPLAIN failed:', err.message);
    }

    // Use Claude to recommend an index
    const recommendation = await this._generateRecommendation(sq, plan, explainError);

    // Persist
    await this.pool.query(
      `UPDATE public.slow_queries
       SET recommendation = $1, analyzed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(recommendation), slowQueryId]
    );

    return { plan, recommendation };
  }

  /**
   * Mark a query as dismissed.
   */
  async dismissQuery(slowQueryId) {
    await this.pool.query(
      'UPDATE public.slow_queries SET dismissed_at = NOW() WHERE id = $1',
      [slowQueryId]
    );
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  async _generateRecommendation(sq, plan, explainError) {
    try {
      const claudeService = require('./llm.claude');

      const systemPrompt = `You are a PostgreSQL performance expert.
Analyze the query and its EXPLAIN output, then recommend the most impactful index.

The customer schema is "${sq.schema_name || 'public'}". It may have custom helper functions:
- ${sq.schema_name}.to_int_safe(col)             — safe integer cast for text columns
- ${sq.schema_name}.parse_date_ddmmyyyy(col)      — parse DD/MM/YYYY date strings to DATE
- ${sq.schema_name}.to_numeric_safe(col)          — safe numeric cast

Return a JSON object with exactly these fields:
{
  "issue": "One sentence describing the main bottleneck (e.g. Sequential scan on sales, 9.4M rows)",
  "recommendation": "Plain English fix",
  "sql": "The CREATE INDEX CONCURRENTLY statement, fully schema-qualified, using helper functions where appropriate",
  "confidence": "high|medium|low",
  "estimatedImprovement": "e.g. 10x–100x faster"
}`;

      const userMessage = [
        `Original question: ${sq.question || '(direct SQL)'}`,
        `Duration: ${sq.duration_ms}ms`,
        `Rows returned: ${sq.rows_returned ?? 'unknown'}`,
        '',
        `SQL:\n${sq.sql}`,
        '',
        explainError
          ? `EXPLAIN failed: ${explainError}`
          : `EXPLAIN (FORMAT JSON):\n${JSON.stringify(plan, null, 2)}`,
      ].join('\n');

      const responseText = await claudeService.sendOneShot(systemPrompt, userMessage, {
        jsonOutput: true,
        maxTokens: 1024,
      });

      let clean = responseText.trim();
      if (clean.startsWith('```')) {
        clean = clean.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      return JSON.parse(clean);
    } catch (err) {
      console.error('⚠️  Claude recommendation failed:', err.message);
      return {
        issue: explainError ? `EXPLAIN failed: ${explainError}` : 'Could not analyze query plan',
        recommendation: 'Manual analysis required',
        sql: '',
        confidence: 'low',
        estimatedImprovement: 'unknown',
      };
    }
  }
}

module.exports = new SlowQueryService();
