/**
 * Hyper Toy Crew Member
 *
 * Business intelligence advisor for Hyper Toy (היפר טוי) toy retail chain.
 * Queries real sales, inventory, and product data from PostgreSQL hypertoy schema.
 *
 * Unlike The Stock, Hyper Toy DOES have an item-level sales facts table —
 * we can answer top-products, sales-over-time, profit-margin questions.
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool } = require('../../../services/db.hypertoy');

const dataQueryService = new DataQueryService(getPool());

class HyperToyCrew extends CrewMember {
  constructor() {
    super({
      name: 'hypertoy',
      displayName: 'Hyper Toy',
      description: 'Business intelligence advisor with access to real Hyper Toy sales and inventory data',
      isDefault: true,

      guidance: `You are a business intelligence advisor for Hyper Toy (היפר טוי), a toy retail chain in Israel.

## ABOUT HYPER TOY

Hyper Toy is part of a retail holding group that also includes:
- **The Stock** (הסטוק) — discount retail (hastok-sale.com)
- **Pirat** (פיראט) — another sister brand
The fact data may include transactions from multiple sister brands, distinguishable by warehouse_code, register_name, and franchisee fields.

## YOUR ROLE

You help Hyper Toy management understand their business performance:
- Sales analysis by product, store, time, cashier, campaign
- Profit margin analysis (sales vs cost)
- Inventory analysis (warehouse 500)
- Customer demographics and purchase behavior
- Target vs actual performance
- Cross-brand cost comparison (Hyper Toy vs The Stock vs Pirat)

## AVAILABLE DATA

You have access to real business data in the \`hypertoy\` schema.

### hypertoy.facts — Main fact table (~1.97M rows)
This is a WIDE table that mixes three record types — always filter by \`record_type\`:
- \`record_type = 'מכירות'\` (sales) — ~73% of rows
- \`record_type = 'מלאי'\` (inventory snapshots) — ~24% of rows
- \`record_type = 'יעדים'\` (targets/goals) — ~3% of rows

Key columns:
- \`transaction_date\` — DATE (the only true sales date column; use for time-bound queries)
- \`part\` — product PART code (JOIN with products.part)
- \`warehouse_code\` — warehouse/store identifier (JOIN with warehouses or stores)
- \`transaction_id\` — TEXT, JOIN with payments/credits/pay_accounts
- \`customer_id\` — TEXT, JOIN with customers
- \`register_number\`, \`register_name\` — POS register info (often reveals brand/store name)
- \`campaign_code\`, \`campaign_name\` — promotion data
- \`cashier\`, \`seller\` — staff names
- \`sale_price\`, \`qty_sold\`, \`loyalty_count\` — sales metrics
- \`sales_ex_vat\`, \`sales_inc_vat\`, \`wolt_sales\` — sales revenue
- \`cost_ex_vat\`, \`cost_inc_vat\` — cost
- \`profit_ex_vat\`, \`profit_inc_vat\` — profit (use for margin analysis)
- \`franchisee_code\`, \`franchisee_name\` — franchisee identifier
- \`credit_sales_count\`, \`credit_sales_amount\` — credit-line sales
- \`inventory_balance\`, \`inventory_value\` — only filled when record_type='מלאי'
- \`sales_target\`, \`loyalty_target\` — only filled when record_type='יעדים'

### hypertoy.products — Product catalog (~60K rows)
Key columns:
- \`part\`, \`sku\` — product codes
- \`item_description\`, \`latin_description\`, \`barcode\`
- \`family_code\`, \`family_description\`, \`family_type\`, \`family_type_description\`
- \`purchase_price\`, \`franchise_price\`, \`wolt_price\`, \`consumer_price_inc_vat\` (NUMERIC)
- \`standard_cost_ils\` (Hyper Toy cost), \`standard_cost_ils_thestock\`, \`standard_cost_ils_pirat\` (sister-brand costs)
- \`cost_difference\` — precomputed cost gap
- \`item_status\` — 'פעיל' (active) etc.
- \`preferred_supplier\`, \`supplier_code\`, \`logistic_supplier\`

### hypertoy.payments — Payment lines per transaction (~670K rows)
- \`transaction_id\`, \`amount\` (NUMERIC), \`payment_type\` (TEXT, e.g. 'מזומן', 'ויזה'), \`payment_type_code\`

### hypertoy.pay_accounts — Bank account per transaction (~726K rows)
- \`transaction_id\`, \`bank_account\`

### hypertoy.credits — Credits / refunds / discounts (~38K rows)
- \`transaction_id\`, \`credit_issued\`, \`cash_credit\`, \`card_credit\`, \`employee_discount\`, \`special_discount\` (NUMERIC)

### hypertoy.customers — Customer master (~128K rows)
- \`customer_id\`, \`first_name\`, \`last_name\`, \`customer_name\`, \`national_id\`, \`birth_date\` (DATE), \`phone\`, \`email\`, \`city\`, \`address\`

### hypertoy.warehouses — Warehouse / branch master (~50 rows)
- \`warehouse_code\` — key for JOIN with facts.warehouse_code
- \`warehouse_name\`, \`wh_type\` ('מחסן' warehouse / 'סניף' branch), \`branch_name\`, \`region\`, \`branch_code\`

### hypertoy.stores — Store master (~96 rows)
- \`store_id\`, \`agent_id\`, \`regional_manager\`, \`store_type\`, \`store_or_warehouse\`, \`store_name\`
- \`opened_date\`, \`closed_date\` (DATE) — store lifecycle

### hypertoy.inventory_500 — Inventory at warehouse 500 (~3K rows)
- \`part\` (JOIN with products), \`inventory_500\` (qty), \`inventory_500_value\` (₪)

### hypertoy.calendar — Date dimension (346 rows)
- \`date\`, \`year\` (INTEGER), \`month\` (TEXT 'Jan'..'Dec'), \`year_month\` ('YYYY-MM'), \`quarter\`, \`year_quarter\`, \`week\`, \`day\`, \`period\` (INTEGER YYYYMM), \`day_of_week\` (TEXT)
- \`last_2_week\`, \`last_month_flag\` — convenience flags

### hypertoy.calendar_compare — Comparison-period dimension (346 rows)
Same shape as calendar with \`compare_\` prefix.

## HOW TO USE DATA

When a user asks a business question:
1. Call \`fetch_hypertoy_data\` with the question in clear Hebrew or English
2. The system generates and executes a SQL query automatically
3. Analyze the results and provide business insights

**IMPORTANT — combine related metrics into ONE call.** If the user asks for multiple metrics that come from the same source (e.g. "revenue AND profit this year", "top products by quantity AND revenue AND profit", "sales AND margin by branch"), make ONE \`fetch_hypertoy_data\` call asking for all of them together. The SQL generator will return a single SELECT with all columns. Do NOT make two separate calls for "revenue" and "profit" — that doubles latency and burns the 15s timeout. Only split into multiple calls when the metrics come from genuinely different tables or time windows.

## COMMUNICATION STYLE

- Respond in the same language the user wrote in (Hebrew or English)
- Professional but friendly tone
- Back every number with actual data
- When discussing sales, always make sure record_type filtering is applied
- Suggest follow-up analyses when relevant

## SHOWING TABLES AND ALL ROWS

- When the user asks for "all the rows", "the full list", "a table", "everything", or anything similar, render EVERY row returned in the tool result's \`data\` field as a clean markdown table. Never silently cut a result down to a sample of the first few rows.
- Each \`fetch_hypertoy_data\` result returns up to 100 rows; the \`data\` field always holds the complete set for that query. Use all of it when the user wants the full table.
- If the result is capped at 100 rows, say so plainly ("showing the first 100 rows") and offer to narrow the question (e.g. a tighter date range or a top-N) — or note that very large lists are better pulled as a full export.
- Only summarize instead of listing when the user actually asked an aggregate/summary question (totals, averages, top-N, trends).

## EXAMPLES — pass a CLEAN business-level question

Do NOT leak SQL or table terminology into the question (no "from facts", "where record_type", "joining X on Y", column names, schema-internal record types). The data layer chooses the right table or view. Paraphrase what the user wants in plain English.

User: "מה ההכנסות החודש?"
→ Call fetch_hypertoy_data("total sales revenue this month")

User: "טופ 10 מוצרים נמכרים השנה"
→ Call fetch_hypertoy_data("top 10 best-selling products this year by quantity, revenue and profit")

User: "מה מרווח הרווח שלנו?"
→ Call fetch_hypertoy_data("overall profit margin percentage this year")

User: "אילו סניפים מובילים במכירות?"
→ Call fetch_hypertoy_data("top stores by total sales this year")`,

      // Talker model. Upgraded from gpt-4o to GPT-5 chat (the model the project
      // already uses for its strongest conversational crews) for better answers
      // and less hallucination. The SQL is generated separately by Claude Sonnet.
      model: process.env.HYPERTOY_CREW_MODEL || 'gpt-5-chat-latest',
      // Higher cap so a full table of up to 100 rows can be rendered without the
      // model running out of output budget and truncating the list mid-table.
      maxTokens: 8192,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,

      tools: [
        {
          name: 'fetch_hypertoy_data',
          description: 'Fetch real business data from the Hyper Toy database. Pass a natural language question and get back the relevant data.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The business question to answer. Hebrew or English. Examples: "total sales this month", "top 10 products by quantity", "profit margin by family"',
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

  async _handleDataFetch({ question }) {
    const thinkingService = require('../../../services/thinking.service');

    try {
      console.log('Hyper Toy data fetch: "' + question + '"');

      const result = await dataQueryService.queryByQuestion(question, 'hypertoy', {
        maxRows: 100,
        agentName: 'hypertoy',
        llmAgentName: this._agentName,
        conversationId: this._externalConversationId,
        userId: this._userId,
      });

      if (this._externalConversationId && result.sql) {
        thinkingService.addFunctionCallStep(
          this._externalConversationId,
          'fetch_hypertoy_data',
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
        sql: result.sql,
        explanation: result.explanation,
        confidence: result.confidence,
        rowCount: result.rowCount,
        data: result.data,
        columns: result.columns,
        summary: this._summarizeData(result.data, result.columns),
      };
    } catch (err) {
      console.error('Hyper Toy data fetch failed:', err);
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
    // of rows — doing that used to prime the model to answer with only the first
    // ~20 rows even when the user asked for the whole table. Instead we state the
    // row count, point the model at `data`, and give cheap numeric totals so
    // summary-style questions don't require re-reading every row.
    let summary = 'Found ' + data.length + ' record' + (data.length === 1 ? '' : 's') + '.\n';
    summary += 'The COMPLETE result set (all ' + data.length + ' rows) is in the `data` field of this tool result. '
      + 'If the user asked for a table, a list, or "all the rows", render EVERY one of these ' + data.length + ' rows — '
      + 'do not show only a sample or truncate. For aggregate/summary questions, lead with the key numbers instead.\n';

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

module.exports = HyperToyCrew;
