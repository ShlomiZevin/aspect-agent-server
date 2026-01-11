const express = require('express');
const router = express.Router();
const db = require('../services/database');

/**
 * Database Test Routes
 *
 * These routes demonstrate database connectivity and provide
 * health checks for the Cloud SQL PostgreSQL connection.
 */

/**
 * GET /api/db/health
 * Database health check endpoint
 */
router.get('/health', async (req, res) => {
  try {
    const health = await db.healthCheck();
    const statusCode = health.status === 'healthy' ? 200 : 503;

    res.status(statusCode).json(health);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/db/test
 * Test database connection and retrieve test data
 */
router.get('/test', async (req, res) => {
  try {
    const testResult = await db.testConnection();

    if (testResult.success) {
      res.json({
        success: true,
        message: 'Database connection successful',
        data: testResult
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Database connection failed',
        error: testResult.error
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Database test failed',
      error: error.message
    });
  }
});

/**
 * GET /api/db/stats
 * Get connection pool statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = db.getPoolStats();
    res.json({
      success: true,
      stats: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve pool stats',
      error: error.message
    });
  }
});

/**
 * POST /api/db/query
 * Execute a custom query (for testing only - remove in production!)
 * Body: { "sql": "SELECT * FROM connection_test", "params": [] }
 */
router.post('/query', async (req, res) => {
  // SECURITY WARNING: This endpoint is for development/testing only!
  // Remove or protect this endpoint in production to prevent SQL injection
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      message: 'Query endpoint disabled in production'
    });
  }

  try {
    const { sql, params = [] } = req.body;

    if (!sql) {
      return res.status(400).json({
        success: false,
        message: 'SQL query is required'
      });
    }

    const result = await db.query(sql, params);

    res.json({
      success: true,
      rows: result.rows,
      rowCount: result.rowCount,
      command: result.command
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Query execution failed',
      error: error.message
    });
  }
});

/**
 * GET /api/db/info
 * Get database and instance information
 */
router.get('/info', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        current_database() as database,
        current_user as user,
        version() as version,
        pg_size_pretty(pg_database_size(current_database())) as size,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as active_connections
    `);

    const schemas = await db.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT LIKE 'pg_%'
        AND schema_name != 'information_schema'
      ORDER BY schema_name
    `);

    const tables = await db.query(`
      SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, tablename
    `);

    res.json({
      success: true,
      database: result.rows[0],
      schemas: schemas.rows.map(r => r.schema_name),
      tables: tables.rows,
      poolStats: db.getPoolStats()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve database info',
      error: error.message
    });
  }
});

module.exports = router;
