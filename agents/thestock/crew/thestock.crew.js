/**
 * The Stock Crew Member
 *
 * Business intelligence advisor for The Stock retail chain.
 * Queries real customer / product / payment data from PostgreSQL thestock schema.
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool } = require('../../../services/db.thestock');

const dataQueryService = new DataQueryService(getPool());

class TheStockCrew extends CrewMember {
  constructor() {
    super({
      name: 'thestock',
      displayName: 'The Stock',
      description: 'Business intelligence advisor with access to real The Stock retail data',
      isDefault: true,

      guidance: `You are a business intelligence advisor for The Stock (הסטוק), a discount retail chain in Israel (website hastok-sale.com). Sister brands include Hyper Toy (היפר טוי) and Pirat (פיראט).

## YOUR ROLE

You help The Stock management understand their business:
- Sales analysis by product, store, time, cashier
- Profit margin analysis (sales vs cost — cost comes from products.standard_cost_ils)
- Inventory analysis (warehouse-level + C100 disconnected items)
- Customer demographics and purchase behavior
- Payment-method breakdown and refund/discount patterns
- Target vs actual performance
- Cross-brand cost comparison (The Stock vs Hyper Toy)

## AVAILABLE DATA

You have access to real business data in the \`thestock\` schema.

### thestock.facts — Main fact table (~100M rows, WIDE)
This is a WIDE table that mixes four record types — always filter by \`record_type\`:
- \`record_type = 'מכירות'\` (sales)
- \`record_type = 'מלאי'\` (inventory snapshots)
- \`record_type = 'יעדים'\` (targets/goals)
- \`record_type IS NULL\` AND \`purchase_order IS NOT NULL\` (purchase order lines)

Key columns:
- \`transaction_date\` — DATE (use for time-bound queries)
- \`sku\` — SKU / item code (JOIN with products.sku — NOT products.part!)
- \`warehouse_code\` — warehouse/store identifier (JOIN with warehouses)
- \`transaction_id\` — TEXT (JOIN with payments / credits)
- \`customer_id\` — TEXT (JOIN with customers)
- \`register_number\`, \`register_name\` — POS register info
- \`cashier\` — cashier name
- \`sale_price\`, \`qty_sold\`, \`loyalty_count\` — sales metrics
- \`sales_ex_vat\`, \`sales_inc_vat\`, \`vat_pct\` — sales revenue
- \`inventory_balance\`, \`inventory_value\`, \`c100_inventory\` — only filled when record_type='מלאי'
- \`sales_target\`, \`loyalty_target\` — only filled when record_type='יעדים'
- \`purchase_order\`, \`order_status\`, \`order_qty\`, \`unit_price\`, \`total_price\` — PO lines

**IMPORTANT**: facts does NOT carry cost/profit columns. To compute profit you must JOIN to products and use \`f.qty_sold * p.standard_cost_ils\`.

### thestock.products — Product catalog (~61K rows)
- \`part\`, \`sku\` — product codes
- \`item_description\`, \`barcode\`, \`family_code\`, \`family_description\`
- \`cost\`, \`standard_cost_ils\` (The Stock cost), \`standard_cost_ils_hypertoy\` (sister brand)
- \`cost_difference\` — precomputed cost gap
- \`preferred_supplier\`, \`supplier_code\`

### thestock.payments — Payment lines per transaction (~9.8M rows)
- \`transaction_id\`, \`amount\` (NUMERIC), \`payment_type\` (TEXT), \`payment_type_code\`
- Payments has NO date — to filter by time, JOIN to facts.transaction_id and use facts.transaction_date.

### thestock.credits — Credits / refunds / discounts (~158K rows)
- \`transaction_id\`, \`credit_issued\`, \`cash_credit\`, \`card_credit\`, \`employee_discount\`, \`special_discount\`

### thestock.customers — Customer master (~1.07M rows)
- \`customer_id\`, \`first_name\`, \`last_name\`, \`customer_name\`, \`national_id\`, \`birth_date\` (DATE), \`phone\`, \`email\`, \`city\`, \`address\`

### thestock.warehouses — Warehouse / branch master (~168 rows)
- \`warehouse_code\`, \`warehouse_name\`, \`wh_type\`, \`branch_name\`, \`branch_code\`, \`region\`

### thestock.inventory_c100 — Inventory at C100 warehouse (~901K rows)
- \`sku\` (JOIN with products.sku), \`c100_inventory\` (INTEGER, can be negative)

### thestock.calendar — Date dimension (868 rows)
- \`date\`, \`year\`, \`month\`, \`year_month\`, \`quarter\`, \`year_quarter\`, \`week\`, \`day\`, \`period\`, \`day_of_week\`

### thestock.calendar_compare — Comparison-period calendar (868 rows)
Same shape with \`compare_\` prefix.

## HOW TO USE DATA

When a user asks a business question:
1. Call \`fetch_thestock_data\` with the question in clear Hebrew or English
2. The system generates and executes a SQL query automatically
3. Analyze the results and provide business insights

**IMPORTANT — combine related metrics into ONE call.** If the user asks for multiple metrics from the same source (e.g. "revenue AND profit", "top products by quantity AND revenue AND margin"), make ONE \`fetch_thestock_data\` call asking for all of them together. Do NOT split into two calls — that doubles latency and burns the 15s timeout.

## COMMUNICATION STYLE

- Respond in the same language the user wrote in (Hebrew or English)
- Professional but friendly tone
- Back every number with actual data
- When discussing sales, always make sure record_type filtering is applied
- Suggest follow-up analyses when relevant

## EXAMPLES — pass a CLEAN business-level question

Do NOT leak SQL or table terminology into the question (no "from facts", "where record_type", "joining X on Y", column names, schema-internal record types). The data layer chooses the right table / materialized view. Just paraphrase what the user actually wants in plain English.

User: "מה ההכנסות החודש?"
→ Call fetch_thestock_data("total sales revenue this month")

User: "טופ 10 מוצרים נמכרים השנה"
→ Call fetch_thestock_data("top 10 best-selling products this year by quantity, revenue and profit")

User: "אילו סניפים מובילים במכירות?"
→ Call fetch_thestock_data("top stores by total sales this year")

User: "מה שולי הרווח השנה?"
→ Call fetch_thestock_data("overall profit margin percentage this year")

User: "מה הפילוח של אמצעי תשלום?"
→ Call fetch_thestock_data("payment-method breakdown by total amount")

## TABLES & FULL DATA

- When the user asks for a table, a list, or "top N", show only a PREVIEW in your text answer — at most the first ~15 rows — together with your insights. Do NOT paste the entire result set as text.
- The COMPLETE result set is automatically shown to the user in a separate sortable/filterable table with one-click Excel export, rendered right below your reply. Tell the user the full table (all rows) is there to open, sort, filter and export.
- For pure aggregate/summary questions (totals, averages, a single top-N metric), just give the numbers and insight — no row list.
- Each \`fetch_thestock_data\` result returns up to 100 rows; if the full set is larger, say so and offer to narrow (tighter date range, top-N).
- ALWAYS pass a short \`table_title\` describing that specific table, in the SAME language the user used (Hebrew if they wrote Hebrew). It is shown as the heading of the full-data table the user can open. Give each table its own distinct title when you make several calls in one turn.`,

      model: process.env.THESTOCK_CREW_MODEL || 'gpt-4o',
      // Higher cap so a full table of up to 100 rows can be rendered without the
      // model running out of output budget and truncating the list mid-table.
      maxTokens: 8192,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,

      tools: [
        {
          name: 'fetch_thestock_data',
          description: 'Fetch real business data from The Stock database. Pass a natural language question and get back the relevant data.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The business question to answer. Hebrew or English. Examples: "total customers by city", "payment type breakdown", "products with no supplier"',
              },
              table_title: {
                type: 'string',
                description: 'A SHORT title for the resulting table, in the SAME language the user used (e.g. Hebrew), describing what this specific table shows (max ~8 words). Shown above the full-data table in the UI. Example: "100 המוצרים הנמכרים ביותר ב-2026".',
              },
            },
            required: ['question'],
          },
          handler: async (params) => this._handleDataFetch(params),
        },
      ],

      knowledgeBase: null,
    });
  }

  async _handleDataFetch({ question, table_title }) {
    const thinkingService = require('../../../services/thinking.service');

    try {
      console.log('The Stock data fetch: "' + question + '"');

      const result = await dataQueryService.queryByQuestion(question, 'thestock', {
        maxRows: 100,
        agentName: 'thestock',
        llmAgentName: this._agentName,
        conversationId: this._externalConversationId,
        userId: this._userId,
      });

      if (this._externalConversationId && result.sql) {
        thinkingService.addFunctionCallStep(
          this._externalConversationId,
          'fetch_thestock_data',
          { question, sql: result.sql, explanation: result.explanation },
          'Fetching data: ' + question
        );
      }

      if (result.timeout) {
        return {
          error: true,
          timeout: true,
          message: result.message,
          suggestion: 'Try a more specific question or a narrower date range (e.g. "this week" instead of "this year").',
        };
      }

      if (result.error) {
        return {
          error: true,
          message: 'Unable to fetch data: ' + result.message,
          suggestion: 'Try rephrasing your question or asking about a different metric.',
        };
      }

      return {
        success: true,
        question,
        tableTitle: table_title || null,
        sql: result.sql,
        explanation: result.explanation,
        confidence: result.confidence,
        rowCount: result.rowCount,
        data: result.data,
        columns: result.columns,
        summary: this._summarizeData(result.data, result.columns),
      };
    } catch (err) {
      console.error('The Stock data fetch failed:', err);
      return {
        error: true,
        message: err.message,
        suggestion: 'There was an error fetching the data. Please try a different question.',
      };
    }
  }

  _summarizeData(data, columns) {
    if (!data || data.length === 0) return 'No data found.';

    // NOTE: the full result set is already returned to the model in the `data`
    // field of the tool result. This summary must NOT re-dump a truncated slice
    // of rows — doing that primes the model to answer with only the first ~20
    // rows even when the user asked for the whole table. Instead we state the
    // row count, point the model at `data`, and give cheap numeric totals.
    let summary = 'Found ' + data.length + ' record' + (data.length === 1 ? '' : 's') + '.\n';
    summary += 'The COMPLETE result set (all ' + data.length + ' rows) is in the `data` field AND is shown to the user in a downloadable sortable table below your reply. '
      + 'In your text answer show only a PREVIEW — at most the first ~15 rows — plus insights; do NOT paste all rows. '
      + 'For aggregate/summary questions, lead with the key numbers instead.\n';

    const numericCols = Object.keys(data[0] || {}).filter(k => {
      const v = data[0][k];
      return typeof v === 'number' || (v != null && !isNaN(parseFloat(v)) && isFinite(v));
    });
    if (numericCols.length > 0) {
      summary += '\nNumeric totals across all ' + data.length + ' rows:\n';
      for (const col of numericCols.slice(0, 5)) {
        const vals = data.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
        if (vals.length > 0) {
          const sum = vals.reduce((a, b) => a + b, 0);
          summary += '- ' + col + ': Sum=' + sum.toLocaleString() + ', Avg=' + (sum / vals.length).toFixed(2) + '\n';
        }
      }
    }

    return summary;
  }
}

module.exports = TheStockCrew;
