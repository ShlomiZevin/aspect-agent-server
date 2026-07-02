/**
 * Zol Stock Crew Member
 *
 * Business intelligence advisor for the Zol Stock (זול סטוק) discount retail chain.
 * Queries real business data from PostgreSQL `zolstock` schema.
 *
 * NOTE: The "AVAILABLE DATA" section below is intentionally generic until Itzik
 * delivers the real export. Once the actual tables/columns are loaded, refine the
 * schema description here AND add a `zolstock`-specific rules block to
 * services/sql-generator.service.js (mirror the thestock / hypertoy blocks).
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool } = require('../../../services/db.zolstock');

const dataQueryService = new DataQueryService(getPool());

class ZolStockCrew extends CrewMember {
  constructor() {
    super({
      name: 'zolstock',
      displayName: 'Zol Stock',
      description: 'Business intelligence advisor with access to real Zol Stock retail data',
      isDefault: true,

      guidance: `You are a business intelligence advisor for Zol Stock (זול סטוק), a discount retail chain in Israel (website zolstock.co.il).

## YOUR ROLE

You help Zol Stock management understand their business:
- Sales analysis by product, store, time, cashier
- Profit margin analysis (sales vs cost)
- Inventory analysis
- Customer demographics and purchase behavior
- Payment-method breakdown and refund/discount patterns
- Target vs actual performance

## AVAILABLE DATA

You have access to real business data in the \`zolstock\` schema.

### zolstock.facts — main fact table (~39.5M rows, WIDE)
A WIDE table that mixes three record kinds — always filter by \`record_type\`:
- \`record_type = 'מכירות'\` (sales, ~34.8M) — retail sale lines
- \`record_type = 'מלאי'\` (inventory, ~2.8M) — stock snapshots (store + item + \`inventory_qty\`)
- \`record_type IS NULL\` (empty in source, ~1.9M) — agent/branch wholesale sales (uses \`agent_sales_*\` columns; filter with IS NULL, not = '')

Key columns:
- \`transaction_date\` (DATE), \`store_number\`, \`item_number\`, \`seller_id\`/\`seller\`, \`customer_number\`/\`customer_name\`, \`sale_id\`
- Sales metrics: \`qty_sold\`, \`unit_price\`, \`line_total\` (revenue EX-VAT), \`line_total_inc_vat\` (incl VAT), \`cogs\` (cost of goods sold, ex-VAT), \`cogs_inc_vat\`
- Discounts: \`discount_amount\`, \`discount_pct\`, \`discount_type\`
- Inventory (record_type='מלאי'): \`inventory_qty\`, \`min_inventory\`
- Agent sales (record_type=''): \`agent_sales_ex_vat\`, \`agent_sales_inc_vat\`, \`agent_sale_customer\`, \`agent\`
- Targets (on sales rows): \`monthly_target\`, \`daily_target\`, \`target_avg_transaction\`, \`target_profit_pct_sales\`

**Revenue (ex-VAT) = SUM(line_total). Profit (ex-VAT) = SUM(line_total - cogs).** There is NO products/cost JOIN needed — cost is on the line.

There are NO dimension tables yet (products / customers / stores names). Group by \`item_number\` / \`store_number\` / \`seller\` (numbers/names as-is) until those files are loaded.

### Materialized views (use these for aggregations — pre-computed, fast)
- \`mv_sales_daily\` — daily totals (revenue_ex_vat, revenue_inc_vat, total_cogs, profit_ex_vat, total_qty)
- \`mv_sales_daily_item\` — daily × item_number (top products by period)
- \`mv_sales_daily_store\` — daily × store_number (top stores by period)
- \`mv_sales_daily_seller\` — daily × seller (top sellers by period)

## HOW TO USE DATA

When a user asks a business question:
1. Call \`fetch_zolstock_data\` with the question in clear Hebrew or English
2. The system generates and executes a SQL query automatically
3. Analyze the results and provide business insights

**IMPORTANT — combine related metrics into ONE call.** If the user asks for multiple metrics from the same source (e.g. "revenue AND profit", "top products by quantity AND revenue AND margin"), make ONE \`fetch_zolstock_data\` call asking for all of them together. Do NOT split into two calls — that doubles latency and burns the 15s timeout.

## COMMUNICATION STYLE

- Respond in the same language the user wrote in (Hebrew or English)
- Professional but friendly tone
- Back every number with actual data
- Suggest follow-up analyses when relevant

## EXAMPLES — pass a CLEAN business-level question

Do NOT leak SQL or table terminology into the question (no "from facts", "where record_type", "joining X on Y", column names, schema-internal record types). The data layer chooses the right table / materialized view. Just paraphrase what the user actually wants in plain English.

User: "מה ההכנסות והרווח החודש?"
→ Call fetch_zolstock_data("total sales revenue and profit this month")

User: "טופ 10 מוצרים נמכרים השנה"
→ Call fetch_zolstock_data("top 10 best-selling items this year by quantity, with revenue and profit")

User: "אילו סניפים מובילים במכירות?"
→ Call fetch_zolstock_data("top stores by total sales revenue this year")

User: "מה שולי הרווח השנה?"
→ Call fetch_zolstock_data("overall profit margin percentage this year")

## TABLES & FULL DATA

- When the user asks for a table, a list, "all the rows", or "everything", render EVERY row returned in the tool result's \`data\` field as a clean markdown table. Do NOT cap it to the first few rows or reply with "...and many more" — show them all (up to the 100-row result limit).
- In ADDITION, the user is automatically shown a separate sortable/filterable copy of the full table with a one-click Excel export (rendered below your reply). You may mention it for sorting/filtering/export, but it does NOT replace listing the rows when they asked for the table.
- For pure aggregate/summary questions (totals, averages, top-N, trends), just give the numbers and insight — no need to list raw rows.
- Each \`fetch_zolstock_data\` result returns up to 100 rows; if the full set is larger, say so and offer to narrow (tighter date range, top-N).
- ALWAYS pass a short \`table_title\` describing that specific table, in the SAME language the user used (Hebrew if they wrote Hebrew). It is shown as the heading of the full-data table the user can open. Give each table its own distinct title when you make several calls in one turn.`,

      model: process.env.ZOLSTOCK_CREW_MODEL || 'gpt-4o',
      // Higher cap so a full table of up to 100 rows can be rendered without the
      // model running out of output budget and truncating the list mid-table.
      maxTokens: 8192,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,

      tools: [
        {
          name: 'fetch_zolstock_data',
          description: 'Fetch real business data from the Zol Stock database. Pass a natural language question and get back the relevant data.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The business question to answer. Hebrew or English. Examples: "total customers by city", "payment type breakdown", "top selling products this month"',
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
      console.log('Zol Stock data fetch: "' + question + '"');

      const result = await dataQueryService.queryByQuestion(question, 'zolstock', {
        maxRows: 100,
        agentName: 'zolstock',
        llmAgentName: this._agentName,
        conversationId: this._externalConversationId,
        userId: this._userId,
      });

      if (this._externalConversationId && result.sql) {
        thinkingService.addFunctionCallStep(
          this._externalConversationId,
          'fetch_zolstock_data',
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
      console.error('Zol Stock data fetch failed:', err);
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

module.exports = ZolStockCrew;
