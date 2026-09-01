require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const assert = require('assert');
const db = require('../../services/db.pg');
const recs = require('../../modules/replenishment/services/recommendations.service');
const supplierSettings = require('../../modules/replenishment/services/supplier-settings.service');

/**
 * Excluding a supplier from the recommendations (review section 04, item 7).
 *
 * The archive supplier ארכיון ב.א sells but holds no warehouse stock by design,
 * so all 291 of its items read as permanently 91 days late. They are not orders
 * anyone will place, and they are a fifth of the noise on the screen.
 *
 * What these checks defend is that excluding is a REMOVAL and is ACCOUNTED FOR:
 * the rows go, the count of what went is reported, and switching it back
 * restores exactly what was there. A silent drop would be the same class of bug
 * as the null-supplier bucket — items missing from a page whose whole job is
 * numbers that reconcile.
 *
 *   node verification/modules-replenishment/test-supplier-exclusion.js
 *
 * Restores the supplier's override, including on failure.
 */
const DATASET = 'zolstock';

let passed = 0;
const ok = name => { passed++; console.log('   ok  ' + name); };
let restore = null;

async function run() {
  await db.initialize();

  const before = await recs.getRecommendations(DATASET, {});
  if (before.error) {
    console.log(`   skipped — ${before.error}`);
    return;
  }
  assert.deepStrictEqual(before.excluded, { items: 0, suppliers: [] });
  ok('nothing is excluded to start with');

  // Whichever supplier has the most rows that are not the biggest one: enough
  // to measure, small enough that the check is quick.
  const counts = new Map();
  for (const r of before.recommendations) {
    counts.set(r.supplier, (counts.get(r.supplier) || 0) + 1);
  }
  const ranked = [...counts.entries()].filter(([s]) => s).sort((a, b) => b[1] - a[1]);
  assert.ok(ranked.length > 1, 'need more than one supplier to test exclusion');
  const [supplier, itemCount] = ranked[1];
  ok(`excluding "${supplier}" (${itemCount} rows on the first page)`);

  const priorOverride = await supplierSettings.getOverride(DATASET, supplier);
  restore = async () => {
    if (priorOverride) {
      await supplierSettings.upsertOverride(DATASET, supplier, { excluded: Boolean(priorOverride.excluded) }, 'verification');
    } else {
      await supplierSettings.deleteOverride(DATASET, supplier);
    }
  };

  await supplierSettings.upsertOverride(DATASET, supplier, { excluded: true }, 'verification');

  const after = await recs.getRecommendations(DATASET, {});

  assert.ok(!after.recommendations.some(r => r.supplier === supplier));
  ok('none of its rows come back');

  assert.ok(after.excluded.suppliers.includes(supplier));
  assert.ok(after.excluded.items > 0);
  // The count must be what the BUYER would have seen, not how many raw rows the
  // supplier has. Counting rows reported 2,624 for a supplier whose list only
  // ever held 289 — true of the data, false of the screen.
  assert.strictEqual(after.excluded.items, before.total - after.total);
  ok(`the count equals what actually left the list: ${after.excluded.items}`);

  assert.ok(after.total < before.total);
  ok(`the total drops (${before.total} to ${after.total}) rather than staying and pointing at rows that are gone`);

  // The summary must move with the rows. Leaving it would be the mirror of the
  // paging bug: tiles describing a set the table no longer shows.
  assert.notDeepStrictEqual(after.summary, before.summary);
  ok('the tiles move with the rows');

  // Asking for that supplier by name returns nothing, rather than bypassing it.
  const direct = await recs.getRecommendations(DATASET, { supplier });
  assert.strictEqual(direct.recommendations.length, 0);
  ok('asking for the excluded supplier directly returns nothing');

  // --- and back -----------------------------------------------------------------
  await supplierSettings.upsertOverride(DATASET, supplier, { excluded: false }, 'verification');
  const restored = await recs.getRecommendations(DATASET, {});

  assert.strictEqual(restored.total, before.total);
  assert.deepStrictEqual(restored.summary, before.summary);
  assert.deepStrictEqual(restored.excluded, { items: 0, suppliers: [] });
  ok('switching it back restores the same total, the same tiles and an empty exclusion');

  console.log(`\n   ${passed} checks passed`);
}

run()
  .then(async () => { if (restore) await restore(); process.exit(0); })
  .catch(async err => {
    console.error('\nFAILED:', err.message);
    if (restore) await restore().catch(() => {});
    process.exit(1);
  });
