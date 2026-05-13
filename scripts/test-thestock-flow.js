/**
 * Smoke-test The Stock agent across Hebrew + English questions.
 * Generates SQL via sqlGeneratorService, then executes via dataQueryService.
 * Reports pass / refused-with-low-confidence / failed.
 *
 * Run from aspect-agent-server/: node scripts/test-thestock-flow.js
 */

require('dotenv').config();
const sqlGeneratorService = require('../services/sql-generator.service');
const { DataQueryService } = require('../services/data-query.service');
const { getPool } = require('../services/db.thestock');

const ds = new DataQueryService(getPool());

const questions = [
  // Easy / definitely should work
  'How many customers do we have?',
  'כמה לקוחות יש לנו?',
  'Show payment totals grouped by payment_type',
  'מה הפילוח של אמצעי תשלום?',

  // Cities and demographics
  'Top 10 cities by customer count',
  'באילו ערים יש הכי הרבה לקוחות? תן לי טופ 10',
  'How many customers have an email address?',
  'What is the customer age distribution by decade of birth?',

  // Refunds / credits
  'Total refunds and discounts summary',
  'מה סך הזיכויים, החזרים מזומן וכרטיס?',

  // Products
  'Top 5 product families by number of products',
  'אילו 10 ספקים מובילים לפי מספר מוצרים בקטלוג?',
  'מה ההפרש הממוצע בעלות בין הסטוק לבין היפר טוי?',

  // Warehouses / inventory
  'How many branches do we have?',
  'כמה סניפים יש לנו?',
  'Top 10 SKUs with the most negative C100 inventory',

  // Impossible time filter — should refuse gracefully (per RULE 1)
  'מה הפילוח של אמצעי תשלום השנה?',
  'How much did we get in payments this month?',

  // Impossible item-level sales — should refuse (per RULE 2)
  'What are the top selling products this year?',
];

(async () => {
  let pass = 0, refused = 0, fail = 0;
  const failures = [];
  const refusals = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    process.stdout.write('\n[' + (i + 1) + '/' + questions.length + '] ' + q + '\n');
    try {
      const gen = await sqlGeneratorService.generateSQL(q, 'thestock');
      process.stdout.write('  SQL: ' + gen.sql.replace(/\s+/g, ' ').substring(0, 200) + '\n');
      process.stdout.write('  confidence=' + gen.confidence + '\n');

      if (gen.confidence === 'low') {
        process.stdout.write('  -> refused (low confidence): ' + gen.explanation + '\n');
        refusals.push({ q, explanation: gen.explanation });
        refused++;
        continue;
      }

      const start = Date.now();
      const r = await ds.queryByQuestion(q, 'thestock', { maxRows: 5, agentName: 'thestock' });
      const ms = Date.now() - start;
      if (r.error) {
        process.stdout.write('  X ERROR (' + ms + 'ms): ' + r.message + '\n');
        failures.push({ q, sql: gen.sql, err: r.message });
        fail++;
      } else {
        process.stdout.write('  OK ' + r.rowCount + ' rows in ' + ms + 'ms\n');
        if (r.data && r.data.length > 0) {
          process.stdout.write('  first row: ' + JSON.stringify(r.data[0]).substring(0, 200) + '\n');
        }
        pass++;
      }
    } catch (e) {
      process.stdout.write('  X EXCEPTION: ' + e.message + '\n');
      failures.push({ q, err: e.message });
      fail++;
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY: ' + pass + ' passed, ' + refused + ' refused (correct), ' + fail + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f.q + '\n      sql=' + ((f.sql || '(no sql)').replace(/\s+/g, ' ').substring(0, 150)) + '\n      err=' + f.err));
  }
  if (refusals.length) {
    console.log('\nRefusals (expected for time-bound payment Qs and item-level sales):');
    refusals.forEach(r => console.log('  - ' + r.q + '\n      reason: ' + r.explanation));
  }
  process.exit(0);
})();
