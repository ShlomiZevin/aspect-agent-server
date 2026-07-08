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

- The tool result's \`summary\` field already contains a FULLY FORMATTED markdown table — either the COMPLETE result (20 rows or fewer) or a 20-row preview (when there are more). When the user asks for a table, a list, or "top N", paste that table into your reply EXACTLY as given. Do NOT retype it, reorder its columns, translate its headers, or reformat its numbers yourself — it must look identical to the table/export the user can open below; any mismatch is a bug.
- If the result has MORE than 20 rows, the user is automatically shown a separate paginated table with a full Excel export of every row (not just the 20 in your preview), rendered right below your reply. Tell the user the full table (all rows) is there to open, sort/paginate and export. For 20 rows or fewer there is no separate viewer — the table you pasted already IS the complete data.
- For pure aggregate/summary questions (totals, averages, a single top-N metric), you may skip the table and just give the numbers and insight.
- \`fetch_zer4u_data\` returns the complete matching result set (practically unlimited, not row-capped).
- ALWAYS pass a short \`table_title\` describing that specific table, in the SAME language the user used (Hebrew if they wrote Hebrew). It is shown as the heading of the full-data table the user can open. Give each table its own distinct title when you make several calls in one turn.
- **NEVER claim a table/export exists unless YOU JUST called \`fetch_zer4u_data\` THIS turn and got a result back.** If you (or an earlier turn) asked the user a clarifying question and they reply "yes" / "all" / "sure" / anything short, that reply is NOT data — call \`fetch_zer4u_data\` again in this turn with the clarified question before saying anything about a table. Saying "the full table is shown below" without a fresh tool call in the same turn is a hallucination.

## EXAMPLES

User: "מה היו המכירות הכוללות החודש?"
You: *Call fetch_zer4u_data("total sales this month")* → "המכירות החודש היו ₪X, שהן Y% לעומת החודש הקודם..."

User: "אילו מוצרים נמכרים הכי טוב?"
You: *Call fetch_zer4u_data("top selling products")* → "המוצרים הנמכרים ביותר הם: 1. [מוצר] עם ₪X במכירות..."

User: "מה מצב המלאי?"
You: *Call fetch_zer4u_data("current inventory levels by product")* → "הנה מצב המלאי הנוכחי..."`,

      // gpt-4o unreliably followed the "paste the formatted table verbatim"
      // instruction (retranslated headers, drifted into numbered lists on
      // longer tables) — gpt-5-chat-latest complies consistently (same
      // switch already proven out for hypertoy, see project memory).
      model: process.env.ZER4U_CREW_MODEL || 'gpt-5-chat-latest',
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
    const tableFormatService = require('../../../services/table-format.service');

    try {
      console.log(`🔍 Zer4U Data Fetch: "${question}"`);

      const result = await dataQueryService.queryByQuestion(
        question,
        'zer4u',
        {
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

      return tableFormatService.buildFetchResult({ question, tableTitle: table_title, schema: 'zer4u', result });

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
}

module.exports = Zer4UCrew;
