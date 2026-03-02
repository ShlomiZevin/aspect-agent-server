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
      const response = await claudeService.sendOneShot(
        systemPrompt,
        userMessage,
        {
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
          maxTokens: 4096,
          jsonOutput: true
        }
      );

      // Step 4: Parse response
      const result = this._parseResponse(response);

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
5. **Safety**: Never generate DROP, DELETE, UPDATE, or other destructive operations
6. **Column Names**: CRITICAL - Column names with spaces or Hebrew MUST be quoted with double quotes
7. **Quote Escaping**: If a column name contains a quote character (like מע"מ), you MUST escape it by doubling: "מכירה ללא מע""מ"
8. **Aggregations**: Use appropriate GROUP BY, ORDER BY, and aggregate functions
9. **Limits**: Add LIMIT clause for queries that might return many rows (default: 100)
10. **Type Casting**: CRITICAL - Use the INDEXED helper functions for joins/filters on sales table columns:
    - For store number: zer4u.to_int_safe(s."מס.חנות SALES") = st."מס.חנות" (uses index - FAST!)
    - For customer number: zer4u.to_int_safe(s."מס.לקוח") = c."מס.לקוח" (uses index - FAST!)
    - NEVER use ::integer cast directly for these columns - it skips the index and is SLOW
11. **Date Handling**: CRITICAL - Date columns are stored as TEXT in DD/MM/YYYY format (Israeli format).
    - NEVER use ::date cast - it fails with "date/time field value out of range"
    - NEVER use TO_DATE(column, 'DD/MM/YYYY') in WHERE clauses - this is SLOW (no index)
    - ALWAYS use zer4u.parse_date_ddmmyyyy(column) for date comparisons - uses an INDEX and is FAST!
    - Example: WHERE zer4u.parse_date_ddmmyyyy(s."תאריך מקורי SALES") >= CURRENT_DATE - INTERVAL '6 months'
    - For GROUP BY month: TO_CHAR(zer4u.parse_date_ddmmyyyy(s."תאריך מקורי SALES"), 'YYYY-MM') AS month

## Important Examples

**WRONG** (quote not escaped):
SELECT "מכירה ללא מע"מ" FROM zer4u.sales
❌ This will cause: syntax error at or near "מ"

**CORRECT** (quote escaped by doubling):
SELECT "מכירה ללא מע""מ" FROM zer4u.sales
✅ The quote inside the column name is escaped as ""

**WRONG** (type mismatch in JOIN - SLOW, no index):
SELECT * FROM zer4u.sales s JOIN zer4u.stores st ON s."מס.חנות SALES" = st."מס.חנות"
❌ This will cause: operator does not exist: text = integer

**WRONG** (::integer cast - SLOW, skips index):
SELECT * FROM zer4u.sales s JOIN zer4u.stores st ON s."מס.חנות SALES"::integer = st."מס.חנות"
❌ This skips the expression index and is slow

**CORRECT** (use indexed helper function - FAST!):
SELECT * FROM zer4u.sales s JOIN zer4u.stores st ON zer4u.to_int_safe(s."מס.חנות SALES") = st."מס.חנות"
✅ Uses expression index idx_sales_store_date - much faster

**WRONG** (date cast on Israeli format):
WHERE s."תאריך מקורי SALES"::date >= CURRENT_DATE - INTERVAL '6 months'
❌ This will cause: date/time field value out of range: "16/12/2024"

**WRONG** (TO_DATE - SLOW, no index):
WHERE TO_DATE(s."תאריך מקורי SALES", 'DD/MM/YYYY') >= CURRENT_DATE - INTERVAL '6 months'
❌ This skips the expression index and is slow

**CORRECT** (use indexed parse function - FAST!):
WHERE zer4u.parse_date_ddmmyyyy(s."תאריך מקורי SALES") >= CURRENT_DATE - INTERVAL '6 months'
✅ Uses expression index idx_sales_date_parsed - much faster

**CORRECT** (group by month - using indexed function):
SELECT TO_CHAR(zer4u.parse_date_ddmmyyyy(s."תאריך מקורי SALES"), 'YYYY-MM') AS month,
       SUM(s."מכירה ללא מע""מ"::numeric) AS total_revenue
FROM zer4u.sales s
WHERE zer4u.parse_date_ddmmyyyy(s."תאריך מקורי SALES") >= CURRENT_DATE - INTERVAL '6 months'
GROUP BY month
ORDER BY month

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
