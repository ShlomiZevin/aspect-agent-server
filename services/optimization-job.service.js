const { Pool } = require('pg');

/**
 * Optimization Job Service
 *
 * Creates and tracks index/optimization jobs triggered by admin.
 * Jobs are executed asynchronously — CREATE INDEX CONCURRENTLY can take minutes.
 */
class OptimizationJobService {
  constructor() {
    // Main app DB (for jobs table)
    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 5,
    });
  }

  /**
   * List optimization jobs, newest first.
   */
  async listJobs({ agentName, limit = 50, offset = 0 } = {}) {
    const params = [];
    let where = '';

    if (agentName) {
      params.push(agentName);
      where = `WHERE agent_name = $${params.length}`;
    }

    params.push(limit, offset);
    const result = await this.pool.query(
      `SELECT * FROM public.optimization_jobs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return result.rows;
  }

  /**
   * Get a single job by id.
   */
  async getJob(id) {
    const result = await this.pool.query(
      'SELECT * FROM public.optimization_jobs WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Create a new optimization job and kick off async execution.
   */
  async createJob({ slowQueryId, agentName, schemaName, jobType = 'create_index', description, sql, createdBy }) {
    if (!sql || !agentName || !schemaName) {
      throw new Error('agentName, schemaName and sql are required');
    }

    // Validate: only DDL allowed (CREATE INDEX / CREATE MATERIALIZED VIEW)
    this._validateJobSQL(sql);

    const result = await this.pool.query(
      `INSERT INTO public.optimization_jobs
         (slow_query_id, agent_name, schema_name, job_type, description, sql, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING *`,
      [slowQueryId ?? null, agentName, schemaName, jobType, description ?? null, sql, createdBy ?? null]
    );

    const job = result.rows[0];
    console.log(`📋 Optimization job #${job.id} created (${jobType}) for ${agentName}`);

    // Fire-and-forget execution
    this._executeJobAsync(job.id).catch(err =>
      console.error(`❌ Job #${job.id} failed async:`, err.message)
    );

    return job;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _validateJobSQL(sql) {
    const upper = sql.trim().toUpperCase();
    const allowed = ['CREATE INDEX', 'CREATE UNIQUE INDEX', 'CREATE MATERIALIZED VIEW', 'REINDEX'];
    if (!allowed.some(kw => upper.startsWith(kw))) {
      throw new Error(`Job SQL must start with one of: ${allowed.join(', ')}`);
    }
  }

  async _executeJobAsync(jobId) {
    // Mark as running
    await this.pool.query(
      `UPDATE public.optimization_jobs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [jobId]
    );

    const job = await this.getJob(jobId);
    if (!job) return;

    console.log(`⚙️  Running optimization job #${jobId}: ${job.description || job.job_type}`);

    // Use a separate long-lived connection without a statement timeout
    const client = await this.pool.connect();
    try {
      // CREATE INDEX CONCURRENTLY cannot run inside a transaction
      await client.query('COMMIT').catch(() => {});
      await client.query(job.sql);

      await this.pool.query(
        `UPDATE public.optimization_jobs
         SET status = 'completed', completed_at = NOW()
         WHERE id = $1`,
        [jobId]
      );
      console.log(`✅ Optimization job #${jobId} completed`);
    } catch (err) {
      console.error(`❌ Optimization job #${jobId} failed:`, err.message);
      await this.pool.query(
        `UPDATE public.optimization_jobs
         SET status = 'failed', completed_at = NOW(), error_message = $1
         WHERE id = $2`,
        [err.message, jobId]
      );
    } finally {
      client.release();
    }
  }
}

module.exports = new OptimizationJobService();
