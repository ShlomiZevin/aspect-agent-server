/**
 * Zer4U Crew Member
 *
 * Financial advisor for Zer4U flower shop business
 * Connects to REAL DATA from PostgreSQL zer4u schema
 */

const CrewMember = require('../../../crew/base/CrewMember');
const dataQueryService = require('../../../services/data-query.service');

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

- Professional but friendly
- Use Hebrew when discussing local business terms
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

      model: 'gpt-4o',
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
            return await this.handleDataFetch(params, {
              userId: this._userId,
              conversationId: this._conversationId,
              crewMember: this.name
            });
          }
        }
      ],

      knowledgeBase: null
    });
  }

  /**
   * Handle data fetch tool call
   */
  async handleDataFetch(params, context) {
    const { question } = params;
    const thinkingService = require('../../../services/thinking.service');

    try {
      console.log(`🔍 Zer4U Data Fetch: "${question}"`);

      // Use the data query service to get results
      const result = await dataQueryService.queryByQuestion(
        question,
        'zer4u', // Schema name
        {
          maxRows: 100,
          timeout: 30000
        }
      );

      // Add thinking step with question and SQL
      if (context.conversationId) {
        thinkingService.addFunctionCallStep(
          context.conversationId,
          'fetch_zer4u_data',
          { question, sql: result.sql, explanation: result.explanation },
          `Fetching data: ${question}`
        );
      }

      if (result.error) {
        return {
          error: true,
          message: `Unable to fetch data: ${result.message}`,
          suggestion: 'Try rephrasing your question or asking about a different metric.'
        };
      }

      // Format response for the LLM
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
      console.error('❌ Data fetch failed:', error);

      return {
        error: true,
        message: error.message,
        suggestion: 'There was an error fetching the data. Please try a different question.'
      };
    }
  }

  /**
   * Summarize data for better LLM understanding
   * @private
   */
  _summarizeData(data, columns) {
    if (!data || data.length === 0) {
      return 'No data found.';
    }

    let summary = `Found ${data.length} records.\n\n`;

    if (data.length <= 10) {
      // For small datasets, show all
      summary += 'All records:\n';
      summary += JSON.stringify(data, null, 2);
    } else {
      // For large datasets, show first 10 and stats
      summary += 'First 10 records:\n';
      summary += JSON.stringify(data.slice(0, 10), null, 2);
      summary += `\n\n... and ${data.length - 10} more records.`;

      // Add basic stats if numeric columns exist
      const numericCols = this._findNumericColumns(data[0]);
      if (numericCols.length > 0) {
        summary += '\n\nNumeric summaries:\n';
        for (const col of numericCols.slice(0, 3)) { // Max 3 numeric columns
          const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v));
          if (values.length > 0) {
            const sum = values.reduce((a, b) => a + b, 0);
            const avg = sum / values.length;
            const min = Math.min(...values);
            const max = Math.max(...values);

            summary += `- ${col}: Sum=${sum.toLocaleString()}, Avg=${avg.toFixed(2)}, Min=${min}, Max=${max}\n`;
          }
        }
      }
    }

    return summary;
  }

  /**
   * Find numeric columns in a row
   * @private
   */
  _findNumericColumns(row) {
    if (!row) return [];

    return Object.keys(row).filter(key => {
      const value = row[key];
      return typeof value === 'number' || (!isNaN(parseFloat(value)) && isFinite(value));
    });
  }
}

module.exports = Zer4UCrew;
