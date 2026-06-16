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

      // Step 1b: Get materialized views. Postgres does NOT list these in
      // information_schema, so they must be read from pg_matviews — otherwise the
      // generated description omits the MVs entirely and the SQL generator never
      // learns their (differently-named) columns, e.g. mv_sales_by_store.store_number.
      const mvResult = await client.query(`
        SELECT matviewname
        FROM pg_matviews
        WHERE schemaname = $1
        ORDER BY matviewname
      `, [schemaName]);
      const matviews = mvResult.rows.map(r => r.matviewname);
      console.log(`  Found ${tables.length} tables, ${matviews.length} materialized views`);

      // Step 2: Get detailed info for each table + materialized view
      const tableSchemas = [];

      for (const tableName of tables) {
        tableSchemas.push(await this._getTableInfo(client, schemaName, tableName));
      }
      for (const mvName of matviews) {
        tableSchemas.push(await this._getMatviewInfo(client, schemaName, mvName));
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
6. Materialized views (entries marked "Materialized View"): these are pre-aggregated and MUCH faster. For each, state exactly which business questions it answers and list its EXACT column names. IMPORTANT: a materialized view may name a column differently from the base tables (e.g. a store key exposed as "store_number" even though base tables use "store_id"). Always document and instruct use of the view's OWN column names — never assume base-table column names apply to a view.

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

      // Claude only PRETTIFIES the already-complete raw schema map (rawSchemaText
      // holds every table/MV's exact columns + samples). If that call fails — e.g.
      // a deprecated/unavailable model id — fall back to the raw map so the SQL
      // generator ALWAYS gets the real, current columns and never has to guess.
      // Pinned to a current model on purpose: env CLAUDE_MODEL has historically held
      // a now-404 id (claude-sonnet-4-20250514), which silently broke regeneration.
      const DESCRIPTOR_MODEL = process.env.SCHEMA_DESCRIPTOR_MODEL || 'claude-sonnet-4-6';
      let description;
      try {
        const rawResult = await claudeService.sendOneShot(
          systemPrompt,
          userMessage,
          { model: DESCRIPTOR_MODEL, maxTokens: 8192 }
        );
        description = (rawResult && typeof rawResult === 'object' && 'text' in rawResult) ? rawResult.text : rawResult;
        if (!description || !String(description).trim()) throw new Error('empty description from model');
        console.log(`  ✅ Generated ${description.length} characters (model ${DESCRIPTOR_MODEL})`);
      } catch (err) {
        console.warn(`  ⚠️  Claude prettify failed (${err.message}) — falling back to raw deterministic schema map`);
        description = rawSchemaText;
      }

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
   * Get detailed info about a materialized view. MVs are absent from
   * information_schema, so columns come from pg_attribute/pg_class.
   * @private
   */
  async _getMatviewInfo(client, schemaName, matviewName) {
    const columnsResult = await client.query(`
      SELECT a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             NOT a.attnotnull AS is_nullable
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'm'
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `, [schemaName, matviewName]);

    const sampleResult = await client.query(
      `SELECT * FROM ${schemaName}.${matviewName} LIMIT 3`
    ).catch(() => ({ rows: [] }));

    const countResult = await client.query(
      `SELECT COUNT(*) as count FROM ${schemaName}.${matviewName}`
    ).catch(() => ({ rows: [{ count: 0 }] }));

    return {
      tableName: matviewName,
      isMatview: true,
      rowCount: parseInt(countResult.rows[0].count),
      columns: columnsResult.rows.map(col => ({
        name: col.column_name,
        type: col.data_type,
        maxLength: null,
        nullable: col.is_nullable,
        default: null,
      })),
      sampleRows: sampleResult.rows,
    };
  }

  /**
   * Format schema info for Claude
   * @private
   */
  _formatSchemaForClaude(schemaName, tableSchemas) {
    let output = `## Schema: ${schemaName}\n\n`;

    for (const table of tableSchemas) {
      output += table.isMatview
        ? `### Materialized View: ${table.tableName}  (pre-aggregated — PREFER for the aggregate queries it covers; use its EXACT column names)\n`
        : `### Table: ${table.tableName}\n`;
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
   * @param {Object} [schemaPool] - Pool pointing to the DB that contains schemaName (for generation)
   * @param {Object} [cachePool]  - Pool for reading/writing the cache table (defaults to main DB pool)
   * @returns {Promise<string>} - Schema description
   */
  async getDescription(schemaName, forceRegenerate = false, schemaPool = null, cachePool = null) {
    const cp = cachePool || this.pool;

    // Check DB cache
    if (!forceRegenerate) {
      try {
        const result = await cp.query(
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

    // Generate new description using the pool that has the actual schema tables
    const description = await this.generateSchemaDescription(schemaName, schemaPool);

    // Save to DB cache
    try {
      await cp.query(
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
