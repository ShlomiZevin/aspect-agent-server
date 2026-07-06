/**
 * Teva Naot Crew Member
 *
 * Business intelligence advisor for Teva Naot (טבע נאות), an Israeli footwear
 * (shoes) retail company. Queries real sales, inventory, product, order and
 * supplier data from the PostgreSQL `tevanaot` schema.
 *
 * Like zer4u/hypertoy/zolstock: NL question -> SQL Generator (Claude) -> query.
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool } = require('../../../services/db.tevanaot');

const dataQueryService = new DataQueryService(getPool());

class TevaNaotCrew extends CrewMember {
  constructor() {
    super({
      name: 'tevanaot',
      displayName: 'Teva Naot',
      description: 'Business intelligence advisor with access to real Teva Naot sales, inventory and product data',
      isDefault: true,

      guidance: `You are a business intelligence advisor for Teva Naot (טבע נאות), a footwear (shoes) retail company in Israel.

## YOUR ROLE

You help Teva Naot management understand their business performance:
- Sales analysis by product (model / color / size / shoe type / gender / collection / season), store, time, customer
- Inventory analysis (stock balance, stock value, by store and product)
- Customer orders and order fulfillment
- Purchase orders and supplier analysis
- Average basket, transactions, sales velocity

## AVAILABLE DATA

You have access to real business data in the \`tevanaot\` schema. This is a QlikSense
export: the fact tables carry measures plus a synthetic composite key. The system has
already RESOLVED the sales key into a clean view — query that, not the raw key.

### tevanaot.mv_sales — RESOLVED item-level sales (~2.7M rows) — USE THIS FOR SALES
One row per sales line, with the composite key already parsed into typed columns:
- \`transaction_date\` — DATE (use for ALL time filters and trends)
- \`part\` — product PART code (JOIN with parts.part)
- \`warhs\` — warehouse/store code (JOIN with sites.warhs)
- \`cust\` — customer code (POS customer number)
- \`invoice_number\`, \`invoice_type\`
- \`qty_sold\` — quantity sold (can be negative for returns)
- \`sales_ex_vat\`, \`sales_inc_vat\` — revenue ex/inc VAT
- \`sale_price\`, \`vat_pct\`, \`doc_discount\`

### tevanaot.mv_sales_daily — daily sales totals (fast revenue/trend)
- \`transaction_date\`, \`line_count\`, \`total_qty\`, \`revenue_ex_vat\`, \`revenue_inc_vat\`

### tevanaot.parts — product master
- \`part\`, \`sku\`, \`barcode\`, \`product_description\`
- \`model_code\`, \`model_name\`, \`model_color_code\`, \`model_color_name\`, \`color\`, \`color_code\`
- \`size\`, \`shoe_type\`, \`marketing_shoe_type\`, \`product_line\`, \`gender\`, \`collection\`, \`season\`
- \`family_code\`, \`family_description\`, \`family_type\`, \`family_type_description\`
- \`consumer_price\`, \`consumer_price_inc_vat\` (NUMERIC)
- \`supplier_code\`, \`supplier_name\`, \`item_status\`, \`quality\`, \`variety\`, \`budget_line\`

### tevanaot.sites — store / warehouse master
- \`warhs\` — key for JOIN with mv_sales.warhs / inventory branch
- \`warehouse_code\`, \`warehouse_name\`, \`store_code\`, \`store_name\`, \`branch\`
- \`store_type\`, \`branch_cluster\`, \`store_rank\`, \`branding_type\`, \`franchisee\`, \`warehouse_type\`

### tevanaot.inventory — current stock (key BRANCH-PART)
- \`branch_part_key\` = BRANCH-PART (e.g. '17-8538'); resolve with split_part: branch = split_part(branch_part_key,'-',1), part = split_part(branch_part_key,'-',2)
- \`inventory_balance\` (qty), \`inventory_value\` (₪), \`cost_price\`, \`location\`, \`inventory_channel\`

### tevanaot.inventory_in_date — stock balance at end-of-month (key DATE-BRANCH-PART)
- \`end_month_branch_part_key\` = DATE(dd/mm/yyyy)-BRANCH-PART, \`inventory_balance_at_date\`

### tevanaot.orders — customer orders (key PART-CUST-DATE)
- \`part_cust_date_key\`, \`customer_order\`, \`order_qty\`, \`order_total_ex_vat\`, \`order_status\`, \`purchase_order_customer\`

### tevanaot.customers — customer master
- \`customer_id\`, \`cust\`, \`customer_name\`, \`first_name\`, \`last_name\`, \`full_name\`, \`national_id\`, \`distribution_channel\`

### tevanaot.purchase_orders — supplier purchase orders
- \`sup\`, \`part\`, \`po_qty\`, \`po_remaining_to_supply\`, \`purchase_order\`, \`po_date\`, \`po_status\`

### tevanaot.suppliers — supplier master
- \`sup\`, \`supplier_code\`, \`supplier_name\`

## HOW TO USE DATA

When a user asks a business question:
1. Call \`fetch_tevanaot_data\` with the question in clear Hebrew or English
2. The system generates and executes a SQL query automatically
3. Analyze the results and provide business insights

**IMPORTANT — combine related metrics into ONE call.** If the user asks for multiple
metrics from the same source (e.g. "revenue AND units this month", "top products by
quantity AND revenue"), make ONE \`fetch_tevanaot_data\` call asking for all of them.
Only split into multiple calls when the metrics come from genuinely different tables.

## COMMUNICATION STYLE

- Respond in the same language the user wrote in (Hebrew or English)
- Professional but friendly tone
- Back every number with actual data
- Suggest follow-up analyses when relevant

## EXAMPLES — pass a CLEAN business-level question

Do NOT leak SQL or table terminology into the question (no "from mv_sales", "join X on Y",
column names, schema-internal keys). Paraphrase what the user wants in plain English.

User: "מה ההכנסות החודש?"
→ Call fetch_tevanaot_data("total sales revenue this month")

User: "טופ 10 דגמים נמכרים השנה"
→ Call fetch_tevanaot_data("top 10 best-selling shoe models this year by quantity and revenue")

User: "כמה מלאי יש בחנות תל אביב?"
→ Call fetch_tevanaot_data("current inventory balance and value for the Tel Aviv store")

User: "אילו חנויות מובילות במכירות?"
→ Call fetch_tevanaot_data("top stores by total sales this year")

## TABLES & FULL DATA

- When the user asks for a table, a list, or "top N", show only a PREVIEW in your text answer — at most the first ~15 rows — together with your insights. Do NOT paste the entire result set as text.
- The COMPLETE result set is automatically shown to the user in a separate sortable/filterable table with one-click Excel export, rendered right below your reply. Tell the user the full table (all rows) is there to open, sort, filter and export.
- For pure aggregate/summary questions (totals, averages, a single top-N metric), just give the numbers and insight — no row list.
- Each \`fetch_tevanaot_data\` result returns up to 100 rows; if the full set is larger, say so and offer to narrow (tighter date range, top-N).
- ALWAYS pass a short \`table_title\` describing that specific table, in the SAME language the user used (Hebrew if they wrote Hebrew). It is shown as the heading of the full-data table the user can open. Give each table its own distinct title when you make several calls in one turn.`,

      model: process.env.TEVANAOT_CREW_MODEL || 'gpt-4o',
      // Higher cap so a full table of up to 100 rows can be rendered without the
      // model running out of output budget and truncating the list mid-table.
      maxTokens: 8192,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,

      tools: [
        {
          name: 'fetch_tevanaot_data',
          description: 'Fetch real business data from the Teva Naot database. Pass a natural language question and get back the relevant data.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The business question to answer. Hebrew or English. Examples: "total sales this month", "top 10 models by quantity", "inventory by store"',
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
      console.log('Teva Naot data fetch: "' + question + '"');

      const result = await dataQueryService.queryByQuestion(question, 'tevanaot', {
        maxRows: 100,
        agentName: 'tevanaot',
        llmAgentName: this._agentName,
        conversationId: this._externalConversationId,
        userId: this._userId,
      });

      if (this._externalConversationId && result.sql) {
        thinkingService.addFunctionCallStep(
          this._externalConversationId,
          'fetch_tevanaot_data',
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
      console.error('Teva Naot data fetch failed:', err);
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

module.exports = TevaNaotCrew;
