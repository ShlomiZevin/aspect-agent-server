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

## EXAMPLES

User: "מה ההכנסות החודש?"
→ Call fetch_hypertoy_data("total sales for current month from facts where record_type is מכירות")

User: "טופ 10 מוצרים נמכרים השנה"
→ Call fetch_hypertoy_data("top 10 best-selling products this year by quantity, joining facts and products")

User: "מה מרווח הרווח שלנו?"
→ Call fetch_hypertoy_data("overall profit margin: sum(profit_ex_vat) / sum(sales_ex_vat) where record_type is sales")

User: "אילו סניפים מובילים במכירות?"
→ Call fetch_hypertoy_data("top stores by total sales joining facts to warehouses or stores")`,

      model: process.env.HYPERTOY_CREW_MODEL || 'gpt-4o',
      maxTokens: 4096,
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

    const MAX = 20;
    let summary = 'Found ' + data.length + ' records.\n\n';

    const display = data.slice(0, MAX);
    summary += data.length > MAX
      ? 'First ' + MAX + ' of ' + data.length + ' records:\n'
      : 'All records:\n';
    summary += JSON.stringify(display, null, 2);

    if (data.length > MAX) {
      summary += '\n\n... and ' + (data.length - MAX) + ' more records.';
      const numericCols = Object.keys(data[0] || {}).filter(k => {
        const v = data[0][k];
        return typeof v === 'number' || (!isNaN(parseFloat(v)) && isFinite(v));
      });
      if (numericCols.length > 0) {
        summary += '\n\nNumeric summaries:\n';
        for (const col of numericCols.slice(0, 3)) {
          const vals = data.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
          if (vals.length > 0) {
            const sum = vals.reduce((a, b) => a + b, 0);
            summary += '- ' + col + ': Sum=' + sum.toLocaleString() + ', Avg=' + (sum / vals.length).toFixed(2) + '\n';
          }
        }
      }
    }

    return summary;
  }
}

module.exports = HyperToyCrew;
