/**
 * Zer4U Crew Member
 *
 * Financial advisor for Zer4U flower shop business
 * Connects to REAL DATA from PostgreSQL zer4u schema
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool } = require('../../../services/db.zer4u');

// Zer4U queries run against the dedicated zer4u database (not the shared operational DB).
const dataQueryService = new DataQueryService(getPool());

class Zer4UCrew extends CrewMember {
  constructor() {
    super({
      name: 'zer4u',
      displayName: 'Zer4U',
      description: 'Financial advisor with access to real Zer4U flower shop data',
      isDefault: true,

      guidance: `You are a financial business intelligence advisor for Zer4U, a flower shop business in Israel.

## DATA FRESHNESS

The context object includes a \`dataLastUpdated\` field with the date of the most recent sales record in the database.
- Always keep this in mind when answering questions about recent periods.
- If a user asks "how up to date is the data?" or "until when is the data?", tell them the date from \`dataLastUpdated\`.
- You can also proactively mention it when answering questions about the current month or recent period.

## YOUR ROLE

You help business owners and managers understand their financial performance by:
- Analyzing sales data, inventory, customer behavior
- Identifying trends and patterns
- Providing actionable insights and recommendations
- Answering specific questions about business metrics

## YOUR CAPABILITIES

You have access to REAL business data including:
- **Sales** (מכירות) - All sales transactions with details
- **Inventory** (מלאי) - Current stock levels and warehouse inventory
- **Items** (פריטים) - Product catalog with descriptions and pricing
- **Customers** (לקוחות) - Customer information
- **Stores** (חנויות) - Store locations and performance
- **Targets** (יעדים) - Business goals and targets
- **Calendar** - Date dimensions for time-based analysis
- **Employee data** - Staff costs and assignments
- And more...

## HOW TO USE DATA

When a user asks a business question that requires data:
1. Use the \`fetch_zer4u_data\` function
2. Pass the question in simple, clear Hebrew or English
3. The system will automatically:
   - Generate the appropriate SQL query
   - Execute it on the real database
   - Return the results to you
4. Analyze the results and provide insights

## COMMUNICATION STYLE

- **ALWAYS respond in the same language the user wrote in**
  - If user writes in English → respond in English
  - If user writes in Hebrew → respond in Hebrew
  - Never switch languages unless the user does
- Professional but friendly
- Include relevant business terms
- Provide context with numbers (e.g., "מכירות של ₪1.2M הן 15% מעל היעד")
- Ask clarifying questions if the request is ambiguous
- Suggest related analyses that might be valuable

## IMPORTANT RULES

- Always base answers on actual data (don't make up numbers)
- If data isn't available, say so clearly
- Explain trends and patterns, not just raw numbers
- Provide actionable recommendations when relevant
- Use visualizations descriptions when helpful (tables, trends, comparisons)

## VAT (מע"מ)

- All monetary figures in the data (sales, revenue, cost, profit) are **EXCLUDING VAT** (לפני מע"מ / ללא מע"מ). This is the default and the business standard here.
- **ALWAYS state explicitly whether the figures include or exclude VAT.** Since the data is before VAT, attach a clear note to every monetary answer — e.g. "(ללא מע״מ)" when answering in Hebrew, or "(excluding VAT)" when answering in English.
- If the user asks for amounts *including* VAT (כולל מע"מ), explain that the data is reported before VAT (ללא מע"מ) and that you cannot add VAT unless they confirm the rate.
- Never present a money figure without making the VAT basis clear.

## TABLES & FULL DATA

- When the user asks for a table, a list, or "top N", show only a PREVIEW in your text answer — at most the first ~15 rows — together with your insights. Do NOT paste the entire result set as text.
- The COMPLETE result set is automatically shown to the user in a separate sortable/filterable table with one-click Excel export, rendered right below your reply. Tell the user the full table (all rows) is there to open, sort, filter and export.
- For pure aggregate/summary questions (totals, averages, a single top-N metric), just give the numbers and insight — no row list.
- Each \`fetch_zer4u_data\` result returns up to 100 rows; if the full set is larger, say so and offer to narrow (tighter date range, top-N).
- ALWAYS pass a short \`table_title\` describing that specific table, in the SAME language the user used (Hebrew if they wrote Hebrew). It is shown as the heading of the full-data table the user can open. Give each table its own distinct title when you make several calls in one turn.

## EXAMPLES

User: "מה היו המכירות הכוללות החודש?"
You: *Call fetch_zer4u_data("total sales this month")* → "המכירות החודש היו ₪X, שהן Y% לעומת החודש הקודם..."

User: "אילו מוצרים נמכרים הכי טוב?"
You: *Call fetch_zer4u_data("top selling products")* → "המוצרים הנמכרים ביותר הם: 1. [מוצר] עם ₪X במכירות..."

User: "מה מצב המלאי?"
You: *Call fetch_zer4u_data("current inventory levels by product")* → "הנה מצב המלאי הנוכחי..."`,

      model: process.env.ZER4U_CREW_MODEL || 'gpt-4o',
      // Higher cap so a full table of up to 100 rows can be rendered without the
      // model running out of output budget and truncating the list mid-table.
      maxTokens: 8192,

      fieldsToCollect: [],

      transitionTo: null,
      transitionSystemPrompt: null,

      tools: [
        {
          name: 'fetch_zer4u_data',
          description: 'Fetch real business data from the Zer4U database. Pass a natural language question and get back the relevant data.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The business question to answer. Can be in Hebrew or English. Examples: "total sales last month", "top 10 customers", "inventory levels"'
              },
              table_title: {
                type: 'string',
                description: 'A SHORT title for the resulting table, in the SAME language the user used (e.g. Hebrew), describing what this specific table shows (max ~8 words). Shown above the full-data table in the UI. Example: "100 המוצרים הנמכרים ביותר ב-2026".'
              }
            },
            required: ['question']
          },
          handler: async (params) => {
            return await this.handleDataFetch(params);
          }
        }
      ],

      knowledgeBase: null
    });
  }

  /**
   * Handle data fetch tool call
   */
  async handleDataFetch(params) {
    const { question, table_title } = params;
    const thinkingService = require('../../../services/thinking.service');

    try {
      console.log(`🔍 Zer4U Data Fetch: "${question}"`);

      const result = await dataQueryService.queryByQuestion(
        question,
        'zer4u',
        {
          maxRows: 100,
          agentName: 'zer4u',
          llmAgentName: this._agentName,
          conversationId: this._externalConversationId,
          userId: this._userId,
        }
      );

      if (this._externalConversationId && result.sql) {
        thinkingService.addFunctionCallStep(
          this._externalConversationId,
          'fetch_zer4u_data',
          { question, sql: result.sql, explanation: result.explanation },
          `Fetching data: ${question}`
        );
      }

      if (result.timeout) {
        return {
          error: true,
          timeout: true,
          message: result.message,
          suggestion: 'Try a more specific question or a narrower date range (e.g. "this week" instead of "this year").'
        };
      }

      if (result.error) {
        return {
          error: true,
          message: `Unable to fetch data: ${result.message}`,
          suggestion: 'Try rephrasing your question or asking about a different metric.'
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
        summary: this._summarizeData(result.data, result.columns)
      };

    } catch (error) {
      console.error('❌ Data fetch failed:', error);
      return {
        error: true,
        message: error.message,
        suggestion: 'There was an error fetching the data. Please try a different question.'
      };
    }
  }

  /**
   * Inject data freshness date into the LLM context.
   * Reads agents.data_updated_at for zer4u so the crew can tell users
   * when the data was last updated without a separate query.
   */
  async getAdditionalContext(params) {
    // Derive "data through" from the SAME live source as the dashboard banner —
    // the exact MAX(sale_date) in zer4u.sales — so the agent and the banner always
    // agree. The customer needs to know precisely which day the data is current
    // through, not just the month. The cached agents.data_updated_at can drift (it
    // failed to update on some reloads), which made the agent report a stale value.
    try {
      const { getPool } = require('../../../services/db.zer4u');
      const r = await getPool().query(
        `SELECT TO_CHAR(MAX(sale_date), 'YYYY-MM-DD') AS d FROM zer4u.sales`
      );
      const d = r.rows[0]?.d; // e.g. "2026-04-30"
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        const [y, mo, day] = d.split('-').map(Number);
        // Exact day granularity ("30 April 2026"). sale_date is a DATE column, so
        // there is no hour component to report.
        const formatted = new Date(Date.UTC(y, mo - 1, day))
          .toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
        return { dataLastUpdated: formatted };
      }
    } catch {
      // fall through to the cached value
    }
    // Fallback: cached agents.data_updated_at (main DB)
    try {
      const db = require('../../../services/db.pg');
      const result = await db.query(
        `SELECT data_updated_at FROM agents WHERE url_slug = 'zer4u' LIMIT 1`
      );
      const date = result.rows[0]?.data_updated_at;
      if (date) {
        const formatted = new Date(date).toLocaleDateString('en-GB', {
          day: '2-digit', month: '2-digit', year: 'numeric'
        });
        return { dataLastUpdated: formatted };
      }
    } catch {
      // Best-effort — do not block the crew if DB is unreachable
    }
    return {};
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
    summary += 'The COMPLETE result set (all ' + data.length + ' rows) is in the `data` field AND is shown to the user in a downloadable sortable table below your reply. '
      + 'In your text answer show only a PREVIEW — at most the first ~15 rows — plus insights; do NOT paste all rows. '
      + 'For aggregate/summary questions, lead with the key numbers instead.\n';

    const numericCols = this._findNumericColumns(data[0]);
    if (numericCols.length > 0) {
      summary += '\nNumeric totals across all ' + data.length + ' rows:\n';
      for (const col of numericCols.slice(0, 5)) {
        const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v));
        if (values.length > 0) {
          const sum = values.reduce((a, b) => a + b, 0);
          summary += `- ${col}: Sum=${sum.toLocaleString()}, Avg=${(sum / values.length).toFixed(2)}\n`;
        }
      }
    }

    return summary;
  }

  _findNumericColumns(row) {
    if (!row) return [];
    return Object.keys(row).filter(key => {
      const value = row[key];
      return typeof value === 'number' || (!isNaN(parseFloat(value)) && isFinite(value));
    });
  }
}

module.exports = Zer4UCrew;
