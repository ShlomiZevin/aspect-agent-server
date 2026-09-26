require('dotenv').config();
const { getPool, endPool } = require('../../services/db.zer4u');
const { visualToLogical } = require('../../scripts/lib/visual-rtl');

/**
 * 057 — thestock.products.item_description: visual → logical Hebrew.
 *
 * The May 2026 TheStock export delivered every item description in VISUAL
 * order (reversed Hebrew behind a U+202D override), so the chat showed
 * product names backwards ('יללכ רצומ' for 'מוצר כללי'). The loader now
 * converts that column on every load (format 'visual_rtl' in
 * column-aliases-thestock.js). This fixes the rows ALREADY loaded, with the
 * same function, so the live data does not wait for the next TheStock
 * delivery — a full reload would re-copy 12 GB of facts to fix 61K short
 * strings.
 *
 * Customer-data DB (aspect-data-db, via db.zer4u). Only rows still carrying
 * the override marker are touched, and visualToLogical is idempotent, so a
 * re-run changes nothing. One transaction: all rows or none.
 *
 * Dry by default. Pass --apply to write.
 *
 *   node db/migrations/run-057-thestock-item-description-logical-order.js
 *   node db/migrations/run-057-thestock-item-description-logical-order.js --apply
 */
const LRO = '‭';
const BATCH = 5000;

async function run() {
  const apply = process.argv.includes('--apply');
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT DISTINCT item_description FROM thestock.products WHERE item_description LIKE '%' || $1 || '%'`,
      [LRO]
    );
    const pairs = rows
      .map(r => [r.item_description, visualToLogical(r.item_description)])
      .filter(([from, to]) => from !== to);

    console.log(`Distinct visual-order descriptions: ${pairs.length}`);
    for (const [from, to] of pairs.slice(0, 8)) {
      console.log(`  ${JSON.stringify(from.replace(/[‪-‮]/g, ''))}  ->  ${JSON.stringify(to)}`);
    }

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to write.');
      return;
    }

    await client.query('BEGIN');
    let updated = 0;
    for (let i = 0; i < pairs.length; i += BATCH) {
      const chunk = pairs.slice(i, i + BATCH);
      const res = await client.query(
        `UPDATE thestock.products p
            SET item_description = m.logical
           FROM UNNEST($1::text[], $2::text[]) AS m(visual, logical)
          WHERE p.item_description = m.visual`,
        [chunk.map(p => p[0]), chunk.map(p => p[1])]
      );
      updated += res.rowCount;
    }
    const { rows: [left] } = await client.query(
      `SELECT count(*)::int AS n FROM thestock.products WHERE item_description LIKE '%' || $1 || '%'`, [LRO]);
    if (left.n !== 0) throw new Error(`${left.n} rows still carry the override marker — rolling back`);
    await client.query('COMMIT');
    console.log(`\nUpdated ${updated} rows. No visual-order descriptions remain.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 057 failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await endPool();
  }
}

run();
