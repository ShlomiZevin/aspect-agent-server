const claudeService = require('./llm.claude');
const schemaDescriptorService = require('./schema-descriptor.service');
const slowQueryService = require('./slow-query.service');
const { getPool: getZer4uPool } = require('./db.zer4u');

/**
 * SQL Generator Service (Helper Agent)
 *
 * Uses Claude to translate natural language questions into SQL queries
 * This is a stateless helper - NOT a crew member
 */
class SQLGeneratorService {
  constructor() {
    // Cache slow queries per schema for 5 minutes to avoid fetching on every call
    this._antiPatternCache = new Map(); // schemaName -> { queries, fetchedAt }
  }

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
      // Step 1: Get schema description (cached in zer4u DB)
      const schemaDescription = options.schemaDescription ||
        await schemaDescriptorService.getDescription(schemaName, false, null, getZer4uPool());

      // Step 2: Fetch slow query anti-patterns (cached)
      const antiPatterns = await this._getAntiPatterns(schemaName);

      // Step 3: Build the prompt for Claude
      const systemPrompt = this._buildSystemPrompt(schemaName, schemaDescription, antiPatterns);
      const userMessage = this._buildUserMessage(question);

      console.log(`   Calling Claude to generate SQL (${antiPatterns.length} anti-patterns loaded)...`);

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

      // Step 4: Parse response (safety validation happens in data-query.service before execution)
      const result = this._parseResponse(response);

      console.log(`   ✅ Generated SQL for ${result.tables.length} tables`);

