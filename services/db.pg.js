const { drizzle } = require('drizzle-orm/node-postgres');
const { Pool } = require('pg');

/**
 * Database Service with Drizzle ORM for Multi-Agent Platform
 *
 * Provides PostgreSQL connection with Drizzle ORM for type-safe queries.
 * Supports multiple agent domains and conversations.
 */
class DatabaseService {
  constructor() {
    this.pool = null;
    this.db = null;
    this.isConnected = false;
  }

  /**
   * Initialize database connection pool with Drizzle
   * Reads configuration from environment variables
   */
  async initialize() {
    if (this.pool) {
      console.log('⚠️  Database pool already initialized');
      return;
    }

    // Check if using Cloud SQL Unix socket (App Engine) or TCP connection
    const isUnixSocket = process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/');

    const poolConfig = {
      database: process.env.DB_NAME || 'agents_platform_db',
      user: process.env.DB_USER || 'agent_admin',
      password: process.env.DB_PASSWORD,

      // Connection pool settings
      max: parseInt(process.env.DB_POOL_MAX || '20', 10), // Maximum connections
      min: parseInt(process.env.DB_POOL_MIN || '2', 10),  // Minimum connections
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000', 10),
    };

    // Add host/port or Unix socket depending on environment
    if (isUnixSocket) {
      // App Engine uses Unix socket
      poolConfig.host = process.env.DB_HOST;
      console.log('   Using Cloud SQL Unix socket connection');
    } else {
      // Local development or direct IP connection
      poolConfig.host = process.env.DB_HOST || 'localhost';
      poolConfig.port = parseInt(process.env.DB_PORT || '5432', 10);

      // SSL configuration for Cloud SQL direct connections
      poolConfig.ssl = process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: false
      } : false;
    }

    try {
      // Create connection pool
      this.pool = new Pool(poolConfig);

      // Initialize Drizzle with the pool
      this.db = drizzle(this.pool);

      // Test connection
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW(), current_database(), current_user');
      client.release();

      this.isConnected = true;
      console.log('✅ Database connected successfully');
      console.log(`   Database: ${result.rows[0].current_database}`);
      console.log(`   User: ${result.rows[0].current_user}`);
      console.log(`   Time: ${result.rows[0].now}`);

      // Setup connection error handlers
      this.pool.on('error', (err) => {
        console.error('❌ Unexpected database pool error:', err);
        this.isConnected = false;
      });

      this.pool.on('connect', () => {
        console.log('🔗 New database client connected');
      });

      this.pool.on('remove', () => {
        console.log('🔌 Database client removed from pool');
      });

    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      throw new Error(`Failed to connect to database: ${error.message}`);
    }
  }

  /**
   * Get Drizzle instance for type-safe queries
   * @returns {Object} - Drizzle ORM instance
   */
  getDrizzle() {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a raw SQL query (use sparingly, prefer Drizzle queries)
   * @param {string} text - SQL query text
   * @param {Array} params - Query parameters
   * @returns {Promise<Object>} - Query result
   */
  async query(text, params = []) {
    if (!this.pool) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;

      console.log('📊 Query executed', {
        duration: `${duration}ms`,
        rows: result.rowCount,
        command: result.command
      });

      return result;
    } catch (error) {
      console.error('❌ Query error:', error.message);
      console.error('   Query:', text);
      console.error('   Params:', params);
      throw error;
    }
  }

  /**
   * Get a client from the pool for transactions
   * @returns {Promise<Object>} - Database client
   */
  async getClient() {
    if (!this.pool) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return await this.pool.connect();
  }

  /**
   * Execute multiple queries in a transaction using Drizzle
   * @param {Function} callback - Async function that receives Drizzle tx and executes queries
   * @returns {Promise<any>} - Result from callback
   */
  async transaction(callback) {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    try {
      return await this.db.transaction(callback);
    } catch (error) {
      console.error('❌ Transaction failed:', error.message);
      throw error;
    }
  }

  /**
   * Test database connection
   * @returns {Promise<Object>} - Connection test result
   */
  async testConnection() {
    try {
      const result = await this.query('SELECT * FROM connection_test ORDER BY created_at DESC LIMIT 1');
      return {
        success: true,
        connected: this.isConnected,
        testData: result.rows[0] || null,
        poolStats: {
          total: this.pool.totalCount,
          idle: this.pool.idleCount,
          waiting: this.pool.waitingCount
        }
      };
    } catch (error) {
      return {
        success: false,
        connected: false,
        error: error.message
      };
    }
  }

  /**
   * Get pool statistics
   * @returns {Object} - Pool statistics
   */
  getPoolStats() {
    if (!this.pool) {
      return { initialized: false };
    }

    return {
      initialized: true,
      connected: this.isConnected,
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount
    };
  }

  /**
   * Close all connections and shut down the pool
   */
  async close() {
    if (this.pool) {
      console.log('🔌 Closing database pool...');
      await this.pool.end();
      this.pool = null;
      this.db = null;
      this.isConnected = false;
      console.log('✅ Database pool closed');
    }
  }

  /**
   * Health check for monitoring
   * @returns {Promise<Object>} - Health status
   */
  async healthCheck() {
    if (!this.pool || !this.isConnected) {
      return {
        status: 'unhealthy',
        message: 'Database not connected',
        timestamp: new Date().toISOString()
      };
    }

    try {
      const start = Date.now();
      await this.query('SELECT 1');
      const responseTime = Date.now() - start;

      return {
        status: 'healthy',
        message: 'Database connection active',
        responseTime: `${responseTime}ms`,
        poolStats: this.getPoolStats(),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// Export singleton instance
module.exports = new DatabaseService();
