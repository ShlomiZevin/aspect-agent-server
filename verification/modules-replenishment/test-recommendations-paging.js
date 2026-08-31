require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const assert = require('assert');
const db = require('../../services/db.pg');
const recs = require('../../modules/replenishment/services/recommendations.service');

/**
 * Paging and search on the recommendations endpoint (review finding C4).
 *
 * The rule these checks exist to hold: **the summary and the total describe the
 * whole set, never the page and never the search.** A supplier group used to
 * mount every one of its items — up to 5,126 rows — so paging had to arrive;
 * the risk paging brings is that the tiles quietly start counting only what is
 * visible, which is a wrong number that looks right.
 *
 * The first implementation did exactly that: the search filtered in SQL, so the
 * engine summarised the search results. It passed every other check. Hence the
 * explicit comparison below against an unfiltered call.
 *
 *   node verification/modules-replenishment/test-recommendations-paging.js
 *
 * Reads only. Needs the Cloud SQL Proxy and the module live for the dataset.
 */
const DATASET = 'zolstock';
const PAGE = 20;

let passed = 0;
const ok = name => { passed++; console.log('   ok  ' + name); };

async function run() {
  await db.initialize();

  const all = await recs.getRecommendations(DATASET, {});
  if (all.error) {
    console.log(`   skipped — ${all.error}`);
    return;
  }
  assert.ok(all.total > PAGE, 'this check needs more rows than one page');
  ok(`${all.total} recommendations to page through`);

  const first = await recs.getRecommendations(DATASET, { limit: PAGE, offset: 0 });
  const second = await recs.getRecommendations(DATASET, { limit: PAGE, offset: PAGE });

  assert.strictEqual(first.recommendations.length, PAGE);
  assert.strictEqual(second.recommendations.length, PAGE);
  ok('a page holds exactly the requested number of rows');

  const firstIds = new Set(first.recommendations.map(r => r.sku));
  assert.ok(second.recommendations.every(r => !firstIds.has(r.sku)));
  ok('consecutive pages do not repeat a row');

  assert.strictEqual(first.total, all.total);
  assert.strictEqual(second.total, all.total);
  ok('the total counts the whole set, not the page');

  assert.deepStrictEqual(first.summary, all.summary);
  assert.deepStrictEqual(second.summary, all.summary);
  ok('the summary is identical on every page');

  // Urgency order has to survive paging, or page 2 is not the continuation of
  // page 1 and the buyer works the list in the wrong order.
  const joined = [...first.recommendations, ...second.recommendations];
  const straight = await recs.getRecommendations(DATASET, { limit: PAGE * 2, offset: 0 });
  assert.deepStrictEqual(joined.map(r => r.sku), straight.recommendations.map(r => r.sku));
  ok('two pages joined equal one double-length page, so the ordering is stable');

  // A stale pager after someone else's reload shortened the list.
  const past = await recs.getRecommendations(DATASET, { limit: PAGE, offset: all.total + 1000 });
  assert.strictEqual(past.recommendations.length, 0);
  assert.strictEqual(past.total, all.total);
  ok('an offset past the end is an empty page, not an error');

  // --- search -----------------------------------------------------------------
  const sample = all.recommendations.find(r => (r.itemName || '').trim().length > 2);
  assert.ok(sample, 'need an item with a name to search for');
  const term = sample.itemName.trim().split(/\s+/)[0];

  const found = await recs.getRecommendations(DATASET, { search: term, limit: PAGE });
  assert.ok(found.total > 0, `search for "${term}" should match something`);
  assert.ok(found.total <= all.total);
  ok(`search narrows the total (${found.total} of ${all.total} for "${term}")`);

  assert.ok(found.recommendations.every(r =>
    `${r.itemName ?? ''} ${r.sku ?? ''} ${r.itemNumber ?? ''}`.toLowerCase().includes(term.toLowerCase())));
  ok('every row on a search page actually matches');

  // The one that caught the first implementation.
  assert.deepStrictEqual(found.summary, all.summary);
  ok('the summary still describes the whole set while searching, not the matches');

  const bySku = await recs.getRecommendations(DATASET, { search: String(sample.sku) });
  assert.ok(bySku.recommendations.some(r => r.sku === sample.sku));
  ok('an item can be found by its sku, not only its name');

  const nothing = await recs.getRecommendations(DATASET, { search: 'zzz-no-such-item-zzz' });
  assert.strictEqual(nothing.total, 0);
  assert.strictEqual(nothing.recommendations.length, 0);
  assert.deepStrictEqual(nothing.summary, all.summary);
  ok('a search that matches nothing returns nothing, and still reports the whole set');

  console.log(`\n   ${passed} checks passed`);
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('\nFAILED:', err.message); process.exit(1); });
