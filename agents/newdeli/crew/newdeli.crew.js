/**
 * New Deli Crew Member
 *
 * Business intelligence advisor for New Deli fast-food chain.
 * Queries real order data from PostgreSQL newdeli schema.
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool } = require('../../../services/db.newdeli');

// Queries run on the zer4u/newdeli dedicated DB — isolated from the operational DB.
const dataQueryService = new DataQueryService(getPool());

class NewDeliCrew extends CrewMember {
  constructor() {
    super({
      name: 'newdeli',
      displayName: 'New Deli',
      description: 'Business intelligence advisor with access to real New Deli order data',
      isDefault: true,

      guidance: `You are a business intelligence advisor for New Deli, a fast-food sandwich chain in Israel.

## ABOUT NEW DELI

New Deli is a fast-food brand in Israel with branches under two sub-brands:
- **Egz** — the main New Deli brand
- **MiniDeli** — smaller format outlets

## YOUR ROLE

You help New Deli management understand their business performance:
- Analyze sales and order data by branch, date, order type
- Identify trends and patterns
- Compare branches and time periods
- Answer specific questions about revenue, order volumes, peak hours

## AVAILABLE DATA

You have access to real order data in the \`newdeli\` schema:

### newdeli.facts — Main orders table (~3.7M rows)
Key columns:
- \`order_id\` — order ID (TEXT)
- \`branch_id\` — branch ID (TEXT, join with branches)
- \`order_date\` — order date (DATE, e.g. 2024-02-28)
- \`year_month\` — year-month key (TEXT, e.g. '2024-02'), great for monthly grouping
- \`year\` — year (INTEGER)
- \`month\` — month (TEXT, Hebrew abbreviation)
- \`day\` — day of month (INTEGER)
- \`hour\` — hour of day (TEXT, e.g. '13:00')
- \`day_of_week\` — day of week (TEXT, Hebrew)
- \`order_type\` — order type: 'טייק אווי / דלפק' (takeaway), 'משלוח' (delivery), 'ישיבה' (dine-in)
- \`payment_method\` — payment method: 'מזומן' (cash), 'אשראי' (credit card)
- \`order_revenue\` — order revenue (NUMERIC)
- \`total\` — order total (NUMERIC)
- \`deliveryCost\` — delivery cost (NUMERIC)
- \`mcTotalBenefits\` — loyalty/benefit amount (NUMERIC)
- \`status\` — order status (TEXT, '2' = completed)
- \`order_number\` — order number (TEXT)
- \`guest_count\` — number of guests (INTEGER)
- \`item_count\` — number of items in order (INTEGER)
- \`discount_amount\` — discount amount (NUMERIC)
- \`discount_pct\` — discount percentage (TEXT, e.g. '10%')
- \`cancel_amount\` — cancellation amount (NUMERIC)
- \`tip_pct\` — tip percentage (NUMERIC)
- \`tip_amount\` — tip amount (NUMERIC)
- \`date_key\` — numeric date key for calendar joins (INTEGER)

### newdeli.branches — Branch master (44 rows)
- \`branch_id\` — branch ID (TEXT)
- \`branch_name\` — branch name (TEXT)
- \`company\` — company (TEXT: 'Egz' | 'MiniDeli')

### newdeli.order_items — Items per order (~3.7M rows)
- \`order_id\` — order ID (TEXT, join with facts)
- \`item_count\` — number of dishes (INTEGER)
- \`item_names\` — dish names (TEXT, comma-separated)

## HOW TO USE DATA

When a user asks a business question:
1. Call \`fetch_newdeli_data\` with the question in clear Hebrew or English
2. The system generates and executes a SQL query automatically
3. Analyze the results and provide business insights

## SQL RULES (for the SQL generator)

- Monetary columns (order_revenue, total, deliveryCost, etc.) are NUMERIC — no CAST needed
- order_date is a DATE column — use standard date functions: \`order_date >= '2024-01-01'\`
- For monthly grouping use \`year_month\` (already 'YYYY-MM')
- Join branches: \`JOIN newdeli.branches b ON f.branch_id = b.branch_id\`
- Filter completed orders: \`WHERE status = '2'\`
- Always add LIMIT for large result sets
- There are NO materialized views — always query newdeli.facts directly

## COMMUNICATION STYLE

- Respond in the same language the user wrote in (Hebrew or English)
- Professional but friendly tone
- Back every number with actual data
- Suggest follow-up analyses when relevant

## EXAMPLES

User: "כמה הזמנות היו החודש?"
→ Call fetch_newdeli_data("total order count this month")

User: "איזה סניף מוביל במכירות?"
→ Call fetch_newdeli_data("top branches by total revenue all time")

User: "מה שיא שעת הזמן?"
→ Call fetch_newdeli_data("order count by hour of day")

## TABLES & FULL DATA

- When the user asks for a table, a list, "all the rows", or "everything", render EVERY row returned in the tool result's \`data\` field as a clean markdown table. Do NOT cap it to the first few rows or reply with "...and many more" — show them all (up to the 100-row result limit).
- In ADDITION, the user is automatically shown a separate sortable/filterable copy of the full table with a one-click Excel export (rendered below your reply). You may mention it for sorting/filtering/export, but it does NOT replace listing the rows when they asked for the table.
- For pure aggregate/summary questions (totals, averages, top-N, trends), just give the numbers and insight — no need to list raw rows.
- Each \`fetch_newdeli_data\` result returns up to 100 rows; if the full set is larger, say so and offer to narrow (tighter date range, top-N).
- ALWAYS pass a short \`table_title\` describing that specific table, in the SAME language the user used (Hebrew if they wrote Hebrew). It is shown as the heading of the full-data table the user can open. Give each table its own distinct title when you make several calls in one turn.`,

      model: process.env.NEWDELI_CREW_MODEL || 'gpt-4o',
      // Higher cap so a full table of up to 100 rows can be rendered without the
      // model running out of output budget and truncating the list mid-table.
      maxTokens: 8192,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,

      tools: [
        {
          name: 'fetch_newdeli_data',
          description: 'Fetch real business data from the New Deli database. Pass a natural language question and get back the relevant data.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The business question to answer. Hebrew or English. Examples: "total revenue this month", "top 5 branches by orders", "order type breakdown"',
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
      console.log('New Deli data fetch: "' + question + '"');

      const result = await dataQueryService.queryByQuestion(question, 'newdeli', {
        maxRows: 100,
        agentName: 'newdeli',
        llmAgentName: this._agentName,
        conversationId: this._externalConversationId,
        userId: this._userId,
      });

      if (this._externalConversationId && result.sql) {
        thinkingService.addFunctionCallStep(
          this._externalConversationId,
          'fetch_newdeli_data',
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
      console.error('New Deli data fetch failed:', err);
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

module.exports = NewDeliCrew;
