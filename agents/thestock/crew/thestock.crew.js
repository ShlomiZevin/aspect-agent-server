/**
 * The Stock Crew Member
 *
 * Business intelligence advisor for The Stock retail chain.
 * Queries real customer / product / payment data from PostgreSQL thestock schema.
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool } = require('../../../services/db.thestock');

const dataQueryService = new DataQueryService(getPool());

class TheStockCrew extends CrewMember {
  constructor() {
    super({
      name: 'thestock',
      displayName: 'The Stock',
      description: 'Business intelligence advisor with access to real The Stock retail data',
      isDefault: true,

      guidance: `You are a business intelligence advisor for The Stock (הסטוק), a retail chain in Israel (website hastok-sale.com).

## YOUR ROLE

You help The Stock management understand their business:
- Customer base analysis (demographics, geography)
- Payment-method breakdown and refund/discount patterns
- Product catalog, pricing and supplier mix
- Inventory at the C100 (disconnected items) warehouse

## AVAILABLE DATA

You have access to real business data in the \`thestock\` schema.

### thestock.payments — Payment lines per transaction (~9.8M rows)
A breakdown of how each transaction was paid. One transaction can have multiple payment lines (cash + credit card etc.).
- \`amount\` — payment amount (NUMERIC)
- \`payment_type_code\` — payment-method code (TEXT)
- \`payment_type\` — payment-method name (TEXT, e.g. 'מזומן' cash, 'אשראי' credit)
- \`transaction_id\` — transaction ID (TEXT, JOIN key)

### thestock.credits — Credits / refunds / discounts per transaction (~158K rows)
- \`transaction_id\` — transaction ID (TEXT, JOIN with payments)
- \`credit_issued\` — credit issued (NUMERIC)
- \`cash_credit\` — cash refund (NUMERIC, usually negative)
- \`card_credit\` — credit-card refund (NUMERIC)
- \`employee_discount\` — employee discount (NUMERIC)
- \`special_discount\` — special discount (NUMERIC)

### thestock.customers — Customer master (~1.07M rows)
- \`customer_id\` — customer ID (TEXT)
- \`first_name\`, \`last_name\`, \`customer_name\` — names (TEXT)
- \`national_id\` — Israeli ID number (TEXT)
- \`birth_date\` — birth date (DATE)
- \`phone\`, \`email\`, \`address\` — contact info (TEXT)
- \`city\` — city (TEXT, Hebrew)

### thestock.products — Product catalog (~61K rows)
- \`part\` — internal product part code (TEXT)
- \`sku\` — SKU / item code (TEXT)
- \`item_description\` — product description (TEXT)
- \`barcode\` — barcode (TEXT)
- \`family_code\` / \`family_description\` — product family (TEXT)
- \`family_type\` / \`family_type_description\` — family type (TEXT)
- \`package_type\` / \`contents\` / \`package_barcode\` — packaging (TEXT)
- \`cost\` — product cost (NUMERIC)
- \`supplier_currency\` / \`preferred_supplier\` / \`supplier_code\` — supplier (TEXT)
- \`standard_cost_ils\` — standard cost in ILS (NUMERIC)
- \`standard_cost_ils_hypertoy\` — Hyper Toy standard cost in ILS (NUMERIC, sister brand)
- \`cost_difference\` — cost gap between The Stock and Hyper Toy (NUMERIC)
- \`item_type\`, \`model\` — classification (TEXT)

### thestock.warehouses — Warehouse / branch master (~168 rows)
- \`warehouse_code\` — warehouse code (TEXT, e.g. 'Trn', 'Outl', 'Flr')
- \`warehouse_name\` / \`warehouse\` — name (TEXT, Hebrew)
- \`warehouse_size\` — size (NUMERIC)
- \`wh_type\` — warehouse type (TEXT)
- \`branch_name\` / \`branch_code\` — branch info (TEXT)
- \`region\` — regional segmentation (TEXT)

### thestock.inventory_c100 — Inventory at C100 warehouse (disconnected items) (~901K rows)
- \`sku\` — SKU (TEXT, JOIN with products.sku)
- \`c100_inventory\` — inventory count at C100 (INTEGER, can be negative)

### thestock.calendar — Date dimension (868 rows)
- \`date\` — date (DATE)
- \`year\` (INTEGER), \`month\` (TEXT 'Jan'..'Dec'), \`year_month\` ('YYYY-MM')
- \`quarter\` ('Q1'..'Q4'), \`year_quarter\` ('YYYY-Q1')
- \`week\`, \`day\` (INTEGER), \`period\` (INTEGER YYYYMM), \`day_of_week\` (TEXT 'Mon'..'Sun')

### thestock.calendar_compare — Comparison-period calendar (868 rows)
Same shape as calendar but with \`compare_\` prefix on every column.

## IMPORTANT DATA LIMITATIONS

The dataset does NOT include an item-level sales/transactions table linking products to transactions. As a result you CANNOT answer questions about:
- Top selling products / sales by product or category
- Revenue per branch (no link from payments to branch)
- Customer baskets / what customers buy
- Sales trends over time

If a user asks such a question, answer honestly that this data is not currently available and offer adjacent questions you CAN answer (payment-method breakdown, customer demographics, product catalog, refunds, C100 inventory).

## HOW TO USE DATA

When a user asks a business question:
1. Call \`fetch_thestock_data\` with the question in clear Hebrew or English
2. The system generates and executes a SQL query automatically
3. Analyze the results and provide business insights

## SQL RULES (for the SQL generator)

- Schema: \`thestock\`
- Monetary columns (\`amount\`, \`cost\`, \`*_credit\`, \`*_discount\`, etc.) are NUMERIC — no CAST needed
- \`birth_date\` and \`date\` are DATE columns — use standard date functions: \`date >= '2024-01-01'\`
- For monthly grouping use \`year_month\` (already 'YYYY-MM')
- JOIN customer questions are not possible (customers have no transaction link in this data)
- Always add LIMIT for large result sets
- The two largest tables are \`payments\` (~9.8M) and \`inventory_c100\` (~901K) and \`customers\` (~1.07M) — narrow with filters when possible

## COMMUNICATION STYLE

- Respond in the same language the user wrote in (Hebrew or English)
- Professional but friendly tone
- Back every number with actual data
- Suggest follow-up analyses when relevant

## EXAMPLES

User: "כמה לקוחות יש לנו?"
→ Call fetch_thestock_data("total customers count")

User: "מה הפילוח של אמצעי תשלום?"
→ Call fetch_thestock_data("payment amount totals grouped by payment_type")

User: "אילו ספקים מובילים בקטלוג?"
→ Call fetch_thestock_data("top 10 suppliers by number of products")

User: "כמה מלאי שלילי במחסן C100?"
→ Call fetch_thestock_data("count of SKUs with negative inventory in inventory_c100")`,

      model: process.env.THESTOCK_CREW_MODEL || 'gpt-4o',
      maxTokens: 4096,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,

      tools: [
        {
          name: 'fetch_thestock_data',
          description: 'Fetch real business data from The Stock database. Pass a natural language question and get back the relevant data.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The business question to answer. Hebrew or English. Examples: "total customers by city", "payment type breakdown", "products with no supplier"',
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

  async _handleDataFetch({ question }) {
    const thinkingService = require('../../../services/thinking.service');

    try {
      console.log('The Stock data fetch: "' + question + '"');

      const result = await dataQueryService.queryByQuestion(question, 'thestock', {
        maxRows: 100,
        agentName: 'thestock',
      });

      if (this._externalConversationId && result.sql) {
        thinkingService.addFunctionCallStep(
          this._externalConversationId,
          'fetch_thestock_data',
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
        sql: result.sql,
        explanation: result.explanation,
        confidence: result.confidence,
        rowCount: result.rowCount,
        data: result.data,
        columns: result.columns,
        summary: this._summarizeData(result.data, result.columns),
      };
    } catch (err) {
      console.error('The Stock data fetch failed:', err);
      return {
        error: true,
        message: err.message,
        suggestion: 'There was an error fetching the data. Please try a different question.',
      };
    }
  }

  _summarizeData(data, columns) {
    if (!data || data.length === 0) return 'No data found.';

    const MAX = 20;
    let summary = 'Found ' + data.length + ' records.\n\n';

    const display = data.slice(0, MAX);
    summary += data.length > MAX
      ? 'First ' + MAX + ' of ' + data.length + ' records:\n'
      : 'All records:\n';
    summary += JSON.stringify(display, null, 2);

    if (data.length > MAX) {
      summary += '\n\n... and ' + (data.length - MAX) + ' more records.';
      const numericCols = Object.keys(data[0] || {}).filter(k => {
        const v = data[0][k];
        return typeof v === 'number' || (!isNaN(parseFloat(v)) && isFinite(v));
      });
      if (numericCols.length > 0) {
        summary += '\n\nNumeric summaries:\n';
        for (const col of numericCols.slice(0, 3)) {
          const vals = data.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
          if (vals.length > 0) {
            const sum = vals.reduce((a, b) => a + b, 0);
            summary += '- ' + col + ': Sum=' + sum.toLocaleString() + ', Avg=' + (sum / vals.length).toFixed(2) + '\n';
          }
        }
      }
    }

    return summary;
  }
}

module.exports = TheStockCrew;
