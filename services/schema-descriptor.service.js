const claudeService = require('./llm.claude');
const { Pool } = require('pg');

/**
 * Schema Descriptor Service
 *
 * Automatically generates human-readable descriptions of database schemas
 * for use in SQL generation prompts
 */
class SchemaDescriptorService {
  constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 5
    });
  }

  /**
   * Generate a comprehensive description of a schema
   * @param {string} schemaName - The schema name (e.g., 'zer4u')
   * @returns {Promise<string>} - Human-readable schema description
   */
  async generateSchemaDescription(schemaName) {
    console.log(`📊 Generating description for schema: ${schemaName}`);

    const client = await this.pool.connect();

    try {
      // Step 1: Get all tables in the schema
      const tablesResult = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
        ORDER BY table_name
      `, [schemaName]);

      const tables = tablesResult.rows.map(r => r.table_name);
      console.log(`  Found ${tables.length} tables`);

      // Step 2: Get detailed info for each table
      const tableSchemas = [];

      for (const tableName of tables) {
        const tableInfo = await this._getTableInfo(client, schemaName, tableName);
        tableSchemas.push(tableInfo);
      }

      // Step 3: Use Claude to generate a comprehensive description
      const rawSchemaText = this._formatSchemaForClaude(schemaName, tableSchemas);

      const systemPrompt = `You are a database schema documentation expert. Your task is to analyze a PostgreSQL schema structure and create a clear, comprehensive description that will be used by an AI agent to generate SQL queries.

Focus on:
1. Table purposes and business context
2. Key columns and their meanings
3. Relationships between tables (based on column name patterns)
4. Data types and constraints
5. Potential join paths

Output a well-structured description that an AI can use to understand the schema and write accurate SQL queries.`;

      const userMessage = `Please analyze this database schema and create a comprehensive description:

Schema: ${schemaName}

${rawSchemaText}

Create a description that explains:
- What each table contains (infer from table and column names)
- Key columns in each table
- Likely relationships between tables
- How to query common business questions

Format the description in a clear, structured way.`;

      console.log(`  Generating description with Claude...`);

      const description = await claudeService.sendOneShot(
        systemPrompt,
        userMessage,
        {
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
          maxTokens: 8192
        }
      );

      console.log(`  ✅ Generated ${description.length} characters`);

      return description;

    } catch (error) {
      console.error('❌ Error generating schema description:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get detailed information about a table
   * @private
   */
  async _getTableInfo(client, schemaName, tableName) {
    // Get columns
    const columnsResult = await client.query(`
      SELECT
        column_name,
        data_type,
        character_maximum_length,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schemaName, tableName]);

    // Get sample values (first 3 rows)
    const sampleResult = await client.query(`
      SELECT * FROM ${schemaName}.${tableName} LIMIT 3
    `).catch(() => ({ rows: [] })); // Ignore errors if table is empty

    // Get row count
    const countResult = await client.query(`
      SELECT COUNT(*) as count FROM ${schemaName}.${tableName}
    `).catch(() => ({ rows: [{ count: 0 }] }));

    return {
      tableName,
      rowCount: parseInt(countResult.rows[0].count),
      columns: columnsResult.rows.map(col => ({
        name: col.column_name,
        type: col.data_type,
        maxLength: col.character_maximum_length,
        nullable: col.is_nullable === 'YES',
        default: col.column_default
      })),
      sampleRows: sampleResult.rows
    };
  }

  /**
   * Format schema info for Claude
   * @private
   */
  _formatSchemaForClaude(schemaName, tableSchemas) {
    let output = `## Schema: ${schemaName}\n\n`;

    for (const table of tableSchemas) {
      output += `### Table: ${table.tableName}\n`;
      output += `Rows: ${table.rowCount.toLocaleString()}\n\n`;

      output += `**Columns:**\n`;
      for (const col of table.columns) {
        const typeStr = col.maxLength
          ? `${col.type}(${col.maxLength})`
          : col.type;
        const nullStr = col.nullable ? 'NULL' : 'NOT NULL';
        output += `- ${col.name}: ${typeStr} ${nullStr}\n`;
      }

      if (table.sampleRows.length > 0) {
        output += `\n**Sample Data:**\n`;
        output += '```\n';
        output += JSON.stringify(table.sampleRows, null, 2);
        output += '\n```\n';
      }

      output += '\n---\n\n';
    }

    return output;
  }

  /**
   * Get a cached description or generate a new one
   * @param {string} schemaName - Schema name
   * @param {boolean} forceRegenerate - Force regeneration even if cached
   * @returns {Promise<string>} - Schema description
   */
  async getDescription(schemaName, forceRegenerate = false) {
    const fs = require('fs').promises;
    const path = require('path');
    const cacheFile = path.join(__dirname, '..', 'data', `${schemaName}-schema-description.txt`);

    // Check cache
    if (!forceRegenerate) {
      try {
        const cached = await fs.readFile(cacheFile, 'utf8');
        console.log(`📄 Using cached description for ${schemaName}`);
        return cached;
      } catch (error) {
        // Cache miss, generate new
      }
    }

    // Generate new description
    const description = await this.generateSchemaDescription(schemaName);

    // Save to cache
    try {
      await fs.writeFile(cacheFile, description);
      console.log(`💾 Cached description to: ${cacheFile}`);
    } catch (error) {
      console.warn('⚠️  Failed to cache description:', error.message);
    }

    return description;
  }

  /**
   * Close database connection
   */
  async close() {
    await this.pool.end();
  }
}

module.exports = new SchemaDescriptorService();
