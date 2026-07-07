/**
 * Zer4U Crew Member
 *
 * Financial advisor for Zer4U flower shop business
 * Connects to REAL DATA from PostgreSQL zer4u schema via the zer4u-specific DB pool.
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool: getZer4uPool } = require('../../../services/db.zer4u');

class Zer4UCrew extends CrewMember {
  constructor() {
    super({
      name: 'zer4u',
      displayName: 'Zer4U',
      description: 'Financial advisor with access to real Zer4U flower shop data',
      isDefault: false,

      guidance: `You are a financial business intelligence advisor for Zer4U, a flower shop business in Israel.

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

- **ALWAYS respond in the same language the user asks the question**
  - If user asks in English → respond in English
  - If user asks in Hebrew → respond in Hebrew
- Professional but friendly
- Include Hebrew business terms when relevant (with English translation in parentheses)
- Provide context with numbers (e.g., "Sales of ₪1.2M is 15% above target")
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

User: "What were our total sales last month?"
You: *Call fetch_zer4u_data("total sales last month")* → Analyze results → "Last month's sales were ₪X, which is Y% compared to the previous month..."

User: "Which products are selling best?"
You: *Call fetch_zer4u_data("top selling products")* → "The best-selling products are: 1. [Product] with ₪X in sales..."

User: "How's our inventory situation?"
You: *Call fetch_zer4u_data("current inventory levels by product")* → "Here's the current inventory status..."`,

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
                description: 'The business question to answer. Can be in Hebrew or English. Examples: "total sales last month", "top 10 customers", "inventory levels for roses"'
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

    // Use the zer4u-specific DB pool — the zer4u schema lives in a separate database
    this._dataQueryService = new DataQueryService(getZer4uPool());
  }

  /**
   * Handle data fetch tool call
   */
  async handleDataFetch(params) {
    const { question, table_title } = params;
    const thinkingService = require('../../../services/thinking.service');
    const tableFormatService = require('../../../services/table-format.service');

    try {
      console.log(`Zer4U Data Fetch: "${question}"`);

      const result = await this._dataQueryService.queryByQuestion(
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
      console.error('Data fetch failed:', error);
      return {
        error: true,
        message: error.message,
        suggestion: 'There was an error fetching the data. Please try a different question.'
      };
    }
  }

}

module.exports = Zer4UCrew;
