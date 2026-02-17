const { Pool } = require('pg');
const sqlGeneratorService = require('./sql-generator.service');

/**
 * Data Query Service
 *
 * Generic service for querying customer data schemas
 * Handles the full flow: question → SQL → results
 */
class DataQueryService {
  constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 10
    });
  }

  /**
   * Query data by asking a natural language question
   *
   * @param {string} question - Natural language question
   * @param {string} customerSchema - Customer schema name (e.g., 'zer4u')
   * @param {Object} options - Query options
   * @param {number} options.maxRows - Maximum rows to return (default: 100)
   * @param {number} options.timeout - Query timeout in ms (default: 30000)
   * @returns {Promise<Object>} - { sql, data, rowCount, explanation }
   */
  async queryByQuestion(question, customerSchema, options = {}) {
    const {
      maxRows = 100,
      timeout = 30000
    } = options;

    console.log(`📊 Data Query Service: Processing question for ${customerSchema}`);
    console.log(`   Question: "${question}"`);

    const client = await this.pool.connect();

    try {
      // Step 1: Generate SQL from question
      console.log(`   Step 1: Generating SQL...`);
      const { sql, explanation, confidence } = await sqlGeneratorService.generateSQL(
        question,
        customerSchema
      );

      console.log(`   Generated SQL (confidence: ${confidence}):`);
      console.log(`   ${sql}`);

      // Step 2: Execute query with timeout
      console.log(`   Step 2: Executing query...`);

      // Set statement timeout for safety
      await client.query(`SET statement_timeout = ${timeout}`);

      const startTime = Date.now();
      const result = await client.query(sql);
      const duration = Date.now() - startTime;

      console.log(`   ✅ Query completed in ${duration}ms`);
      console.log(`   Rows returned: ${result.rows.length}`);

      // Step 3: Format and return results
      return {
        sql,
        explanation,
        confidence,
        data: result.rows,
        rowCount: result.rows.length,
        duration,
        columns: result.fields?.map(f => f.name) || []
      };

    } catch (error) {
      console.error('❌ Query execution failed:', error.message);

      // Return error in structured format
      return {
        error: true,
        message: error.message,
        sql: null,
        data: [],
        rowCount: 0
      };

    } finally {
      // Reset timeout
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
  }

  /**
   * Execute a pre-generated SQL query directly
   *
   * @param {string} sql - The SQL query to execute
   * @param {Object} options - Query options
   * @returns {Promise<Object>} - { data, rowCount, columns }
   */
  async executeSQL(sql, options = {}) {
    const { timeout = 30000 } = options;

    console.log(`📊 Executing direct SQL query`);

    const client = await this.pool.connect();

    try {
      // Validate SQL (basic safety check)
      this._validateSQL(sql);

      // Set timeout
      await client.query(`SET statement_timeout = ${timeout}`);

      const startTime = Date.now();
      const result = await client.query(sql);
      const duration = Date.now() - startTime;

      console.log(`   ✅ Query completed in ${duration}ms, ${result.rows.length} rows`);

      return {
        data: result.rows,
        rowCount: result.rows.length,
        columns: result.fields?.map(f => f.name) || [],
        duration
      };

    } catch (error) {
      console.error('❌ SQL execution failed:', error.message);
      throw error;

    } finally {
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
  }

  /**
   * Get sample data from a table
   *
   * @param {string} customerSchema - Schema name
   * @param {string} tableName - Table name
   * @param {number} limit - Number of rows (default: 10)
   * @returns {Promise<Object>} - { data, rowCount, columns }
   */
  async getSampleData(customerSchema, tableName, limit = 10) {
    const sql = `SELECT * FROM ${customerSchema}.${tableName} LIMIT ${limit}`;
    return this.executeSQL(sql);
  }

  /**
   * Get table statistics
   *
   * @param {string} customerSchema - Schema name
   * @param {string} tableName - Table name
   * @returns {Promise<Object>} - { rowCount, columnCount, sampleData }
   */
  async getTableStats(customerSchema, tableName) {
    const client = await this.pool.connect();

    try {
      // Get row count
      const countResult = await client.query(
        `SELECT COUNT(*) as count FROM ${customerSchema}.${tableName}`
      );

      // Get column count
      const colResult = await client.query(`
        SELECT COUNT(*) as count
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
      `, [customerSchema, tableName]);

      // Get sample data
      const sampleResult = await client.query(
        `SELECT * FROM ${customerSchema}.${tableName} LIMIT 5`
      );

      return {
        rowCount: parseInt(countResult.rows[0].count),
        columnCount: parseInt(colResult.rows[0].count),
        sampleData: sampleResult.rows
      };

    } finally {
      client.release();
    }
  }

  /**
   * Validate SQL for safety
   * @private
   */
  _validateSQL(sql) {
    const dangerous = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'TRUNCATE', 'ALTER', 'CREATE'];
    const upperSQL = sql.toUpperCase();

    for (const keyword of dangerous) {
      if (upperSQL.includes(keyword)) {
        throw new Error(`SQL contains forbidden keyword: ${keyword}`);
      }
    }

    return true;
  }

  /**
   * Format query results for display
   *
   * @param {Array} data - Query results
   * @param {Object} options - Formatting options
   * @returns {string} - Formatted output
   */
  formatResults(data, options = {}) {
    const { format = 'table', maxRows = 20 } = options;

    if (!data || data.length === 0) {
      return 'No results found.';
    }

    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    }

    if (format === 'table') {
      // Simple table formatting
      const displayData = data.slice(0, maxRows);
      let output = '';

      if (data.length > maxRows) {
        output += `Showing ${maxRows} of ${data.length} rows\n\n`;
      }

      output += JSON.stringify(displayData, null, 2);

      return output;
    }

    return JSON.stringify(data);
  }

  /**
   * Close database connection
   */
  async close() {
    await this.pool.end();
  }
}

module.exports = new DataQueryService();
