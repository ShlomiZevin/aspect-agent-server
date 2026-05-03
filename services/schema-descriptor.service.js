const claudeService = require('./llm.claude');
const dbService = require('./db.pg');

/**
 * Schema Descriptor Service
 *
 * Automatically generates human-readable descriptions of database schemas
 * for use in SQL generation prompts
 */
class SchemaDescriptorService {
  // Uses the shared db.pg pool — no dedicated pool needed.
  get pool() { return dbService.pool; }

  /**
   * Generate a comprehensive description of a schema
   * @param {string} schemaName - The schema name (e.g., 'zer4u')
   * @param {Object} [pool] - Optional pg Pool to use (pass zer4u pool for zer4u schema)
   * @returns {Promise<string>} - Human-readable schema description
   */
  async generateSchemaDescription(schemaName, pool = null) {
    console.log(`📊 Generating description for schema: ${schemaName}`);

    const client = await (pool || this.pool).connect();

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

      const rawResult = await claudeService.sendOneShot(
        systemPrompt,
        userMessage,
        {
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
          maxTokens: 8192
        }
      );
      const description = (rawResult && typeof rawResult === 'object' && 'text' in rawResult) ? rawResult.text : rawResult;

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
   * Get a cached description from the DB, or generate a new one.
   * @param {string} schemaName - Schema name
   * @param {boolean} forceRegenerate - Force regeneration even if cached
   * @param {Object} [pool] - Optional pg Pool pointing to the DB that contains schemaName (e.g. zer4u pool)
   * @returns {Promise<string>} - Schema description
   */
  async getDescription(schemaName, forceRegenerate = false, pool = null) {
    // Check DB cache (main DB — always accessible regardless of schema location)
    if (!forceRegenerate) {
      try {
        const result = await this.pool.query(
          'SELECT description FROM public.schema_descriptions WHERE schema_name = $1',
          [schemaName]
        );
        if (result.rows.length > 0) {
          console.log(`📄 Using cached description for ${schemaName} (DB)`);
          return result.rows[0].description;
        }
      } catch (err) {
        console.warn(`⚠️  DB cache read failed for ${schemaName}: ${err.message}`);
      }
    }

    // Generate new description using the correct pool for that schema
    const description = await this.generateSchemaDescription(schemaName, pool);

    // Save to DB cache
    try {
      await this.pool.query(
        `INSERT INTO public.schema_descriptions (schema_name, description, generated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (schema_name) DO UPDATE
           SET description = EXCLUDED.description, generated_at = NOW()`,
        [schemaName, description]
      );
      console.log(`💾 Cached description for ${schemaName} in DB`);
    } catch (err) {
      console.warn(`⚠️  Failed to cache description in DB: ${err.message}`);
    }

    return description;
  }

}

module.exports = new SchemaDescriptorService();
