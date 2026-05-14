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

## EXAMPLES

User: "What were our total sales last month?"
You: *Call fetch_zer4u_data("total sales last month")* → Analyze results → "Last month's sales were ₪X, which is Y% compared to the previous month..."

User: "Which products are selling best?"
You: *Call fetch_zer4u_data("top selling products")* → "The best-selling products are: 1. [Product] with ₪X in sales..."

User: "How's our inventory situation?"
You: *Call fetch_zer4u_data("current inventory levels by product")* → "Here's the current inventory status..."`,

      model: process.env.ZER4U_CREW_MODEL || 'gpt-4o',
      maxTokens: 4096,

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
    const { question } = params;
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
   * Summarize data for LLM consumption — show all rows up to 20, then first 20 + stats.
   * Keeping the payload small avoids bloating the context window.
   * @private
   */
  _summarizeData(data, columns) {
    if (!data || data.length === 0) return 'No data found.';

    const MAX_DISPLAY = 20;
    let summary = `Found ${data.length} records.\n\n`;

    const displayData = data.slice(0, MAX_DISPLAY);
    summary += data.length > MAX_DISPLAY
      ? `First ${MAX_DISPLAY} of ${data.length} records:\n`
      : 'All records:\n';
    summary += JSON.stringify(displayData, null, 2);

    if (data.length > MAX_DISPLAY) {
      summary += `\n\n... and ${data.length - MAX_DISPLAY} more records.`;

      const numericCols = this._findNumericColumns(data[0]);
      if (numericCols.length > 0) {
        summary += '\n\nNumeric summaries:\n';
        for (const col of numericCols.slice(0, 3)) {
          const values = data.map(row => row[col]).filter(v => typeof v === 'number');
          if (values.length > 0) {
            const sum = values.reduce((a, b) => a + b, 0);
            summary += `- ${col}: Sum=${sum.toLocaleString()}, Avg=${(sum / values.length).toFixed(2)}, Min=${Math.min(...values)}, Max=${Math.max(...values)}\n`;
          }
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
