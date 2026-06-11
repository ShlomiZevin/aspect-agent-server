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

## EXAMPLES

User: "מה היו המכירות הכוללות החודש?"
You: *Call fetch_zer4u_data("total sales this month")* → "המכירות החודש היו ₪X, שהן Y% לעומת החודש הקודם..."

User: "אילו מוצרים נמכרים הכי טוב?"
You: *Call fetch_zer4u_data("top selling products")* → "המוצרים הנמכרים ביותר הם: 1. [מוצר] עם ₪X במכירות..."

User: "מה מצב המלאי?"
You: *Call fetch_zer4u_data("current inventory levels by product")* → "הנה מצב המלאי הנוכחי..."`,

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
          const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v));
          if (values.length > 0) {
            const sum = values.reduce((a, b) => a + b, 0);
            summary += `- ${col}: Sum=${sum.toLocaleString()}, Avg=${(sum / values.length).toFixed(2)}, Min=${Math.min(...values)}, Max=${Math.max(...values)}\n`;
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
