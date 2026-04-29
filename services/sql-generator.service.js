const claudeService = require('./llm.claude');
const schemaDescriptorService = require('./schema-descriptor.service');

/**
 * SQL Generator Service (Helper Agent)
 *
 * Uses Claude to translate natural language questions into SQL queries
 * This is a stateless helper - NOT a crew member
 */
class SQLGeneratorService {
  /**
   * Generate SQL query from natural language question
   *
   * @param {string} question - The user's question in natural language
   * @param {string} schemaName - The schema to query (e.g., 'zer4u')
   * @param {Object} options - Additional options
   * @param {string} options.schemaDescription - Pre-loaded schema description (optional)
   * @returns {Promise<Object>} - { sql, explanation, tables }
   */
  async generateSQL(question, schemaName, options = {}) {
    console.log(`🤖 SQL Generator: Translating question for schema "${schemaName}"`);
    console.log(`   Question: "${question}"`);

    try {
      // Step 1: Get schema description
      const schemaDescription = options.schemaDescription ||
        await schemaDescriptorService.getDescription(schemaName);

      // Step 2: Build the prompt for Claude
      const systemPrompt = this._buildSystemPrompt(schemaName, schemaDescription);
      const userMessage = this._buildUserMessage(question);

      console.log(`   Calling Claude to generate SQL...`);

      // Step 3: Call Claude
      const rawResponse = await claudeService.sendOneShot(
        systemPrompt,
        userMessage,
        {
          model: 'claude-sonnet-4-6',
          maxTokens: 4096,
          jsonOutput: true
        }
      );
      const response = (rawResponse && typeof rawResponse === 'object' && 'text' in rawResponse) ? rawResponse.text : rawResponse;

      // Step 4: Parse and validate response
      const result = this._parseResponse(response);
      this._validateSQL(result.sql);

      console.log(`   ✅ Generated SQL for ${result.tables.length} tables`);

      return result;

    } catch (error) {
      console.error('❌ SQL Generation failed:', error.message);
      throw new Error(`Failed to generate SQL: ${error.message}`);
    }
  }

  /**
   * Build system prompt for SQL generation
   * @private
   */
  _buildSystemPrompt(schemaName, schemaDescription) {
    return `You are an expert PostgreSQL query generator. Your task is to translate natural language questions into accurate SQL queries.

## Schema Information

${schemaDescription}

## Your Task

Generate a PostgreSQL query that answers the user's question based on the schema above.

## Rules

1. **Schema**: Always use the "${schemaName}" schema (e.g., ${schemaName}.table_name)
2. **Accuracy**: Only use tables and columns that exist in the schema
3. **Clarity**: Prefer readable queries with proper aliases and formatting
4. **Performance**: Use appropriate JOINs, WHERE clauses, and LIMIT when needed
5. **Safety**: Never generate DROP, DELETE, UPDATE, INSERT, or other destructive operations
6. **Column Names**: Column names with spaces or Hebrew characters MUST be quoted with double quotes
7. **Aggregations**: Use appropriate GROUP BY, ORDER BY, and aggregate functions
8. **Limits**: Add LIMIT clause for queries that might return many rows (default: 100)
9. **Typed Columns**: Key columns in the sales table have proper types and English names — use them directly:
    - \`sale_date\` is DATE — use standard date comparisons: \`WHERE s.sale_date >= '2024-01-01'\`
    - \`store_id\` is INTEGER — join directly: \`ON s.store_id = st.store_id\`
    - \`customer_id\` is INTEGER — join directly: \`ON s.customer_id = c.customer_id\`
    - \`revenue\` is NUMERIC — aggregate directly: \`SUM(s.revenue)\`
    - \`cost\` is NUMERIC — use directly: \`SUM(s.cost)\`
    - \`quantity\` is NUMERIC — use directly: \`SUM(s.quantity)\`
    - \`item_code\` is TEXT — join with: \`ON s.item_code = i.item_code\`
10. **Date Intervals**: Use standard PostgreSQL date arithmetic:
    - Last 6 months: \`WHERE s.sale_date >= CURRENT_DATE - INTERVAL '6 months'\`
    - Specific month: \`WHERE TO_CHAR(s.sale_date, 'YYYY-MM') = '2025-03'\`
    - Group by month: \`TO_CHAR(s.sale_date, 'YYYY-MM') AS month\`

## Important Examples

**CORRECT** (date filter — sale_date is DATE):
WHERE s.sale_date >= CURRENT_DATE - INTERVAL '6 months'

**CORRECT** (join on typed integer columns):
SELECT * FROM ${schemaName}.sales s
JOIN ${schemaName}.stores st ON s.store_id = st.store_id

**CORRECT** (revenue aggregation — revenue is NUMERIC):
SELECT TO_CHAR(s.sale_date, 'YYYY-MM') AS month,
       SUM(s.revenue) AS total_revenue
FROM ${schemaName}.sales s
WHERE s.sale_date >= CURRENT_DATE - INTERVAL '6 months'
GROUP BY month
ORDER BY month

**PREFER materialized views for aggregations** — they are pre-computed and much faster:
- \`${schemaName}.mv_sales_by_month\` — monthly totals (use for monthly/period questions)
- \`${schemaName}.mv_sales_by_year\` — annual totals
- \`${schemaName}.mv_sales_by_store\` — per-store totals
- \`${schemaName}.mv_sales_by_store_month\` — store + month breakdown
- \`${schemaName}.mv_sales_by_product\` — per-product totals
- \`${schemaName}.mv_sales_by_customer\` — per-customer totals
- \`${schemaName}.mv_sales_by_day\` — daily totals (last 90 days)

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation):

{
  "sql": "SELECT ... FROM ${schemaName}.table ...",
  "explanation": "Brief explanation of what this query does",
  "tables": ["table1", "table2"],
  "confidence": "high" | "medium" | "low"
}

If the question cannot be answered with the available schema, set confidence to "low" and explain why in the explanation field.`;
  }

  /**
   * Build user message
   * @private
   */
  _buildUserMessage(question) {
    return `Please generate a SQL query for this question:

"${question}"

Remember to respond with ONLY the JSON object.`;
  }

  /**
   * Parse Claude's response
   * @private
   */
  _parseResponse(response) {
    try {
      // Clean up response (remove markdown code blocks if present)
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(cleanResponse);

      // Validate required fields
      if (!parsed.sql) {
        throw new Error('Response missing "sql" field');
      }

      return {
        sql: parsed.sql,
        explanation: parsed.explanation || 'No explanation provided',
        tables: parsed.tables || [],
        confidence: parsed.confidence || 'medium'
      };

    } catch (error) {
      throw new Error(`Failed to parse SQL generation response: ${error.message}`);
    }
  }

  /**
   * Validate generated SQL (basic safety checks)
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
}

module.exports = new SQLGeneratorService();
