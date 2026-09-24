require('dotenv').config();
const db = require('../../services/db.pg');
const { providerConfig } = require('../../db/schema');
const { eq } = require('drizzle-orm');
const { SUPERHIST_DATA_MODEL } = require('../../insights/datasets/registry');

/**
 * 056 — superhist Insights data model now includes cost, gross profit,
 * supplier and coupons.
 *
 * On 2026-09-23 the client added a line-cost column, supplier name and unit
 * cost, and a raw kind for coupon/discount rows. The stored admin override in
 * `intel_config_superhist` still says "NO cost or margin", and a stored value
 * wins over the registry — so Insights would keep refusing profit questions
 * until this text is replaced. Only `dataModelDescription` is touched; every
 * other key in the blob (enabled, prompts, quickQuestions, histories) is left
 * exactly as-is.
 *
 * Run AFTER the superhist reload with the new columns has swapped in, so the
 * text never describes columns the live schema does not have yet.
 *
 * Dry by default. Pass --apply to write.
 *
 *   node db/migrations/run-056-superhist-cost-data-model.js
 *   node db/migrations/run-056-superhist-cost-data-model.js --apply
 */
const KEY = 'intel_config_superhist';

async function run() {
  const apply = process.argv.includes('--apply');
  try {
    await db.initialize();
    const drizzle = db.getDrizzle();

    const [row] = await drizzle.select().from(providerConfig).where(eq(providerConfig.key, KEY)).limit(1);
    if (!row) {
      console.log(`No ${KEY} row — nothing to do (registry default already applies).`);
      process.exit(0);
    }

    const blob = JSON.parse(row.value);
    console.log('Current dataModelDescription:\n ', blob.dataModelDescription || '(none)');
    blob.dataModelDescription = SUPERHIST_DATA_MODEL;
    console.log('\nNew dataModelDescription:\n ', blob.dataModelDescription);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to write.');
      process.exit(0);
    }

    await drizzle
      .update(providerConfig)
      .set({ value: JSON.stringify(blob), updatedAt: new Date() })
      .where(eq(providerConfig.key, KEY));
    console.log('\nWritten.');
    process.exit(0);
  } catch (err) {
    console.error('Migration 056 failed:', err.message);
    process.exit(1);
  }
}

run();
