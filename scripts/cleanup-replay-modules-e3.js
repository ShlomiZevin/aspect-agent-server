/**
 * Remove the replay/test traffic this branch's E3 verification created in the
 * SHARED platform DB.
 *
 * Replay runs are attributed to users.external_id `replay-modules-e3*` and
 * conversations.external_id `replay-modules-e3-*` — deliberately, so they can
 * be identified and
 * removed later. This is that later. Left in place they are test cruft in a
 * database Kosta looks at, and they would show up in conversation lists and
 * usage counts as if they were real customer traffic.
 *
 * `thinking_steps.conversation_id` is the INTEGER conversations.id, not the
 * varchar external id — deleting by the external id directly fails with a type
 * error, so every child delete resolves through conversations.id.
 *
 * Run:  node scripts/cleanup-replay-modules-e3.js --dry-run
 *       node scripts/cleanup-replay-modules-e3.js --apply
 */
require('dotenv').config();
const db = require('../services/db.pg');

const PREFIX = 'replay-modules-e3';
const apply = process.argv.includes('--apply');

async function main() {
  await db.initialize();

  const convs = await db.query(
    `SELECT id, external_id FROM conversations WHERE external_id LIKE $1`, [`${PREFIX}%`]);
  const users = await db.query(
    `SELECT id, external_id FROM users WHERE external_id LIKE $1`, [`${PREFIX}%`]);
  const ids = convs.rows.map(r => r.id);

  const count = async (sql, params) => (await db.query(sql, params)).rows[0].c;
  const msgs  = ids.length ? await count(`SELECT count(*)::int c FROM messages WHERE conversation_id = ANY($1)`, [ids]) : 0;
  const steps = ids.length ? await count(`SELECT count(*)::int c FROM thinking_steps WHERE conversation_id = ANY($1)`, [ids]) : 0;

  console.log(`conversations : ${convs.rows.length}`);
  console.log(`messages      : ${msgs}`);
  console.log(`thinking_steps: ${steps}`);
  console.log(`users         : ${users.rows.length} (${users.rows.map(u => u.external_id).join(', ') || 'none'})`);

  if (!apply) { console.log('\nDRY RUN — nothing deleted. Re-run with --apply.'); process.exit(0); }
  if (!ids.length && !users.rows.length) { console.log('\nNothing to delete.'); process.exit(0); }

  // Children first: no ON DELETE CASCADE is assumed to exist.
  if (ids.length) {
    await db.query(`DELETE FROM thinking_steps WHERE conversation_id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM messages       WHERE conversation_id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM conversations  WHERE id = ANY($1)`, [ids]);
  }
  if (users.rows.length) {
    await db.query(`DELETE FROM users WHERE external_id LIKE $1`, [`${PREFIX}%`]);
  }
  console.log('\nDeleted.');
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
