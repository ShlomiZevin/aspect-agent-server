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
      isDefault: true,

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

- **ALWAYS respond in Hebrew by default**
  - If user asks in English → respond in English
  - If user asks in Hebrew → respond in Hebrew
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

## EXAMPLES

User: "מה היו המכירות הכוללות החודש?"
You: *Call fetch_zer4u_data("total sales this month")* → "המכירות החודש היו ₪X, שהן Y% לעומת החודש הקודם..."

User: "אילו מוצרים נמכרים הכי טוב?"
You: *Call fetch_zer4u_data("top selling products")* → "המוצרים הנמכרים ביותר הם: 1. [מוצר] עם ₪X במכירות..."

User: "מה מצב המלאי?"
You: *Call fetch_zer4u_data("current inventory levels by product")* → "הנה מצב המלאי הנוכחי..."`,

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
                description: 'The business question to answer. Can be in Hebrew or English. Examples: "total sales last month", "top 10 customers", "inventory levels"'
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
    const { question } = params;
    const thinkingService = require('../../../services/thinking.service');

    try {
      console.log(`🔍 Zer4U Data Fetch: "${question}"`);

      const result = await dataQueryService.queryByQuestion(
        question,
        'zer4u',
        {
          maxRows: 100,
          agentName: 'zer4u',
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
      console.error('❌ Data fetch failed:', error);
      return {
        error: true,
        message: error.message,
        suggestion: 'There was an error fetching the data. Please try a different question.'
      };
    }
  }

  _summarizeData(data, columns) {
    if (!data || data.length === 0) {
      return 'No data found.';
    }

    let summary = `Found ${data.length} records.\n\n`;

    if (data.length <= 10) {
      summary += 'All records:\n';
      summary += JSON.stringify(data, null, 2);
    } else {
      summary += 'First 10 records:\n';
      summary += JSON.stringify(data.slice(0, 10), null, 2);
      summary += `\n\n... and ${data.length - 10} more records.`;

      const numericCols = this._findNumericColumns(data[0]);
      if (numericCols.length > 0) {
        summary += '\n\nNumeric summaries:\n';
        for (const col of numericCols.slice(0, 3)) {
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

  _findNumericColumns(row) {
    if (!row) return [];
    return Object.keys(row).filter(key => {
      const value = row[key];
      return typeof value === 'number' || (!isNaN(parseFloat(value)) && isFinite(value));
    });
  }
}

module.exports = Zer4UCrew;
