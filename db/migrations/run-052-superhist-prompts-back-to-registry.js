require('dotenv').config();
const db = require('../../services/db.pg');
const { providerConfig } = require('../../db/schema');
const { eq } = require('drizzle-orm');

/**
 * 052 — drop superhist's stored bootstrapPrompts / examplePrompts overrides.
 *
 * Migration 051 wrote Hebrew arrays into the `intel_config_superhist` blob so
 * the customer would see Hebrew. That made the prompts single-language: an
 * English-mode viewer of Aspect Intelligence saw Hebrew chips, because the
 * stored value wins over the registry regardless of the requested language.
 *
 * The registry now carries both — English defaults plus a `i18n.he` block and
 * `reportLang: 'he'` (see insights/datasets/registry.js) — and the public
 * endpoints resolve by `?lang`. For that to take effect the stored override
 * has to be gone, so this removes just those two keys from the blob. Everything
 * else in it (enabled, dataModelDescription, brandLabel, both history arrays)
 * is left exactly as-is.
 *
 * After this: EN viewers get the English defaults, HE viewers get i18n.he, and
 * bootstrap() (reportLang) keeps generating the shared reports in Hebrew.
 *
 * Dry by default. Pass --apply to write.
 *
 *   node db/migrations/run-052-superhist-prompts-back-to-registry.js
 *   node db/migrations/run-052-superhist-prompts-back-to-registry.js --apply
 */
const KEY = 'intel_config_superhist';

async function run() {
  const apply = process.argv.includes('--apply');
  try {
    await db.initialize();
    const drizzle = db.getDrizzle();

    const [row] = await drizzle.select().from(providerConfig).where(eq(providerConfig.key, KEY)).limit(1);
    if (!row) {
      console.log(`No ${KEY} row — nothing to do (registry defaults already apply).`);
      process.exit(0);
    }

    const blob = JSON.parse(row.value);
    console.log('Current blob keys:', Object.keys(blob).join(', '));
    console.log('  bootstrapPrompts present:', Array.isArray(blob.bootstrapPrompts));
    console.log('  examplePrompts present:  ', Array.isArray(blob.examplePrompts));

    delete blob.bootstrapPrompts;
    delete blob.examplePrompts;

    if (!apply) {
      console.log('\nWould write blob keys:', Object.keys(blob).join(', '));
      console.log('Dry run. Re-run with --apply to write.');
      process.exit(0);
    }

    await drizzle
      .update(providerConfig)
      .set({ value: JSON.stringify(blob), updatedAt: new Date() })
      .where(eq(providerConfig.key, KEY));

    console.log('\nWritten. Blob keys now:', Object.keys(blob).join(', '));
    console.log('The shared "Suggested reports" set stays Hebrew (reportLang) and');
    console.log('refreshes on the next nightly tick or a manual admin refresh.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