      return result;

    } catch (error) {
      console.error('❌ SQL Generation failed:', error.message);
      throw new Error(`Failed to generate SQL: ${error.message}`);
    }
  }

  /**
   * Fetch recent slow/error/timeout queries for a schema (5-min cache).
   * Returns empty array on failure so generation is never blocked.
   * @private
   */
  async _getAntiPatterns(schemaName) {
    const cached = this._antiPatternCache.get(schemaName);
    if (cached && (Date.now() - cached.fetchedAt) < 5 * 60 * 1000) {
      return cached.queries;
    }
    try {
      const queries = await slowQueryService.getSlowQueries({ agentName: schemaName, limit: 20 });
      this._antiPatternCache.set(schemaName, { queries, fetchedAt: Date.now() });
      return queries;
    } catch (err) {
      console.warn(`⚠️  Failed to load slow query anti-patterns: ${err.message}`);
      return [];
    }
  }

  /**
   * Build system prompt for SQL generation
   * @private
   */
  _buildSystemPrompt(schemaName, schemaDescription, antiPatterns = []) {
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
${this._getSchemaSpecificRules(schemaName)}
${this._buildAntiPatternsSection(antiPatterns)}
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
   * Schema-specific SQL rules injected into the prompt.
   * Keeps zer4u, newdeli and thestock rules separate — no cross-contamination.
   * @private
   */
  _getSchemaSpecificRules(schemaName) {
    if (schemaName === 'thestock') {
      return `
## thestock-Specific Rules (CRITICAL — follow exactly)

**Tables**: payments (~9.8M rows), credits (~158K), customers (~1.07M), products (~61K), warehouses (168), inventory_c100 (~901K), calendar (868), calendar_compare (868)
**NO sales facts table exists** — there is NO item-level link between products and transactions. Do NOT attempt to join products to payments/credits via transaction lines.

### RULE 1 — There is NO date / time column on payments or credits (CRITICAL)
Neither \`payments\` nor \`credits\` has any date, year, month, or timestamp column. The columns on \`payments\` are EXACTLY: amount (NUMERIC), payment_type_code (TEXT), payment_type (TEXT), transaction_id (TEXT). On \`credits\`: transaction_id (TEXT), credit_issued, cash_credit, card_credit, employee_discount, special_discount (all NUMERIC).

This means:
- "this year", "this month", "last week", "in 2024", any time-bound filter on payments or credits is IMPOSSIBLE.
- \`transaction_id\` is TEXT (e.g. 'C4501000049', 'G3942001208', '4801006315') and does NOT encode any date. NEVER attempt \`EXTRACT(YEAR FROM transaction_id)\`, \`CAST(transaction_id AS DATE)\`, or any similar hack — it will fail at runtime.
- The \`calendar\` table is a standalone date dimension with no foreign key to payments/credits. You CANNOT JOIN payments to calendar on any meaningful key.

If the user asks a time-bound payment/credit question, set confidence to "low" and explain in the \`explanation\` field that the loaded schema has no transaction date — offer to return the equivalent metric across ALL data (no time filter) instead.

### RULE 2 — No item-level sales
If the user asks about top products, sales by category, revenue per branch, customer baskets, or sales trends over time, return confidence "low" with an explanation that this data is not available in the loaded schema.

### RULE 3 — payments table joins
\`payments\` and \`credits\` share \`transaction_id\` (TEXT, often with a prefix letter like 'C', 'G').
- JOIN: \`JOIN thestock.credits c ON p.transaction_id = c.transaction_id\`

### RULE 4 — Always LIMIT on large tables
\`payments\` (9.8M) and \`customers\` (1.07M) and \`inventory_c100\` (901K) must be aggregated or LIMITed.
- Never \`SELECT * FROM thestock.payments\` without aggregation or LIMIT.

### RULE 5 — Inventory at C100
\`inventory_c100\` represents disconnected items at warehouse C100. Negative values are common and meaningful.
- JOIN with products: \`JOIN thestock.products p ON i.sku = p.sku\`

### RULE 6 — Cross-brand cost
\`products\` has BOTH The Stock cost (\`standard_cost_ils\`) and the sister brand Hyper Toy cost (\`standard_cost_ils_hypertoy\`). The difference is precomputed in \`cost_difference\`.

### Reference examples

**Customer count by city:**
\`\`\`sql
SELECT city, COUNT(*) AS customer_count
FROM thestock.customers
WHERE city IS NOT NULL AND city <> ''
GROUP BY city
ORDER BY customer_count DESC
LIMIT 20
\`\`\`

**Payment-method totals:**
\`\`\`sql
SELECT payment_type, SUM(amount) AS total_amount, COUNT(*) AS line_count
FROM thestock.payments
GROUP BY payment_type
ORDER BY total_amount DESC
\`\`\`

**Refund / credit summary:**
\`\`\`sql
SELECT
  SUM(credit_issued)      AS total_credit_issued,
  SUM(cash_credit)        AS total_cash_credit,
  SUM(card_credit)        AS total_card_credit,
  SUM(employee_discount)  AS total_employee_discount,
  SUM(special_discount)   AS total_special_discount,
  COUNT(*)                AS transaction_count
FROM thestock.credits
\`\`\`

**SKUs with negative C100 inventory:**
\`\`\`sql
SELECT i.sku, i.c100_inventory, p.item_description, p.family_description
FROM thestock.inventory_c100 i
LEFT JOIN thestock.products p ON i.sku = p.sku
WHERE i.c100_inventory < 0
ORDER BY i.c100_inventory ASC
LIMIT 50
\`\`\`

**Top suppliers by number of products:**
\`\`\`sql
SELECT preferred_supplier, COUNT(*) AS product_count
FROM thestock.products
WHERE preferred_supplier IS NOT NULL AND preferred_supplier <> ''
GROUP BY preferred_supplier
ORDER BY product_count DESC
LIMIT 20
\`\`\`

**Largest cost gaps vs Hyper Toy:**
\`\`\`sql
SELECT sku, item_description, standard_cost_ils, standard_cost_ils_hypertoy, cost_difference
FROM thestock.products
WHERE cost_difference IS NOT NULL
ORDER BY ABS(cost_difference) DESC
LIMIT 20
\`\`\``;
    }

    if (schemaName === 'newdeli') {
      return `
## newdeli-Specific Rules (CRITICAL — follow exactly)

**Tables**: facts (~3.7M rows), branches (44 rows), order_items (~3.7M rows)
**NO materialized views exist** — query newdeli.facts directly for all aggregations.

### RULE 1 — Never COUNT(DISTINCT)
Each row in facts is already one unique order. NEVER use COUNT(DISTINCT ...).
- WRONG: \`COUNT(DISTINCT f.order_id)\`
- CORRECT: \`COUNT(*)\`

### RULE 2 — Always filter by status = '2' (completed orders)
Always add \`WHERE f.status = '2'\` unless the question explicitly asks about all orders including cancelled.
The composite index (status, year_month) makes status-filtered queries very fast.

### RULE 3 — Use year_month for all date filters (indexed TEXT, format 'YYYY-MM')
- This month:  \`WHERE f.year_month = TO_CHAR(CURRENT_DATE, 'YYYY-MM') AND f.status = '2'\`
- Specific month: \`WHERE f.year_month = '2024-03' AND f.status = '2'\`
- Specific year:  \`WHERE f.year_month BETWEEN '2024-01' AND '2024-12' AND f.status = '2'\`
- Date range:  \`WHERE f.year_month BETWEEN '2024-01' AND '2024-06' AND f.status = '2'\`
- NEVER use \`TO_CHAR(order_date, 'YYYY-MM')\` for filtering — bypasses the index.
- NEVER use \`WHERE f.year = 2024\` — no index on year column.

### RULE 4 — order_items queries MUST always have a year_month date filter
order_items has 3.7M rows. A full scan always times out. You MUST add a year_month filter via JOIN with facts.
If the user does not specify a period, default to the last 3 months. Never query all-time dish data.
- WRONG (no date filter → timeout): \`SELECT item_names, COUNT(*) FROM newdeli.order_items GROUP BY item_names\`
- WRONG (no date filter → timeout): \`JOIN newdeli.facts f ON oi.order_id = f.order_id WHERE f.status = '2'\`
- CORRECT (always include year_month filter):
\`\`\`sql
SELECT oi.item_names, COUNT(*) AS order_count
FROM newdeli.order_items oi
JOIN newdeli.facts f ON oi.order_id = f.order_id
WHERE f.year_month >= TO_CHAR(CURRENT_DATE - INTERVAL '3 months', 'YYYY-MM')
  AND f.status = '2'
GROUP BY oi.item_names
ORDER BY order_count DESC
LIMIT 10
\`\`\`

### JOIN pattern for branches
\`JOIN newdeli.branches b ON f.branch_id = b.branch_id\`

### Reference examples

**This month revenue:**
\`\`\`sql
SELECT SUM(f.order_revenue) AS total_revenue, COUNT(*) AS order_count
FROM newdeli.facts f
WHERE f.year_month = TO_CHAR(CURRENT_DATE, 'YYYY-MM') AND f.status = '2'
\`\`\`

**Monthly breakdown for 2024:**
\`\`\`sql
SELECT f.year_month, SUM(f.order_revenue) AS total_revenue, COUNT(*) AS order_count
FROM newdeli.facts f
WHERE f.year_month BETWEEN '2024-01' AND '2024-12' AND f.status = '2'
GROUP BY f.year_month
ORDER BY f.year_month
\`\`\`

**Top branches by revenue (all time):**
\`\`\`sql
SELECT b.branch_name, b.company, SUM(f.order_revenue) AS total_revenue, COUNT(*) AS order_count
FROM newdeli.facts f
JOIN newdeli.branches b ON f.branch_id = b.branch_id
WHERE f.status = '2'
GROUP BY b.branch_name, b.company
ORDER BY total_revenue DESC
LIMIT 10
\`\`\`

**Order count by order type:**
\`\`\`sql
SELECT f.order_type, COUNT(*) AS order_count, SUM(f.order_revenue) AS total_revenue
FROM newdeli.facts f
WHERE f.status = '2'
GROUP BY f.order_type
ORDER BY order_count DESC
\`\`\`

**Peak hours by order count:**
\`\`\`sql
SELECT f.hour, COUNT(*) AS order_count
FROM newdeli.facts f
WHERE f.status = '2'
GROUP BY f.hour
ORDER BY f.hour
\`\`\`

**Average order value by company:**
\`\`\`sql
SELECT b.company, ROUND(AVG(f.order_revenue)::numeric, 2) AS avg_order_value, COUNT(*) AS order_count
FROM newdeli.facts f
JOIN newdeli.branches b ON f.branch_id = b.branch_id
WHERE f.status = '2'
GROUP BY b.company
ORDER BY avg_order_value DESC
\`\`\``;
    }

    if (schemaName === 'zer4u') {
      return `
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
- \`${schemaName}.mv_sales_by_store\` — per-store totals (all-time)
- \`${schemaName}.mv_sales_by_store_month\` — store + month breakdown
- \`${schemaName}.mv_sales_by_product\` — per-product totals (ALL-TIME only, NO date column — do NOT use when year/period is specified)
- \`${schemaName}.mv_sales_by_product_month\` — product + month breakdown (USE THIS for year/period-filtered product queries like "top products this year")
- \`${schemaName}.mv_sales_by_store_product\` — store + product all-time (USE THIS for top-N products per store)
- \`${schemaName}.mv_sales_by_customer\` — per-customer totals (all-time)
- \`${schemaName}.mv_sales_by_city\` — sales by customer city (USE THIS for geographic/city revenue breakdown)
- \`${schemaName}.mv_sales_by_day\` — daily totals (last 90 days)`;
    }

    return '';
  }

  /**
   * Build the anti-patterns section from slow query records.
   * Returns empty string if no relevant queries.
   * @private
   */
  _buildAntiPatternsSection(antiPatterns) {
    if (!antiPatterns || antiPatterns.length === 0) return '';

    const examples = antiPatterns
      .filter(q => q.sql && q.sql.trim().length > 10)
      .slice(0, 8)
      .map(q => {
        const label = q.query_type === 'timeout'
          ? `TIMEOUT (${q.duration_ms}ms)`
          : q.query_type === 'error'
            ? `ERROR: ${(q.error_message || 'unknown').slice(0, 80)}`
            : `SLOW (${q.duration_ms}ms)`;
        const question = q.question ? `Question: "${q.question.slice(0, 100)}"` : '';
        return `-- ${label}${question ? '\n-- ' + question : ''}\n${q.sql.slice(0, 400)}`;
      });

    if (examples.length === 0) return '';

    return `

## AVOID — Known Problem Queries

The following queries caused timeouts or errors in production. Study them and do NOT reproduce their patterns:

\`\`\`sql
${examples.join('\n\n')}
\`\`\`

**Key anti-patterns to avoid:**
- \`TO_DATE(col, 'DD/MM/YYYY')\` — \`sale_date\` is already a DATE column, use it directly
- Hebrew column names (\`"קוד פריט SALES"\`, \`"שם פריט"\`, \`"מכירה ללא מעמ"\`) — use the English names: \`item_code\`, \`item_name\`, \`revenue\`
- Scanning raw \`inventory\` or \`min_inventory\` tables for item-level data — use \`mv_inventory_by_item\` instead
- Counting customers this month via \`mv_sales_by_customer\` — use \`mv_sales_by_month.customer_count\` instead`;
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
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      }

      // Extract the first complete JSON object even if Claude appended extra text
      let parsed;
      try {
        parsed = JSON.parse(cleanResponse);
      } catch {
        const jsonStr = this._extractFirstJSON(cleanResponse);
        if (!jsonStr) throw new Error('No JSON object found in response');
        parsed = JSON.parse(jsonStr);
      }

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

  /** @private — returns the first complete JSON object in text, or null */
  _extractFirstJSON(text) {
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (text[i] === '}') {
        depth--;
        if (depth === 0 && start !== -1) return text.slice(start, i + 1);
      }
    }
    return null;
  }

}

module.exports = new SQLGeneratorService();
