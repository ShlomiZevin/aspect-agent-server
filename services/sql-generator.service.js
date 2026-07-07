const llmService = require('./llm');
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
   * @param {string} options.agentName - Agent name for usage logging
   * @param {string} options.conversationId - Conversation ID for usage logging
   * @param {number|string} options.userId - User ID for usage logging
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
      let userMessage = this._buildUserMessage(question);

      // Self-correction: if a previous attempt failed when executed, feed the exact
      // PostgreSQL error + the failing SQL back so the model fixes that specific problem.
      if (options.previousError) {
        userMessage += `\n\nIMPORTANT — your previous query FAILED when executed against PostgreSQL. Return a corrected query that fixes this exact error.\n\nPrevious SQL:\n${options.previousSql || ''}\n\nDatabase error:\n${options.previousError}\n\nCommon fixes: qualify ambiguous columns with their table alias; cast TEXT numeric columns as NULLIF(col::text,'')::numeric before SUM/arithmetic; never reference a non-ASCII (Hebrew) column directly — use a materialized view's column instead; wrap every division denominator in NULLIF(x,0); when using GROUP BY, wrap measures in SUM(...). If the requested data genuinely does not exist in the schema, return a query that selects zero rows (e.g. WHERE false) rather than referencing a missing column.`;
      }

      console.log(`   Calling Claude to generate SQL (${antiPatterns.length} anti-patterns loaded)...`);

      // Step 3: Call Claude via central router so usage is logged
      const response = await llmService.sendOneShot(
        systemPrompt,
        userMessage,
        {
          model: 'claude-sonnet-4-6',
          maxTokens: 4096,
          jsonOutput: true,
          context: 'sql_generation',
          agentName: options.agentName,
          conversationId: options.conversationId,
          userId: options.userId,
        }
      );

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
8. **Limits**: Add a LIMIT ONLY when the user explicitly asked for a specific count ("top 10", "the 5 highest", "first 20"). For "all", "every", "the full list", "don't limit", or any plain unqualified listing question — DO NOT add a LIMIT yourself, no matter how large the table is (not even a "safety" LIMIT 500/1000/5000). This applies even to the biggest tables listed below. The application enforces its own upstream safety cap after your query runs, so row count is never your problem to solve — a query with no LIMIT clause at all is the CORRECT answer for these questions, not a risk to protect against.
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
   * Keeps zer4u, newdeli, thestock and hypertoy rules separate — no cross-contamination.
   * @private
   */
  _getSchemaSpecificRules(schemaName) {
    if (schemaName === 'hypertoy') {
      return `
## hypertoy-Specific Rules (CRITICAL — follow exactly)

**Tables**: facts (~1.97M wide, mixed record types), payments (~670K), pay_accounts (~726K), credits (~38K), customers (~128K), products (~60K), warehouses (50), stores (96), inventory_500 (~3K), calendar (346), calendar_compare (346)

### RULE 1 — facts is a WIDE table mixing 3 record types — ALWAYS filter
The \`facts\` table mixes three kinds of records. NEVER aggregate without filtering by \`record_type\`:
- \`record_type = 'מכירות'\` (sales transactions) — use for revenue, qty sold, profit, customer analysis
- \`record_type = 'מלאי'\` (inventory snapshots) — use \`inventory_balance\`, \`inventory_value\`
- \`record_type = 'יעדים'\` (targets) — use \`sales_target\`, \`loyalty_target\`

Default for any sales/revenue/profit question: \`WHERE record_type = 'מכירות'\`.

### RULE 2 — Use transaction_date for time filters
\`facts.transaction_date\` is a DATE column. Filter examples:
- This year: \`transaction_date >= DATE_TRUNC('year', CURRENT_DATE)\`
- This month: \`transaction_date >= DATE_TRUNC('month', CURRENT_DATE)\`
- Specific year: \`EXTRACT(YEAR FROM transaction_date) = 2025\`
- Combine with record_type filter: \`WHERE record_type = 'מכירות' AND transaction_date >= '2025-01-01'\`

### RULE 3 — Always include record_type filter even for COUNT
A bare \`SELECT COUNT(*) FROM hypertoy.facts\` returns the mixed count (sales + inventory + targets) and is misleading. Always specify the record_type.

### RULE 3.5 — NEVER use COUNT(DISTINCT transaction_id) over the entire facts table
\`facts\` has ~1.97M rows. \`COUNT(DISTINCT transaction_id)\` on the full table without a narrow date filter times out at 15s. Each row in facts already represents one transaction line — use \`COUNT(*)\` (lines) instead of \`COUNT(DISTINCT transaction_id)\` (transactions) for top-N / per-store / per-cashier reports. If you specifically need transaction counts, narrow with \`transaction_date >= ...\` first.
- WRONG (times out): \`SELECT warehouse_code, COUNT(DISTINCT transaction_id), SUM(sales_ex_vat) FROM hypertoy.facts WHERE record_type='מכירות' GROUP BY warehouse_code\`
- CORRECT: \`SELECT warehouse_code, COUNT(*) AS line_count, SUM(sales_ex_vat) FROM hypertoy.facts WHERE record_type='מכירות' GROUP BY warehouse_code\`

### RULE 3.6 — Customer-count defaults
"How many customers" / "total customers" should default to \`SELECT COUNT(*) FROM hypertoy.customers\` (registered customer master). Use \`COUNT(DISTINCT customer_id) FROM hypertoy.facts WHERE record_type='מכירות' AND customer_id IS NOT NULL AND customer_id <> ''\` ONLY when the user explicitly asks about active / purchasing / buying customers.

### RULE 3.7 — Franchisee attribution
The columns \`facts.franchisee_code\` and \`facts.franchisee_name\` are EMPTY (NULL) in this dataset — do NOT GROUP BY them. Sister-brand and franchisee attribution is encoded in \`facts.register_name\` (קופה — e.g. 'קופת סניף פיראט אילת') and the corresponding \`facts.warehouse_code\` → \`warehouses.warehouse_name\` (e.g. 'פיראט סינימה'). For franchisee questions, group by \`warehouse_code\` joined to \`warehouses.warehouse_name\` and detect sister brand by string match on the warehouse name (e.g. \`warehouse_name LIKE '%פיראט%'\`).

### RULE 3.8 — ANY "this month vs last month" comparison mid-month needs PACE-adjustment, not raw totals
This applies broadly — target-vs-actual, WOLT growth, club growth, any "this month compared to last month" question — not just targets. If today is not the last day of the month, "this month" is a PARTIAL period (e.g. 7 of 31 days) while "last month" in the data is a COMPLETE period. Comparing a partial-month total against a full-month total will show a "decline" almost everywhere even when the branch/metric is doing FINE — that is a methodology artifact, not a real finding, and answering "no growth anywhere" from that comparison is WRONG.
Fix it one of two ways:
1. **Equivalent-days comparison (preferred for "vs last month" questions):** compare the SAME day-of-month range in both periods — e.g. \`transaction_date BETWEEN DATE_TRUNC('month', CURRENT_DATE) AND CURRENT_DATE\` (this month to date) vs \`transaction_date BETWEEN DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month' AND DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month' + (CURRENT_DATE - DATE_TRUNC('month', CURRENT_DATE))\` (the first N days of last month, same N).
2. **Proration (for target vs actual):**
\`\`\`sql
sales_target * EXTRACT(DAY FROM CURRENT_DATE)
  / EXTRACT(DAY FROM (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')) AS prorated_target
\`\`\`
Do NOT invent an arbitrary cutoff like "below 80% of the full target" — that is a business decision for the client to set, not something to assume. Rank/sort by the pace gap and let the numbers speak for themselves. If a fair (equivalent-days or prorated) comparison genuinely shows no growth anywhere, that's a real answer — but reaching it via a partial-vs-full-month comparison is not.

### RULE 4 — JOINs
- Products: \`JOIN hypertoy.products p ON f.part = p.part\`
- Warehouses: \`JOIN hypertoy.warehouses w ON f.warehouse_code = w.warehouse_code\`
- Stores (better attribution): \`JOIN hypertoy.stores s ON f.warehouse_code = s.store_id\` (warehouse_code on facts often matches store_id)
- Payments: \`JOIN hypertoy.payments pay ON f.transaction_id = pay.transaction_id\`
- Customers: \`JOIN hypertoy.customers c ON f.customer_id = c.customer_id\`

### RULE 4.5 — Payment-type filtering (IMPORTANT data quirk)
\`payments.payment_type_code\` is a stable NUMERIC code; \`payments.payment_type\` is the name. Some Latin-script payment names are stored CHARACTER-REVERSED in the data (a source RTL/visual-order artifact): e.g. "BUYME" is stored as 'EMYUB', "IS Visa Cal" as 'laC asiVSI', "IS Mastercard" as 'dracretsaMSI'. Hebrew names (e.g. 'פרקסל', 'מזומן') are stored correctly.
- When the user filters by a LATIN-script payment method, the plain spelling matches NOTHING. Filter by the numeric \`payment_type_code\` instead (preferred), or match the reversed spelling.
- Known codes: 'פרקסל' (Praxell) = 30, "BUYME" = 45, 'מזומן' (cash) = 1. For other Latin names, prefer \`payment_type_code\`.
- Always also SELECT \`payment_type_code\` and \`payment_type\` so the result is unambiguous.

### RULE 4.6 — "מועדון" has TWO distinct meanings here — never use \`customer_id IS NOT NULL\` for either
NEVER use \`facts.customer_id IS NOT NULL\` as a stand-in for loyalty/club membership — virtually every row in \`facts\` already has a non-null \`customer_id\`, so that condition is always true and produces a meaningless, degenerate 0%-or-100%-everywhere result. There are two different questions that both use the word "מועדון" — pick the right one:
1. **"Which מועדון/club drove growth" — a specific named partner club, categorical** (e.g. "פרקסל" (Praxell), "הייטקזון" (Hi-TechZone)): this means \`hypertoy.payments.payment_type\`. JOIN \`facts\` to \`payments\` on \`transaction_id\`, GROUP BY \`payment_type\` (and \`payment_type_code\` per RULE 4.5, since some names are character-reversed). "Which club drove the most growth" = compare SUM(sales) per payment_type between two periods, per warehouse/branch.
2. **"לקוחות מועדון" / "club member conversion rate" — is a customer a loyalty-program member at all** (not which partner club): use \`facts.loyalty_count > 0\` on the transaction as the loyalty-engagement signal. "Club conversion rate at a branch" = COUNT(transactions WHERE loyalty_count > 0) ÷ COUNT(all transactions) at that branch, or the equivalent on revenue. When comparing branches by conversion rate, ALSO include each branch's average transaction value (SUM(sales_ex_vat) / COUNT(*)) and total revenue/turnover — a conversion-rate ranking without these is only half the requested comparison.
If genuinely unsure which of the two the user means, prefer whichever produces a non-degenerate (varying, not flat 0%/100% everywhere) result — a flat result across every branch is itself a signal you picked the wrong field, so try the other one before answering.

### RULE 5 — Profit / margin metrics
- Profit fields are already calculated: \`profit_ex_vat\`, \`profit_inc_vat\`
- Cost fields: \`cost_ex_vat\`, \`cost_inc_vat\`, \`COSTT\` (column name \`costt\`)
- Margin % = SUM(profit_ex_vat) / NULLIF(SUM(sales_ex_vat), 0) * 100

### RULE 6 — Cross-brand cost analysis (products only)
\`products\` has three cost columns side by side:
- \`standard_cost_ils\` — Hyper Toy cost (the brand the agent represents)
- \`standard_cost_ils_thestock\` — sister brand The Stock cost
- \`standard_cost_ils_pirat\` — sister brand Pirat cost
- \`cost_difference\` — pre-computed gap

**CRITICAL — always filter out 0/NULL costs on BOTH sides being compared.** Many products are sold by only one of the three brands, so the missing brand's cost is 0 or NULL and produces a meaningless "gap". For "biggest cost gaps between Hyper Toy and The Stock", the query MUST include \`WHERE standard_cost_ils > 0 AND standard_cost_ils_thestock > 0\`. For Pirat: \`WHERE standard_cost_ils > 0 AND standard_cost_ils_pirat > 0\`. For "biggest gap across all three sister brands": \`WHERE standard_cost_ils > 0 AND standard_cost_ils_thestock > 0 AND standard_cost_ils_pirat > 0\`. Without this filter the top rows are always products one brand doesn't carry — useless to the user.

Reference query for "biggest cost gaps between Hyper Toy and The Stock / Pirat":
\`\`\`sql
SELECT sku, item_description,
       standard_cost_ils       AS hypertoy_cost,
       standard_cost_ils_thestock AS thestock_cost,
       standard_cost_ils_pirat AS pirat_cost,
       GREATEST(standard_cost_ils, standard_cost_ils_thestock, standard_cost_ils_pirat)
         - LEAST(standard_cost_ils, standard_cost_ils_thestock, standard_cost_ils_pirat) AS cost_gap
FROM hypertoy.products
WHERE standard_cost_ils > 0
  AND standard_cost_ils_thestock > 0
  AND standard_cost_ils_pirat > 0
ORDER BY cost_gap DESC
LIMIT 20
\`\`\`

### Reference examples

**Total revenue this month:**
\`\`\`sql
SELECT SUM(sales_ex_vat) AS revenue, SUM(profit_ex_vat) AS profit, COUNT(*) AS line_count
FROM hypertoy.facts
WHERE record_type = 'מכירות'
  AND transaction_date >= DATE_TRUNC('month', CURRENT_DATE)
\`\`\`

**Top 10 selling products by quantity this year:**
\`\`\`sql
SELECT p.sku, p.item_description, p.family_description,
       SUM(f.qty_sold) AS qty, SUM(f.sales_ex_vat) AS revenue, SUM(f.profit_ex_vat) AS profit
FROM hypertoy.facts f
JOIN hypertoy.products p ON f.part = p.part
WHERE f.record_type = 'מכירות'
  AND EXTRACT(YEAR FROM f.transaction_date) = EXTRACT(YEAR FROM CURRENT_DATE)
GROUP BY p.sku, p.item_description, p.family_description
ORDER BY qty DESC
LIMIT 10
\`\`\`

**Top stores by revenue:**
\`\`\`sql
SELECT f.warehouse_code, w.warehouse_name, w.branch_name,
       SUM(f.sales_ex_vat) AS revenue
FROM hypertoy.facts f
LEFT JOIN hypertoy.warehouses w ON f.warehouse_code = w.warehouse_code
WHERE f.record_type = 'מכירות'
GROUP BY f.warehouse_code, w.warehouse_name, w.branch_name
ORDER BY revenue DESC
LIMIT 10
\`\`\`

**Profit margin by product family:**
\`\`\`sql
SELECT p.family_description,
       SUM(f.sales_ex_vat) AS revenue,
       SUM(f.profit_ex_vat) AS profit,
       ROUND((SUM(f.profit_ex_vat) / NULLIF(SUM(f.sales_ex_vat), 0) * 100)::numeric, 2) AS margin_pct
FROM hypertoy.facts f
JOIN hypertoy.products p ON f.part = p.part
WHERE f.record_type = 'מכירות'
GROUP BY p.family_description
ORDER BY revenue DESC
LIMIT 20
\`\`\`

**Sales targets vs actual (use two CTEs + FULL OUTER JOIN, NOT correlated subquery):**
\`\`\`sql
-- Correlated subqueries re-scan facts for each target row and time out.
-- Aggregate targets and actuals separately, then FULL OUTER JOIN on (month, warehouse_code).
WITH targets AS (
  SELECT DATE_TRUNC('month', transaction_date) AS month, warehouse_code,
         SUM(sales_target) AS target
  FROM hypertoy.facts
  WHERE record_type = 'יעדים'
    AND transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY 1, 2
),
actuals AS (
  SELECT DATE_TRUNC('month', transaction_date) AS month, warehouse_code,
         SUM(sales_ex_vat) AS actual
  FROM hypertoy.facts
  WHERE record_type = 'מכירות'
    AND transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY 1, 2
)
SELECT COALESCE(t.month, a.month)                    AS month,
       COALESCE(t.warehouse_code, a.warehouse_code)  AS warehouse_code,
       t.target, a.actual,
       (a.actual - t.target)                          AS variance
FROM targets t
FULL OUTER JOIN actuals a USING (month, warehouse_code)
ORDER BY month DESC, warehouse_code
LIMIT 50
\`\`\`

**Top cashiers by revenue:**
\`\`\`sql
SELECT cashier, COUNT(DISTINCT transaction_id) AS transactions, SUM(sales_ex_vat) AS revenue
FROM hypertoy.facts
WHERE record_type = 'מכירות' AND cashier IS NOT NULL AND cashier <> ''
GROUP BY cashier
ORDER BY revenue DESC
LIMIT 10
\`\`\``;
    }

    if (schemaName === 'thestock') {
      return `
## thestock-Specific Rules (CRITICAL — follow exactly)

**Tables**:
- \`facts\` (~40M rows, wide table mixing sales / inventory / targets / purchase orders)
- \`payments\` (~9.8M), \`credits\` (~158K), \`customers\` (~1.07M), \`products\` (~61K)
- \`warehouses\` (168), \`inventory_c100\` (~901K), \`calendar\` (868), \`calendar_compare\` (868)

**Materialized views (PRE-AGGREGATED — use these for top-N / revenue questions):**
- \`mv_sales_daily\` — (transaction_date, line_count, total_qty, revenue_ex_vat, revenue_inc_vat, loyalty_count). ~1,800 rows. Use for "total revenue / sales by period / daily trend".
- \`mv_sales_daily_sku\` — (transaction_date, sku, total_qty, revenue_ex_vat, revenue_inc_vat, line_count). ~5-10M rows. Use for "top selling products by period".
- \`mv_sales_daily_store\` — (transaction_date, warehouse_code, total_qty, revenue_ex_vat, revenue_inc_vat, line_count). ~300K rows. Use for "top stores by period".
- \`mv_sales_daily_cashier\` — (transaction_date, cashier, total_qty, revenue_ex_vat, revenue_inc_vat, line_count). ~900K rows. Use for "top cashiers by period".

### RULE 0 — Sales aggregations MUST use materialized views (CRITICAL)
\`facts\` has 40M rows on a small DB tier. Aggregating it directly for "top products", "top stores", "top cashiers", "revenue this year/month" times out at 15s. ALWAYS use the relevant MV instead:

| Question pattern | MV to use |
|---|---|
| "total revenue / sales this year/month/week" | \`mv_sales_daily\` |
| "top N products / best selling products" | \`mv_sales_daily_sku\` then JOIN to \`products\` |
| "top N stores / branches by sales" | \`mv_sales_daily_store\` then JOIN to \`warehouses\` |
| "top N cashiers by sales" | \`mv_sales_daily_cashier\` |
| "daily / monthly trend of sales" | \`mv_sales_daily\` |

MVs already filter \`record_type='מכירות'\` and drop NULL keys — DO NOT add those filters when querying MVs. Use \`transaction_date >= ... AND transaction_date < ...\` for time windows.

Query \`facts\` directly ONLY for:
- Customer-level analysis (\`customer_id\`) — not in MVs
- Specific transaction lookup (\`transaction_id\`)
- Inventory queries (\`record_type='מלאי'\`) — not in MVs
- Target queries (\`record_type='יעדים'\`) — not in MVs

### RULE 1 — facts is a WIDE table mixing record types — ALWAYS filter
The \`facts\` table mixes four kinds of records. NEVER aggregate without filtering by \`record_type\`:
- \`record_type = 'מכירות'\` (sales transactions) — use for revenue, qty sold, customer analysis. Filled columns: \`transaction_date\`, \`transaction_id\`, \`sku\`, \`customer_id\`, \`cashier\`, \`register_number\`, \`register_name\`, \`sale_price\`, \`qty_sold\`, \`sales_ex_vat\`, \`sales_inc_vat\`, \`vat_pct\`
- \`record_type = 'מלאי'\` (inventory snapshots) — use \`inventory_balance\`, \`inventory_value\`, \`c100_inventory\`, \`warehouse_code\`
- \`record_type = 'יעדים'\` (targets) — use \`sales_target\`, \`loyalty_target\`
- \`record_type IS NULL\` AND \`purchase_order IS NOT NULL\` (purchase order lines) — use \`order_qty\`, \`unit_price\`, \`total_price\`, \`order_status\`

Default for any sales/revenue question: \`WHERE record_type = 'מכירות'\`.

### RULE 2 — Use transaction_date for time filters (sargable!)
\`facts.transaction_date\` is a DATE column with a composite index \`(record_type, transaction_date)\`. NEVER wrap it in EXTRACT/DATE_PART/TO_CHAR in the WHERE clause — that disables the index and forces a full scan of 40M rows.
- This year (CORRECT): \`transaction_date >= DATE_TRUNC('year', CURRENT_DATE) AND transaction_date < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'\`
- This month (CORRECT): \`transaction_date >= DATE_TRUNC('month', CURRENT_DATE) AND transaction_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'\`
- Specific year (CORRECT): \`transaction_date >= '2025-01-01' AND transaction_date < '2026-01-01'\`
- WRONG (full scan, will time out): \`EXTRACT(YEAR FROM transaction_date) = 2025\`
- Always combine with record_type filter: \`WHERE record_type = 'מכירות' AND transaction_date >= '2025-01-01' AND transaction_date < '2026-01-01'\`

### RULE 3 — NEVER use COUNT(DISTINCT transaction_id) over the entire facts table
\`facts\` has ~100M rows. \`COUNT(DISTINCT transaction_id)\` on the full table without a narrow date filter times out. Each row in facts already represents one transaction line — use \`COUNT(*)\` (lines) instead of \`COUNT(DISTINCT transaction_id)\` (transactions) for top-N / per-store / per-cashier reports.
- WRONG (times out): \`SELECT warehouse_code, COUNT(DISTINCT transaction_id), SUM(sales_ex_vat) FROM thestock.facts WHERE record_type='מכירות' GROUP BY warehouse_code\`
- CORRECT: \`SELECT warehouse_code, COUNT(*) AS line_count, SUM(sales_ex_vat) FROM thestock.facts WHERE record_type='מכירות' GROUP BY warehouse_code\`

### RULE 3.5 — Customer-count defaults
"How many customers" / "total customers" should default to \`SELECT COUNT(*) FROM thestock.customers\` (registered customer master). Use \`COUNT(DISTINCT customer_id) FROM thestock.facts WHERE record_type='מכירות' AND customer_id IS NOT NULL AND customer_id <> ''\` ONLY when the user explicitly asks about active / purchasing / buying customers AND narrow with a date filter.

### RULE 4 — JOINs
- Products: \`JOIN thestock.products p ON f.sku = p.sku\` (Stock facts uses SKU, NOT part)
- Warehouses: \`JOIN thestock.warehouses w ON f.warehouse_code = w.warehouse_code\`
- Payments: \`JOIN thestock.payments pay ON f.transaction_id = pay.transaction_id\` (payments has NO date — get date from facts)
- Credits: \`JOIN thestock.credits c ON p.transaction_id = c.transaction_id\`
- Inventory C100: \`JOIN thestock.inventory_c100 i ON i.sku = p.sku\`

### RULE 5 — Profit / margin require a JOIN to products
Unlike Hyper Toy, \`thestock.facts\` does NOT carry cost or profit columns. To compute margin:
- Revenue: \`SUM(f.sales_ex_vat)\` from facts
- Cost: \`SUM(f.qty_sold * p.standard_cost_ils)\` — JOIN to products and multiply by quantity
- Margin %: \`(SUM(f.sales_ex_vat) - SUM(f.qty_sold * p.standard_cost_ils)) / NULLIF(SUM(f.sales_ex_vat), 0) * 100\`

### RULE 6 — Cross-brand cost (products only)
\`products\` has BOTH The Stock cost (\`standard_cost_ils\`) and the sister brand Hyper Toy cost (\`standard_cost_ils_hypertoy\`). Pre-computed gap in \`cost_difference\`.

**CRITICAL — always filter out 0/NULL on BOTH sides being compared.** Products sold by only one brand have 0 cost on the other side, producing meaningless "gaps". For "biggest cost gaps Stock vs Hyper Toy": \`WHERE standard_cost_ils > 0 AND standard_cost_ils_hypertoy > 0\`.

### RULE 7 — Aggregate or LIMIT on large tables, UNLESS the user explicitly asked for "all"/"every"/"the full list"
\`facts\` (40M), \`payments\` (9.8M), \`customers\` (1.07M), \`inventory_c100\` (901K) are huge — for open-ended analytical questions (revenue, trends, breakdowns) aggregate or add your own LIMIT so you don't scan the whole table row-by-row for no reason. But if the user explicitly asked to list all/every row (e.g. "list all customers", "give me the full customer list") — do NOT add a LIMIT; see the global Limits rule above, it overrides this one for that case.

### RULE 8 — Pre-aggregate before JOIN for top-N queries (CRITICAL)
For any "top-N products / stores / cashiers / customers" question, do NOT JOIN \`facts\` to a dimension table inside the GROUP BY. The 15-second query timeout will fire because the JOIN materializes millions of intermediate rows.

Correct pattern: aggregate facts in a CTE first (using only the composite index, no JOIN), then LEFT JOIN the small top-N result to the dimension table afterwards. See the "Top 10 selling products" reference example below.

Rule of thumb: the GROUP BY must touch ONLY facts columns. Bring in dimension descriptions in an outer SELECT against the already-aggregated 10 rows.

### RULE 9 — ALL aggregations on facts MUST include a date range (CRITICAL)
Never aggregate over the full 40M-row \`facts\` table without a date filter. Even simple GROUP BY queries time out without one. Always include a sargable \`transaction_date >= ... AND transaction_date < ...\` predicate. When the user asks an open-ended question ("top cashiers", "best stores"), default the date range to the current year:
- \`transaction_date >= DATE_TRUNC('year', CURRENT_DATE) AND transaction_date < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'\`

WRONG (full table scan, will time out): \`SELECT cashier, SUM(sales_ex_vat) FROM thestock.facts WHERE record_type='מכירות' GROUP BY cashier ORDER BY ... LIMIT 10\`
CORRECT: add the date range filter shown above.

### RULE 10 — Refunds / credits / discounts come from the credits table, NOT payments
The \`thestock.credits\` table is the source of truth for refund/credit/discount summaries. Columns: \`credit_issued\`, \`cash_credit\`, \`card_credit\`, \`employee_discount\`, \`special_discount\` (all NUMERIC, ~158K rows).

Do NOT try to derive refunds from \`payments\` using \`payment_type ILIKE '%זיכוי%'\` or \`amount < 0\`. The payments table has 9.8M rows and ILIKE on Hebrew text is slow; credits has it all pre-classified.

Example (refund summary):
\`\`\`sql
SELECT
  SUM(credit_issued)     AS total_credit_issued,
  SUM(cash_credit)       AS total_cash_credit,
  SUM(card_credit)       AS total_card_credit,
  SUM(employee_discount) AS total_employee_discount,
  SUM(special_discount)  AS total_special_discount,
  COUNT(*)               AS transaction_count
FROM thestock.credits
\`\`\`

### RULE 11 — Targets vs actual: use FULL JOIN of two CTEs, not correlated subqueries
Correlated subqueries that re-scan facts per row time out. Aggregate targets and actuals separately, then FULL OUTER JOIN on the grouping keys.

\`\`\`sql
WITH targets AS (
  SELECT DATE_TRUNC('month', transaction_date) AS month, warehouse_code,
         SUM(sales_target) AS target
  FROM thestock.facts
  WHERE record_type = 'יעדים'
    AND transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY 1, 2
),
actuals AS (
  SELECT DATE_TRUNC('month', transaction_date) AS month, warehouse_code,
         SUM(sales_ex_vat) AS actual
  FROM thestock.facts
  WHERE record_type = 'מכירות'
    AND transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY 1, 2
)
SELECT COALESCE(t.month, a.month) AS month,
       COALESCE(t.warehouse_code, a.warehouse_code) AS warehouse_code,
       t.target, a.actual,
       (a.actual - t.target) AS variance
FROM targets t
FULL OUTER JOIN actuals a USING (month, warehouse_code)
ORDER BY month DESC, warehouse_code
LIMIT 50
\`\`\`

### Reference examples

**Total revenue this year (via mv_sales_daily — instant):**
\`\`\`sql
SELECT SUM(revenue_ex_vat) AS revenue,
       SUM(revenue_inc_vat) AS revenue_inc_vat,
       SUM(line_count)      AS line_count
FROM thestock.mv_sales_daily
WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
  AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
\`\`\`

**Top 10 selling products this year (via mv_sales_daily_sku — instant):**
\`\`\`sql
WITH top_skus AS (
  SELECT sku,
         SUM(total_qty)      AS qty,
         SUM(revenue_ex_vat) AS revenue
  FROM thestock.mv_sales_daily_sku
  WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY sku
  ORDER BY revenue DESC
  LIMIT 10
)
SELECT t.sku, p.item_description, p.family_description,
       t.qty, t.revenue,
       (t.qty * p.standard_cost_ils)                          AS cost,
       (t.revenue - t.qty * p.standard_cost_ils)              AS profit,
       ROUND(((t.revenue - t.qty * p.standard_cost_ils)
              / NULLIF(t.revenue, 0) * 100)::numeric, 2)      AS margin_pct
FROM top_skus t
LEFT JOIN thestock.products p ON p.sku = t.sku
ORDER BY t.revenue DESC
\`\`\`

**Top 10 stores by revenue this year (via mv_sales_daily_store — instant):**
\`\`\`sql
WITH top_stores AS (
  SELECT warehouse_code,
         SUM(revenue_ex_vat) AS revenue,
         SUM(line_count)     AS line_count
  FROM thestock.mv_sales_daily_store
  WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY warehouse_code
  ORDER BY revenue DESC
  LIMIT 10
)
SELECT t.warehouse_code, w.warehouse_name, w.branch_name, t.revenue, t.line_count
FROM top_stores t
LEFT JOIN thestock.warehouses w ON w.warehouse_code = t.warehouse_code
ORDER BY t.revenue DESC
\`\`\`

**Top 10 cashiers by revenue this year (via mv_sales_daily_cashier — instant):**
\`\`\`sql
SELECT cashier, SUM(revenue_ex_vat) AS revenue, SUM(line_count) AS line_count
FROM thestock.mv_sales_daily_cashier
WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
  AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
GROUP BY cashier
ORDER BY revenue DESC
LIMIT 10
\`\`\`

**Profit margin this year (mv + JOIN to products for cost):**
\`\`\`sql
WITH agg AS (
  SELECT sku, SUM(total_qty) AS qty, SUM(revenue_ex_vat) AS revenue
  FROM thestock.mv_sales_daily_sku
  WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY sku
)
SELECT SUM(a.revenue)                                  AS revenue,
       SUM(a.qty * p.standard_cost_ils)                AS cost,
       SUM(a.revenue - a.qty * p.standard_cost_ils)    AS profit,
       ROUND((SUM(a.revenue - a.qty * p.standard_cost_ils)
              / NULLIF(SUM(a.revenue), 0) * 100)::numeric, 2) AS margin_pct
FROM agg a
JOIN thestock.products p ON p.sku = a.sku
\`\`\`

**Sales targets vs actual by month (targets from facts, actuals from mv):**
\`\`\`sql
WITH targets AS (
  SELECT DATE_TRUNC('month', transaction_date) AS month, warehouse_code,
         SUM(sales_target) AS target
  FROM thestock.facts
  WHERE record_type = 'יעדים'
    AND transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY 1, 2
),
actuals AS (
  SELECT DATE_TRUNC('month', transaction_date) AS month, warehouse_code,
         SUM(revenue_ex_vat) AS actual
  FROM thestock.mv_sales_daily_store
  WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY 1, 2
)
SELECT COALESCE(t.month, a.month)                   AS month,
       COALESCE(t.warehouse_code, a.warehouse_code) AS warehouse_code,
       t.target, a.actual,
       (a.actual - t.target)                         AS variance
FROM targets t
FULL OUTER JOIN actuals a USING (month, warehouse_code)
ORDER BY month DESC, warehouse_code
LIMIT 50
\`\`\`

**Payment-method totals:**
\`\`\`sql
SELECT payment_type, SUM(amount) AS total_amount, COUNT(*) AS line_count
FROM thestock.payments
GROUP BY payment_type
ORDER BY total_amount DESC
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

**Largest cost gaps vs Hyper Toy:**
\`\`\`sql
SELECT sku, item_description, standard_cost_ils, standard_cost_ils_hypertoy,
       ROUND(ABS(standard_cost_ils - standard_cost_ils_hypertoy)::numeric, 2) AS gap
FROM thestock.products
WHERE standard_cost_ils > 0 AND standard_cost_ils_hypertoy > 0
ORDER BY gap DESC
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
    - \`cost\` is NUMERIC (excl VAT) — use directly: \`SUM(s.cost)\`
    - \`quantity\` is NUMERIC — use directly: \`SUM(s.quantity)\`
    - \`item_code\` is TEXT — join with: \`ON s.item_code = i.item_code\`
10. **Revenue / total sales (פדיון) — ALWAYS via materialized views**: the BI revenue measure lives in a sales column whose name contains non-ASCII (Hebrew) characters that CANNOT be typed reliably — writing it directly fails with "column does not exist". NEVER reference the raw revenue column in SQL. ALWAYS read revenue from a materialized view's \`total_revenue\` (every MV computes it from that column and is BI-correct). The plain \`revenue\` column excludes vouchers and under-reports — do not use it either. If a revenue breakdown is not covered by any MV listed below, tell the user the data is not available at that granularity rather than querying the sales table for revenue. (\`cost\` IS a normal ASCII column on \`sales\` and may be used directly for cost/profit by item.)
11. **VAT (מע"מ)** — all monetary figures are EXCLUDING VAT (ללא מע"מ); that is the business standard. There is NO VAT-inclusive sale column — do NOT invent one or multiply by a hardcoded rate. \`"אחוז מעם לתעודה"\` holds the per-document VAT %, only if a VAT-inclusive figure is ever explicitly requested.
12. **Transactions / number of receipts (כמות עסקאות) — must match the BI**: NEVER use \`COUNT(*)\` on sales (that counts line items, ~2.7x too high). Use the materialized views' \`transaction_count\` (already BI-correct). For ad-hoc counts on the sales table, count distinct receipts EXCLUDING tax-invoices (חשבונית חיוב), which are listed in \`${schemaName}.hesbonithiuvi\`:
    \`COUNT(DISTINCT s."UniqueInvoiceKey") FILTER (WHERE h."UniqueInvoiceKey" IS NULL) - COUNT(DISTINCT s."UniqueInvoiceKey") FILTER (WHERE h."UniqueInvoiceKey" IS NOT NULL)\` with \`LEFT JOIN ${schemaName}.hesbonithiuvi h ON h."UniqueInvoiceKey" = s."UniqueInvoiceKey"\`.
13. **Date Intervals**: Use standard PostgreSQL date arithmetic:
    - Last 6 months: \`WHERE s.sale_date >= CURRENT_DATE - INTERVAL '6 months'\`
    - Specific month: \`WHERE TO_CHAR(s.sale_date, 'YYYY-MM') = '2025-03'\`
    - Group by month: \`TO_CHAR(s.sale_date, 'YYYY-MM') AS month\`

14. **Aggregating materialized views**: every MV row is already a per-period aggregate. To total across periods you MUST aggregate the measures — use \`SUM(total_revenue)\`, \`SUM(transaction_count)\`, \`SUM(customer_count)\` — and \`GROUP BY\` only the dimensions you keep. NEVER put a bare MV measure (e.g. \`total_revenue\`, \`customer_count\`) in the SELECT or ORDER BY of a GROUP BY query without wrapping it in \`SUM(...)\`. For a single period number use \`SELECT SUM(total_revenue) FROM ${schemaName}.mv_sales_by_month WHERE sale_year = ...\`. (\`SUM(customer_count)\` across months is an approximation of yearly unique customers — say so.)
15. **Never divide by zero**: wrap EVERY division denominator in \`NULLIF(expr, 0)\` — e.g. \`x / NULLIF(y, 0)\`. Applies to all ratios (stock/sales, margins, pct-of-target).
16. **Targets / יעדים (performance vs target)**: the \`targets\` table has \`"TargetKey"\` = \`'<category>**<store_id>**<DD/MM/YYYY>'\` and \`"Target"\` (TEXT). EVERY \`"Target"\` value carries a trailing \`%\` (and other non-numeric chars) — you MUST strip them before casting: \`NULLIF(regexp_replace("Target", '[^0-9.-]', '', 'g'), '')::numeric\`. The date in the key is \`DD/MM/YYYY\` — parse it with \`TO_DATE(SPLIT_PART("TargetKey", '**', 3), 'DD/MM/YYYY')\`. There are several category rows per store+month, so SUM them. Join targets to actuals through \`mv_sales_by_store_month\` (NEVER the raw sales table). Reference query:
\`\`\`sql
SELECT sm.store_number, sm.store_name, sm.year_month,
       sm.total_revenue AS actual_revenue, tgt.target_amount,
       ROUND(sm.total_revenue / NULLIF(tgt.target_amount, 0) * 100, 2) AS pct_of_target
FROM ${schemaName}.mv_sales_by_store_month sm
JOIN (
  SELECT SPLIT_PART("TargetKey", '**', 2) AS store_id,
         TO_CHAR(TO_DATE(SPLIT_PART("TargetKey", '**', 3), 'DD/MM/YYYY'), 'YYYY-MM') AS year_month,
         SUM(NULLIF(regexp_replace("Target", '[^0-9.-]', '', 'g'), '')::numeric) AS target_amount
  FROM ${schemaName}.targets GROUP BY 1, 2
) tgt ON tgt.store_id = sm.store_number::text AND tgt.year_month = sm.year_month
WHERE sm.sale_year = EXTRACT(YEAR FROM CURRENT_DATE)::int
ORDER BY sm.year_month DESC, pct_of_target DESC
\`\`\`
17. **Inventory questions — use \`mv_inventory_by_item\`** (columns: \`item_code\`, \`item_name\`, \`total_stock\`, \`total_value\`, \`min_stock\`). The base \`inventory\` table has only \`InventoryKey\` + non-ASCII columns — never query it directly. \`mv_inventory_by_item\` is item-level across ALL stores; there is NO reliable per-store stock breakdown, so if a per-store split is requested, say it isn't available rather than guessing columns.
18. **Concepts the data does NOT support — answer in words, do NOT emit guessing SQL** (emitting SQL here only produces "column does not exist" / timeouts):
    - **Payment method / payment type**: not tracked — there is no payment-method column. Tell the user.
    - **Discount totals**: discount lives only in non-ASCII text columns with no materialized view and cannot be reliably aggregated — tell the user discount totals aren't available.
19. **Product CATEGORY questions ("how much <category> did we sell?", "sales by category", "top categories") — group by the real category, NEVER by the product name.** The BI category is \`items.item_group\` ("קבוצת פריט"). Do NOT answer category questions with \`item_name ILIKE '%word%'\` — a name match both misses most of the category (real products rarely contain the category word in their name — e.g. chocolates are branded "Max"/"Lindt", not literally "שוקולד") and wrongly pulls in other categories (chocolate *liqueur* is in "יין ומשקאות"/"משקאות", gift packages in "חבילות שי"). Use the pre-aggregated \`${schemaName}.mv_sales_by_category_month\` (columns: \`category\`, \`year_month\`, \`sale_year\`, \`sale_month\`, \`total_quantity\`, \`total_revenue\`) — remember every row is a per-period aggregate, so \`SUM(total_revenue)\`/\`SUM(total_quantity)\` with \`GROUP BY category\` (rule 14). Match the user's term to the closest \`category\` value; the actual category names are Hebrew, e.g. שוקולד (chocolate), פרחים (flowers), מתנות (gifts), זרים מוכנים (ready bouquets), יין ומשקאות (wine & drinks), עציצים (potted plants), חבילות שי (gift packages). If the user names a category you can't confidently map, query \`SELECT DISTINCT category FROM ${schemaName}.mv_sales_by_category_month\` and pick the closest, or list the options back to the user. Only fall back to an \`item_name\` filter when the user explicitly asks about a specific NAMED product, not a category.

## Important Examples

**CORRECT** (date filter — sale_date is DATE):
WHERE s.sale_date >= CURRENT_DATE - INTERVAL '6 months'

**CORRECT** (join on typed integer columns):
SELECT * FROM ${schemaName}.sales s
JOIN ${schemaName}.stores st ON s.store_id = st.store_id

**CORRECT** (monthly revenue + transactions — PREFER the materialized view, already BI-correct):
SELECT year_month, total_revenue, transaction_count, customer_count
FROM ${schemaName}.mv_sales_by_month
WHERE sale_year = 2026 AND sale_month = 1

**CORRECT** (revenue by month — ALWAYS from the MV, never the raw sales revenue column):
SELECT year_month, SUM(total_revenue) AS total_revenue
FROM ${schemaName}.mv_sales_by_month
WHERE sale_year = EXTRACT(YEAR FROM CURRENT_DATE)::int
GROUP BY year_month
ORDER BY year_month

**CORRECT** (how much of a category sold in a period — group by item_group via the category MV, NEVER name-match):
SELECT SUM(total_revenue) AS total_revenue, SUM(total_quantity) AS total_quantity
FROM ${schemaName}.mv_sales_by_category_month
WHERE category = 'שוקולד' AND sale_year = 2026 AND sale_month = 1

**CORRECT** (top categories this year):
SELECT category, SUM(total_revenue) AS total_revenue
FROM ${schemaName}.mv_sales_by_category_month
WHERE sale_year = EXTRACT(YEAR FROM CURRENT_DATE)::int
GROUP BY category
ORDER BY total_revenue DESC

**PREFER materialized views for aggregations** — they are pre-computed and much faster:
- \`${schemaName}.mv_sales_by_month\` — monthly totals (use for monthly/period questions)
- \`${schemaName}.mv_sales_by_year\` — annual totals
- \`${schemaName}.mv_sales_by_store\` — per-store totals (all-time)
- \`${schemaName}.mv_sales_by_store_month\` — store + month breakdown
- \`${schemaName}.mv_sales_by_product\` — per-product totals (ALL-TIME only, NO date column — do NOT use when year/period is specified)
- \`${schemaName}.mv_sales_by_product_month\` — product + month breakdown (USE THIS for year/period-filtered product queries like "top products this year")
- \`${schemaName}.mv_sales_by_category_month\` — product CATEGORY (item_group) + month breakdown (USE THIS for ALL category questions: "how much chocolate", "sales by category", "top categories" — NEVER name-match categories)
- \`${schemaName}.mv_sales_by_store_product\` — store + product all-time (USE THIS for top-N products per store)
- \`${schemaName}.mv_sales_by_customer\` — per-customer totals (all-time)
- \`${schemaName}.mv_sales_by_city\` — sales by customer city (USE THIS for geographic/city revenue breakdown)
- \`${schemaName}.mv_sales_by_day\` — daily totals (last 90 days)`;
    }

    if (schemaName === 'zolstock') {
      return `
## zolstock-Specific Rules (CRITICAL — follow exactly)

**Tables**: facts (~39.5M rows, WIDE, mixes record types). No dimension tables yet (no products/customers/stores name tables) — group by the numeric/name keys on facts.

**Materialized views (PREFER these for aggregations — pre-computed, fast):**
- \`zolstock.mv_sales_daily\` — daily totals (revenue_ex_vat, revenue_inc_vat, total_cogs, profit_ex_vat, total_qty, line_count)
- \`zolstock.mv_sales_daily_item\` — daily × item_number (use for top-products by period)
- \`zolstock.mv_sales_daily_store\` — daily × store_number (use for top-stores by period)
- \`zolstock.mv_sales_daily_seller\` — daily × seller_id/seller (use for top-sellers by period)

### RULE 1 — facts is a WIDE table mixing 3 record kinds — ALWAYS filter by record_type
- \`record_type = 'מכירות'\` (sales) — retail sale lines. Use for ALL sales/revenue/profit questions.
- \`record_type = 'מלאי'\` (inventory) — stock snapshots: \`store_number\`, \`item_number\`, \`inventory_qty\`, \`min_inventory\`.
- \`record_type IS NULL\` (empty in the source) — agent/branch wholesale sales: \`agent_sales_ex_vat\`, \`agent_sales_inc_vat\`, \`agent_sale_customer\`, \`agent\`. **Use \`IS NULL\`, NOT \`= ''\`** — the empty Fact Type loaded as NULL.
A bare \`SELECT COUNT(*) FROM zolstock.facts\` mixes all three and is misleading — always specify the record_type.

### RULE 2 — Revenue and profit are on the sale line (NO cost JOIN needed)
- Revenue (ex-VAT) = \`SUM(line_total)\`; revenue incl VAT = \`SUM(line_total_inc_vat)\`.
- Cost of goods = \`SUM(cogs)\` (ex-VAT). **Profit (ex-VAT) = \`SUM(line_total - cogs)\`.**
- Profit margin % = \`SUM(line_total - cogs) / NULLIF(SUM(line_total),0) * 100\`.
- Quantity sold = \`SUM(qty_sold)\`.

### RULE 3 — Never COUNT(DISTINCT) on huge facts; avoid full GROUP BY over raw facts
For top-N / revenue-by-period / by-store / by-item / by-seller, query the matching MV, not raw facts (raw GROUP BY over ~35M rows times out). Each MV row is already a daily aggregate — re-aggregate with SUM over the MV.

### RULE 4 — Date filters use transaction_date (DATE), covered by the (record_type, transaction_date) index
- This month: \`WHERE record_type='מכירות' AND transaction_date >= date_trunc('month', CURRENT_DATE)\`
- This year:  \`WHERE record_type='מכירות' AND transaction_date >= date_trunc('year', CURRENT_DATE)\`
- On MVs the same \`transaction_date\` column is indexed — filter there too.

### RULE 5 — expensive metrics: use the MV or narrow the scope (avoid timeouts)
- **Discounts**: \`discount_amount\` is on raw facts only (no MV). \`SUM(discount_amount)\` over a full year times out — restrict to a NARROW window (default to the current month/quarter) with \`record_type='מכירות'\` and the transaction_date filter.
- **Unique customers**: there is NO customer dimension. \`COUNT(DISTINCT customer_number)\` over a full year of facts times out. Only attempt it for a NARROW window (default to the current month) and add \`AND customer_number IS NOT NULL AND customer_number <> ''\`.
- **Inventory below minimum**: \`record_type='מלאי'\` snapshots have no useful date filter for "current stock" — restrict to the LATEST snapshot date (see example) so it doesn't scan all snapshots.

### Reference examples

**Revenue & profit this month (use the daily MV):**
\`\`\`sql
SELECT SUM(revenue_ex_vat) AS revenue, SUM(profit_ex_vat) AS profit, SUM(total_qty) AS qty
FROM zolstock.mv_sales_daily
WHERE transaction_date >= date_trunc('month', CURRENT_DATE)
\`\`\`

**Top 10 items this year by revenue (with profit):**
\`\`\`sql
SELECT item_number,
       SUM(total_qty)      AS qty,
       SUM(revenue_ex_vat) AS revenue,
       SUM(profit_ex_vat)  AS profit
FROM zolstock.mv_sales_daily_item
WHERE transaction_date >= date_trunc('year', CURRENT_DATE)
GROUP BY item_number
ORDER BY revenue DESC
LIMIT 10
\`\`\`

**Top stores this year:**
\`\`\`sql
SELECT store_number, SUM(revenue_ex_vat) AS revenue, SUM(profit_ex_vat) AS profit
FROM zolstock.mv_sales_daily_store
WHERE transaction_date >= date_trunc('year', CURRENT_DATE)
GROUP BY store_number
ORDER BY revenue DESC
LIMIT 10
\`\`\`

**Overall profit margin this year:**
\`\`\`sql
SELECT ROUND(SUM(profit_ex_vat) / NULLIF(SUM(revenue_ex_vat),0) * 100, 2) AS margin_pct
FROM zolstock.mv_sales_daily
WHERE transaction_date >= date_trunc('year', CURRENT_DATE)
\`\`\`

**Monthly revenue trend (current year):**
\`\`\`sql
SELECT TO_CHAR(transaction_date, 'YYYY-MM') AS month,
       SUM(revenue_ex_vat) AS revenue, SUM(profit_ex_vat) AS profit
FROM zolstock.mv_sales_daily
WHERE transaction_date >= date_trunc('year', CURRENT_DATE)
GROUP BY month
ORDER BY month
\`\`\`

**Total discount given this month (discounts are facts-only — keep the window narrow):**
\`\`\`sql
SELECT SUM(discount_amount) AS total_discount
FROM zolstock.facts
WHERE record_type = 'מכירות'
  AND transaction_date >= date_trunc('month', CURRENT_DATE)
\`\`\`

**Inventory: items below minimum stock (latest snapshot only — record_type='מלאי'):**
\`\`\`sql
WITH latest AS (
  SELECT MAX(transaction_date) AS d FROM zolstock.facts WHERE record_type = 'מלאי'
)
SELECT store_number, item_number, inventory_qty, min_inventory
FROM zolstock.facts, latest
WHERE record_type = 'מלאי' AND transaction_date = latest.d
  AND inventory_qty < min_inventory
ORDER BY (min_inventory - inventory_qty) DESC
LIMIT 50
\`\`\`

**Unique customers this month (customers are facts-only; keep the window narrow):**
\`\`\`sql
SELECT COUNT(DISTINCT customer_number) AS unique_customers
FROM zolstock.facts
WHERE record_type = 'מכירות'
  AND transaction_date >= date_trunc('month', CURRENT_DATE)
  AND customer_number IS NOT NULL AND customer_number <> ''
\`\`\``;
    }

    if (schemaName === 'tevanaot') {
      return `
## tevanaot-Specific Rules (Teva Naot — footwear retail — CRITICAL, follow exactly)

Teva Naot is a QlikSense star-schema export. The raw fact tables (\`sales\`, \`inventory\`,
\`orders\`) carry only measures plus a synthetic composite key. The sales key has ALREADY
been resolved into a clean materialized view — query the view, never parse the raw key.

**Tables / views:**
- \`mv_sales\` — RESOLVED item-level sales (~2.7M rows). Columns: \`transaction_date\` (DATE), \`warhs\`, \`part\`, \`cust\`, \`invoice_number\`, \`invoice_type\`, \`qty_sold\`, \`sales_ex_vat\`, \`sales_inc_vat\`, \`sale_price\`, \`vat_pct\`, \`doc_discount\`. **USE THIS FOR ALL SALES QUESTIONS.**
- \`mv_sales_daily\` — daily totals: \`transaction_date\`, \`line_count\`, \`total_qty\`, \`revenue_ex_vat\`, \`revenue_inc_vat\`. Use for "total revenue this year/month", trends.
- \`parts\` — product master (~? rows): \`part\`, \`sku\`, \`barcode\`, \`product_description\`, \`model_code\`, \`model_name\`, \`model_color_name\`, \`color\`, \`size\`, \`shoe_type\`, \`product_line\`, \`gender\`, \`collection\`, \`season\`, \`family_code\`, \`family_description\`, \`family_type\`, \`consumer_price\`, \`consumer_price_inc_vat\`, \`supplier_code\`, \`supplier_name\`, \`item_status\`, \`variety\`, \`quality\`, \`budget_line\`.
- \`sites\` — store/warehouse master: \`warhs\`, \`warehouse_code\`, \`warehouse_name\`, \`store_code\`, \`store_name\`, \`branch\`, \`store_type\`, \`branch_cluster\`, \`store_rank\`, \`franchisee\`, \`warehouse_type\`.
- \`inventory\` — current stock, key \`branch_part_key\` = BRANCH-PART. \`inventory_balance\`, \`inventory_value\`, \`cost_price\`, \`location\`, \`inventory_channel\`.
- \`inventory_in_date\` — end-of-month stock, key \`end_month_branch_part_key\` = DATE(dd/mm/yyyy)-BRANCH-PART, \`inventory_balance_at_date\`.
- \`orders\` — customer orders, key \`part_cust_date_key\` = PART-CUST-DATE. \`customer_order\`, \`order_qty\`, \`order_total_ex_vat\`, \`order_status\`.
- \`customers\` — \`customer_id\`, \`cust\`, \`customer_name\`, \`national_id\`, \`distribution_channel\`.
- \`purchase_orders\` — \`sup\`, \`part\`, \`po_qty\`, \`po_remaining_to_supply\`, \`purchase_order\`, \`po_status\`.
- \`suppliers\` — \`sup\`, \`supplier_code\`, \`supplier_name\`.

### RULE 1 — Sales come from mv_sales / mv_sales_daily (NEVER the raw \`sales\` table)
The raw \`sales\` table has no usable date/store/product columns (they are inside the
composite key). \`mv_sales\` already resolved them. For revenue/units/top-N use mv_sales;
for plain "total revenue this year/month/week" use mv_sales_daily (smaller/faster).

### RULE 2 — transaction_date is a real DATE on the MVs (sargable)
- This year: \`transaction_date >= DATE_TRUNC('year', CURRENT_DATE) AND transaction_date < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'\`
- This month: \`transaction_date >= DATE_TRUNC('month', CURRENT_DATE) AND transaction_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'\`
- Specific year: \`transaction_date >= '2025-01-01' AND transaction_date < '2026-01-01'\`
- Do NOT wrap transaction_date in EXTRACT/TO_CHAR in WHERE (disables the index).

### RULE 3 — Revenue / units / returns
- Revenue ex-VAT: \`SUM(sales_ex_vat)\`; inc-VAT: \`SUM(sales_inc_vat)\`. Default to ex-VAT unless the user asks "with VAT / כולל מעמ".
- Units: \`SUM(qty_sold)\`. \`qty_sold\` is NEGATIVE on returns/refunds, so SUM nets returns automatically (this is correct for "net sales").
- Teva data has NO cost/profit column on the sale line — do NOT invent profit/margin from sales. (Cost exists only on \`inventory.cost_price\` and \`parts.consumer_price\`.)

### RULE 4 — Transactions and average basket
- A "transaction" / עסקה = a distinct \`invoice_number\`. \`COUNT(DISTINCT invoice_number)\` on mv_sales is fine WITH a date filter.
- Average basket / סל ממוצע = \`SUM(sales_ex_vat) / NULLIF(COUNT(DISTINCT invoice_number), 0)\`.

### RULE 5 — JOINs, and the parts FAN-OUT TRAP (CRITICAL)
- Stores: \`JOIN tevanaot.sites si ON s.warhs = si.warhs\` — store = \`si.store_name\` (fallback \`si.warehouse_name\`). sites is unique per warhs — safe to join directly.
- Customers: \`JOIN tevanaot.customers c ON s.cust = c.cust\`.
- Products: **\`parts\` has MANY rows per \`part\` value (one per size), so \`part\` is NOT unique.** JOINing mv_sales (or an aggregate of it) directly to \`parts\` and SUM-ing AFTER the join multiplies every measure by the size-row count — a 16–50x over-count (we have seen "billions of ₪" / millions of units vs a real total in the tens of thousands). NEVER write \`... JOIN tevanaot.parts p ON a.part = p.part ... SUM(a.qty)\`.
  Instead aggregate mv_sales by \`part\` FIRST, then JOIN the pre-deduplicated dimension **\`tevanaot.mv_parts_dim\`** (already exactly ONE row per \`part\`, indexed on part): \`JOIN tevanaot.mv_parts_dim p ON a.part = p.part\`. It carries the part-constant attributes (model_code, model_name, model_color_name, color, gender, shoe_type, collection, season, family_description, supplier_name, consumer_price, …) — NOT size/sku/barcode (those are size-level). Use mv_parts_dim for ALL attribute rollups; never raw \`parts\` for SUM-after-join.

### RULE 6 — "model" vs "item" grain
\`part\` is the model-COLOR grain (a model has several colors → several parts; each part also has several size-rows in \`parts\`).
- "top MODELS" → roll up to the model: aggregate mv_sales by part, join \`tevanaot.mv_parts_dim\`, then \`GROUP BY model_code, model_name\` and SUM. (Listing parts directly repeats the same model once per color.)
- "top items / SKUs" → keep part grain, show \`model_color_name\` (from mv_parts_dim).
- "sales by color / gender / shoe_type / season / family" → aggregate by part, join \`tevanaot.mv_parts_dim\`, GROUP BY the attribute, SUM. NEVER SUM over a raw \`parts\` join (fan-out).

### RULE 7 — Inventory (resolve the BRANCH-PART key with split_part)
\`inventory.branch_part_key\` = 'BRANCH-PART' (e.g. '17-8538'). Resolve:
\`split_part(branch_part_key,'-',1) AS branch\`, \`split_part(branch_part_key,'-',2) AS part\`.
- Stock by store: GROUP BY branch, JOIN sites ON branch = warhs (or store_code).
- Stock by product: JOIN parts ON resolved part = parts.part.
- "Stock value" = \`SUM(inventory_value)\`; "units in stock" = \`SUM(inventory_balance)\`.

### Reference examples

**Total revenue this month:**
\`\`\`sql
SELECT SUM(revenue_ex_vat) AS revenue, SUM(total_qty) AS units, SUM(line_count) AS lines
FROM tevanaot.mv_sales_daily
WHERE transaction_date >= DATE_TRUNC('month', CURRENT_DATE)
  AND transaction_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
\`\`\`

**Top 10 selling MODELS this year (rolled up to model; de-duplicated parts join):**
\`\`\`sql
WITH agg AS (
  SELECT part, SUM(qty_sold) AS qty, SUM(sales_ex_vat) AS revenue
  FROM tevanaot.mv_sales
  WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY part
)
SELECT d.model_name, SUM(a.qty) AS units, SUM(a.revenue) AS revenue
FROM agg a
JOIN tevanaot.mv_parts_dim d ON a.part = d.part
GROUP BY d.model_code, d.model_name
ORDER BY units DESC
LIMIT 10
\`\`\`

**Sales by gender (or color / shoe_type / season) this year — de-duplicated parts join (NO fan-out):**
\`\`\`sql
WITH agg AS (
  SELECT part, SUM(qty_sold) AS qty, SUM(sales_ex_vat) AS revenue
  FROM tevanaot.mv_sales
  WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY part
)
SELECT COALESCE(d.gender, '(unknown)') AS gender, SUM(a.qty) AS units, SUM(a.revenue) AS revenue
FROM agg a
JOIN tevanaot.mv_parts_dim d ON a.part = d.part
GROUP BY d.gender
ORDER BY units DESC
\`\`\`

**Top stores by revenue this year:**
\`\`\`sql
WITH agg AS (
  SELECT warhs, SUM(sales_ex_vat) AS revenue, SUM(qty_sold) AS units
  FROM tevanaot.mv_sales
  WHERE transaction_date >= DATE_TRUNC('year', CURRENT_DATE)
    AND transaction_date <  DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
  GROUP BY warhs
)
SELECT COALESCE(si.store_name, si.warehouse_name) AS store, a.revenue, a.units
FROM agg a
LEFT JOIN tevanaot.sites si ON a.warhs = si.warhs
ORDER BY a.revenue DESC
LIMIT 10
\`\`\`

**Transactions and average basket this month:**
\`\`\`sql
SELECT COUNT(DISTINCT invoice_number) AS transactions,
       SUM(sales_ex_vat)              AS revenue,
       SUM(sales_ex_vat) / NULLIF(COUNT(DISTINCT invoice_number), 0) AS avg_basket
FROM tevanaot.mv_sales
WHERE transaction_date >= DATE_TRUNC('month', CURRENT_DATE)
  AND transaction_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
\`\`\`

**Current inventory value and units by store:**
\`\`\`sql
SELECT COALESCE(si.store_name, si.warehouse_name) AS store,
       SUM(i.inventory_balance) AS units,
       SUM(i.inventory_value)   AS stock_value
FROM tevanaot.inventory i
LEFT JOIN tevanaot.sites si ON split_part(i.branch_part_key, '-', 1) = si.warhs
GROUP BY 1
ORDER BY stock_value DESC
LIMIT 20
\`\`\``;
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
