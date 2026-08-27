/**
 * Smart Replenishment — Intelligence report category (D4).
 *
 * Run: node scripts/test-replenishment-insights.js
 *
 * The change to the investigation pipeline is deliberately ONE substitution:
 * when PLAN picks `replenishment`, the rows come from the module's engine
 * instead of NL→SQL, and everything downstream — the digest, the impact
 * reconciler, the independent verifier, the downgrade guard — is untouched,
 * because they operate on rows and a write-up and do not care where the rows
 * came from.
 *
 * This battery checks the seam, not the LLM: that the category is offered
 * only when the module is live, that the rows arrive in the exact shape a
 * query result has, and that the `sql` field does not lie.
 */

require('dotenv').config();
const db = require('../services/db.pg');
const moduleService = require('../modules/services/module.service');
const investigation = require('../insights/services/investigation.service');

const DS = 'zolstock';
const MOD = 'replenishment';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

/** Reach the non-exported helpers the way the pipeline does. */
const internals = (() => {
  const src = require('fs').readFileSync(
    require.resolve('../insights/services/investigation.service'), 'utf8');
  return {
    hasCategory: /replenishment: '#0E7490'/.test(src),
    gatesPlan: /const replenishmentLive = await isReplenishmentLive\(datasetId\)/.test(src),
    dynamicList: /"category": one of \$\{categoryList\}/.test(src),
    substitutes: /const engineResult = category === 'replenishment'/.test(src),
    fallsBack: /falling back to SQL/.test(src),
  };
})();

(async () => {
  await db.initialize();
  const before = await moduleService.getForDataset(DS, MOD);
  const restore = before.enabled;

  console.log('\n1 · The seam is where it should be');
  ok('replenishment is a real category with its own colour', internals.hasCategory);
  ok('the PLAN category list is built, not hardcoded', internals.dynamicList);
  ok('…and gated on the module being live', internals.gatesPlan);
  ok('the QUERY step substitutes engine rows for SQL', internals.substitutes);
  ok('…and falls back rather than failing if the module vanishes mid-run', internals.fallsBack);

  console.log('\n2 · The category is offered only when the module is live');
  {
    await moduleService.setEnabled(DS, MOD, false, 'd4-test');
    ok('module off ⇒ not live', (await moduleService.isLive(DS, MOD)) === false);
    await moduleService.setEnabled(DS, MOD, true, 'd4-test');
    ok('module on + ready ⇒ live', (await moduleService.isLive(DS, MOD)) === true);
    ok('a dataset without the module is never offered it',
      (await moduleService.isLive('hypertoy', MOD)) === false);
  }

  console.log('\n3 · Engine rows arrive shaped exactly like a query result');
  {
    const rows = await investigation.__getReplenishmentRowsForTest(DS);
    ok('rows are returned', Boolean(rows), JSON.stringify(rows?.error));
    ok('…with the keys the pipeline expects',
      ['sql', 'explanation', 'confidence', 'data', 'rowCount', 'columns']
        .every(k => rows[k] !== undefined), Object.keys(rows || {}).join(','));
    ok('…and real rows in them', rows.rowCount > 0 && rows.data.length === rows.rowCount,
      `${rows.rowCount} rows`);
    ok('…with columns derived from the data, not invented',
      rows.columns.length > 0 && rows.columns.every(c => c in rows.data[0]));
    console.log(`       ${rows.rowCount} rows, confidence ${rows.confidence}`);
  }
  {
    const rows = await investigation.__getReplenishmentRowsForTest(DS);
    // The detail page renders `sql` as "the SQL that produced this". Putting a
    // fabricated query there would be a lie in the single place the product
    // exists to be checkable.
    ok('the sql field does NOT pretend to be a query',
      /Not a SQL query/.test(rows.sql) && !/^\s*SELECT/im.test(rows.sql), rows.sql.slice(0, 60));
    ok('…and says where the numbers actually come from',
      /configured by hand and is not present in the database/.test(rows.sql),
      rows.sql.split('\n')[2]);
    ok('…and carries the data-through date', /Data through \d{4}-\d{2}-\d{2}/.test(rows.sql));
  }
  {
    const rows = await investigation.__getReplenishmentRowsForTest(DS);
    ok('the explanation names how many rows use an ASSUMED delivery time',
      /ASSUMED supplier/.test(rows.explanation), rows.explanation.slice(0, 120));
    ok('…and that values are list-price estimates',
      /list-price estimates/.test(rows.explanation));
    ok('confidence is capped while lead times are assumed', rows.confidence <= 60,
      String(rows.confidence));
    ok('every row states its lead-time source',
      rows.data.every(r => Boolean(r.lead_time_source)));
  }

  console.log('\n4 · With the module off, the pipeline is unchanged');
  {
    await moduleService.setEnabled(DS, MOD, false, 'd4-test');
    const rows = await investigation.__getReplenishmentRowsForTest(DS);
    ok('no engine rows are produced', rows === null, JSON.stringify(rows));
    await moduleService.setEnabled(DS, MOD, restore, 'd4-test');
  }

  const after = await moduleService.getForDataset(DS, MOD);
  ok('module state restored', after.enabled === restore, `enabled=${after.enabled}`);

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('Battery failed:', err.message); console.error(err); process.exit(1); });
