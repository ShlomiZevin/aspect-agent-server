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

- When the user asks for a table, a list, "all the rows", or "everything", render EVERY row returned in the tool result's \`data\` field as a clean markdown table. Do NOT cap it to the first few rows or reply with "...and many more" — show them all (up to the 100-row result limit).
- In ADDITION, the user is automatically shown a separate sortable/filterable copy of the full table with a one-click Excel export (rendered below your reply). You may mention it for sorting/filtering/export, but it does NOT replace listing the rows when they asked for the table.
- For pure aggregate/summary questions (totals, averages, top-N, trends), just give the numbers and insight — no need to list raw rows.
- Each \`fetch_zer4u_data\` result returns up to 100 rows; if the full set is larger, say so and offer to narrow (tighter date range, top-N).
- ALWAYS pass a short \`table_title\` describing that specific table, in the SAME language the user used (Hebrew if they wrote Hebrew). It is shown as the heading of the full-data table the user can open. Give each table its own distinct title when you make several calls in one turn.

## EXAMPLES

User: "What were our total sales last month?"
You: *Call fetch_zer4u_data("total sales last month")* → Analyze results → "Last month's sales were ₪X, which is Y% compared to the previous month..."

User: "Which products are selling best?"
You: *Call fetch_zer4u_data("top selling products")* → "The best-selling products are: 1. [Product] with ₪X in sales..."

User: "How's our inventory situation?"
You: *Call fetch_zer4u_data("current inventory levels by product")* → "Here's the current inventory status..."`,

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

    try {
      console.log(`Zer4U Data Fetch: "${question}"`);

      const result = await this._dataQueryService.queryByQuestion(
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
      console.error('Data fetch failed:', error);
      return {
        error: true,
        message: error.message,
        suggestion: 'There was an error fetching the data. Please try a different question.'
      };
    }
  }

  /**
   * Summarize data for LLM consumption. Does NOT re-dump a truncated slice of
   * rows (that used to prime the model to answer with only the first ~20 rows).
   * The COMPLETE set is already in the tool result's `data` field; here we state
   * the row count, point the model at `data`, and give cheap numeric totals.
   * @private
   */
  _summarizeData(data, columns) {
    if (!data || data.length === 0) return 'No data found.';

    let summary = `Found ${data.length} record${data.length === 1 ? '' : 's'}.\n`;
    summary += 'The COMPLETE result set (all ' + data.length + ' rows) is in the `data` field of this tool result. '
      + 'If the user asked for a table, a list, or "all the rows", render EVERY one of these ' + data.length + ' rows — '
      + 'do not show only a sample or truncate. For aggregate/summary questions, lead with the key numbers instead.\n';

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

  /** @private */
  _findNumericColumns(row) {
    if (!row) return [];
    // pg returns NUMERIC/DECIMAL as strings — accept both JS numbers and numeric strings
    return Object.keys(row).filter(key => {
      const v = row[key];
      return typeof v === 'number' || (!isNaN(parseFloat(v)) && isFinite(v));
    });
  }
}

module.exports = Zer4UCrew;
