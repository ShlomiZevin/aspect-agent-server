/**
 * Wipe everything HQ knows and start clean.
 *
 * Order matters: vectors go first, because a deleted atom row leaves no way to
 * find its chunks in Pinecone afterwards — they'd sit in the namespace forever
 * and still surface in answers.
 *
 * The Notion inventory (hq_sync_items) is kept but reset to "not yet", so the
 * 796-page list doesn't have to be rediscovered — only re-picked.
 *
 *   node hq/scripts/reset.js          # dry run, shows what would go
 *   node hq/scripts/reset.js --yes    # actually do it
 */

require('dotenv').config();
const db = require('../../services/db.pg');
const ingest = require('../services/ingest.service');

const GO = process.argv.includes('--yes');

(async () => {
  await db.initialize();

  const { rows: atoms } = await db.query(`SELECT id, title FROM hq_atoms ORDER BY id`);
  const { rows: srcs } = await db.query(`SELECT id, label FROM hq_sources ORDER BY id`);
  const { rows: [items] } = await db.query(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status <> 'pending')::int touched
       FROM hq_sync_items`);

  console.log(`\n${GO ? 'RESETTING' : 'DRY RUN — nothing will be deleted'}\n`);
  console.log(`  ${atoms.length} things HQ knows -> deleted (rows + vectors)`);
  console.log(`  ${srcs.length} sources         -> deleted`);
  console.log(`  ${items.total} Notion pages    -> kept, reset to "not yet" (${items.touched} were marked)`);
  console.log(`  sync history                   -> cleared\n`);

  if (!GO) {
    atoms.forEach(a => console.log(`    - #${a.id} ${a.title.slice(0, 60)}`));
    console.log('\nRe-run with --yes to apply.');
    process.exit(0);
  }

  for (const a of atoms) {
    await ingest.removeAtom(a.id);
    console.log(`  removed #${a.id} ${a.title.slice(0, 50)}`);
  }

  await db.query(`DELETE FROM hq_sync_runs`);
  await db.query(
    `UPDATE hq_sync_items
        SET status='pending', atom_id=NULL, chars=NULL, chunks=NULL,
            error=NULL, synced_at=NULL, synced_edited_at=NULL, updated_at=NOW()`);
  await db.query(`DELETE FROM hq_links`);
  await db.query(`DELETE FROM hq_sources`);

  const { rows: [after] } = await db.query(`SELECT COUNT(*)::int n FROM hq_atoms`);
  console.log(`\nDone. HQ knows ${after.n} things. The Notion inventory is intact and unpicked.`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
