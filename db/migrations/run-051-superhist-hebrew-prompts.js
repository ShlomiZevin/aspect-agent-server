require('dotenv').config();
const db = require('../../services/db.pg');
const intelligenceConfigService = require('../../insights/services/intelligence-config.service');

/**
 * 051 — Hebrew-ise הסופר החברתי's Aspect Intelligence prompt set.
 *
 * The customer is Hebrew-speaking and waiting to see the product in Hebrew.
 * The shell header (registry defaultMeta.name) and the example chips
 * (defaultExamplePrompts) are handled in code (insights/datasets/registry.js),
 * but the stored `intel_config_superhist` blob carries its own English
 * `bootstrapPrompts` copy that overrides the registry default — so the nightly
 * refresh keeps generating the shared "Suggested reports" in English. This
 * rewrites the stored bootstrap + example prompts to Hebrew. The synthesize
 * step mirrors the prompt language, so tonight's refresh (after the load) will
 * regenerate the suggestions in Hebrew.
 *
 * setConfig() snapshots the pre-write prompts into promptsHistory, so this is
 * reversible from the admin Prompts page.
 *
 * Dry by default. Pass --apply to write.
 *
 *   node db/migrations/run-051-superhist-hebrew-prompts.js
 *   node db/migrations/run-051-superhist-hebrew-prompts.js --apply
 */
const DATASET = 'superhist';

const BOOTSTRAP_PROMPTS = [
  'כיצד מתפתחת הכנסת ההזמנות משבוע לשבוע, ומה מניע את השינוי',
  'אילו מוצרים נמכרים ביחידות הרבות ביותר, ואילו יושבים במלאי ללא מכירה',
  'כמה חברים מזמינים יותר מפעם אחת, וכיצד הסל שלהם משתווה לאחרים',
  'כמה סבסוד מממנת ההסתדרות, ועל אילו מוצרים',
];

const EXAMPLE_PROMPTS = [
  'אילו מוצרים מאבדים מכירות בשקט משבוע לשבוע',
  'לאן הולך הסבסוד, והאם הוא מגיע לסלים הפעילים ביותר',
  'אילו חברים הזמינו פעם אחת ולא חזרו',
];

async function run() {
  const apply = process.argv.includes('--apply');
  try {
    await db.initialize();

    const before = await intelligenceConfigService.getConfig(DATASET);
    if (!before) {
      console.error(`Unknown dataset: ${DATASET}`);
      process.exit(1);
    }
    console.log('Current bootstrapPrompts:');
    before.bootstrapPrompts.forEach(p => console.log('  - ' + p));
    console.log('Current examplePrompts:');
    before.examplePrompts.forEach(p => console.log('  - ' + p));

    console.log('\nNew bootstrapPrompts:');
    BOOTSTRAP_PROMPTS.forEach(p => console.log('  - ' + p));
    console.log('New examplePrompts:');
    EXAMPLE_PROMPTS.forEach(p => console.log('  - ' + p));

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to write.');
      process.exit(0);
    }

    await intelligenceConfigService.setConfig(DATASET, {
      bootstrapPrompts: BOOTSTRAP_PROMPTS,
      examplePrompts: EXAMPLE_PROMPTS,
    });

    const after = await intelligenceConfigService.getConfig(DATASET);
    console.log('\nWritten. Stored prompts are now:');
    after.bootstrapPrompts.forEach(p => console.log('  bootstrap: ' + p));
    after.examplePrompts.forEach(p => console.log('  example:   ' + p));
    console.log('\nThe shared "Suggested reports" set is still English until the next');
    console.log('nightly refresh (or a manual admin "Refresh suggestions") regenerates it.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
