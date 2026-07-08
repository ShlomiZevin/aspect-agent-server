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

- The tool result's \`summary\` field already contains a FULLY FORMATTED markdown table — either the COMPLETE result (20 rows or fewer) or a 20-row preview (when there are more). When the user asks for a table, a list, or "top N", paste that table into your reply EXACTLY as given. Do NOT retype it, reorder its columns, translate its headers, or reformat its numbers yourself — it must look identical to the table/export the user can open below; any mismatch is a bug.
- If the result has MORE than 20 rows, the user is automatically shown a separate paginated table with a full Excel export of every row (not just the 20 in your preview), rendered right below your reply. Tell the user the full table (all rows) is there to open, sort/paginate and export. For 20 rows or fewer there is no separate viewer — the table you pasted already IS the complete data.
- For pure aggregate/summary questions (totals, averages, a single top-N metric), you may skip the table and just give the numbers and insight.
- \`fetch_zolstock_data\` returns the complete matching result set (practically unlimited, not row-capped).
- ALWAYS pass a short \`table_title\` describing that specific table, in the SAME language the user used (Hebrew if they wrote Hebrew). It is shown as the heading of the full-data table the user can open. Give each table its own distinct title when you make several calls in one turn.
- **NEVER claim a table/export exists unless YOU JUST called \`fetch_zolstock_data\` THIS turn and got a result back.** If you (or an earlier turn) asked the user a clarifying question and they reply "yes" / "all" / "sure" / anything short, that reply is NOT data — call \`fetch_zolstock_data\` again in this turn with the clarified question before saying anything about a table. Saying "the full table is shown below" without a fresh tool call in the same turn is a hallucination.`,

      // gpt-4o unreliably followed the "paste the formatted table verbatim"
      // instruction (drifted into numbered lists on longer tables) —
      // gpt-5-chat-latest complies consistently (same switch already proven
      // out for hypertoy, see project memory).
      model: process.env.ZOLSTOCK_CREW_MODEL || 'gpt-5-chat-latest',
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
    const tableFormatService = require('../../../services/table-format.service');

    try {
      console.log('Zol Stock data fetch: "' + question + '"');

      const result = await dataQueryService.queryByQuestion(question, 'zolstock', {
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

      return tableFormatService.buildFetchResult({ question, tableTitle: table_title, schema: 'zolstock', result });
    } catch (err) {
      console.error('Zol Stock data fetch failed:', err);
      return {
        error: true,
        message: err.message,
        suggestion: 'There was an error fetching the data. Please try a different question.',
      };
    }
  }
}

module.exports = ZolStockCrew;
