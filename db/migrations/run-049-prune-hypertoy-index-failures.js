require('dotenv').config();
const db = require('../../services/db.pg');

/**
 * 049 — prune the wall of identical hypertoy index failures.
 *
 * Between the 2026-09-01 import and the fix deployed on 2026-09-02, indexing
 * failed on a column the client had renamed out of the feed, and the minute
 * tick retried it 595 times. The run history is where you go to see what the
 * pipeline has been doing; 595 identical red rows is where you stop being able
 * to. Everything real about that night — the import, the swap that never came —
 * is buried under them.
 *
 * KEEPS THE FIRST FIVE. Not zero: the failure itself is the record of what
 * happened, and five is what the new MAX_INDEX_ATTEMPTS would have produced if
 * the limit had existed at the time. What is deleted is only the repetition.
 *
 * Scope is deliberately narrow — one schema, status 'failed', and only runs
 * started after the last completed import. Untouched:
 *   - the 135 non-failed hypertoy runs
 *   - 5 older isolated failures from June to August, which are not this incident
 *   - every other schema
 *
 * Dry by default. Pass --apply to delete.
 *
 *   node db/migrations/run-049-prune-hypertoy-index-failures.js
 *   node db/migrations/run-049-prune-hypertoy-index-failures.js --apply
 */
const SCHEMA = 'hypertoy';
const KEEP = 5;

async function run() {
  const apply = process.argv.includes('--apply');
  try {
    await db.initialize();

    const imp = await db.query(
      `SELECT id, completed_at FROM public.data_reload_runs
        WHERE schema_name = $1 AND status = 'completed' AND total_files IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1`,
      [SCHEMA]
    );
    if (imp.rows.length === 0) {
      console.log('No completed import found — nothing to scope the prune to.');
      process.exit(0);
    }
    const lastImport = imp.rows[0];
    console.log(`Last import: #${lastImport.id} at ${lastImport.completed_at.toISOString()}`);

    // The five earliest failures of this batch, by time. Selected explicitly and
    // deleted by NOT IN, so the keep set is decided once and cannot shift
    // between the count and the delete.
    const keep = await db.query(
      `SELECT id FROM public.data_reload_runs
        WHERE schema_name = $1 AND status = 'failed' AND started_at > $2
        ORDER BY started_at ASC LIMIT ${KEEP}`,
      [SCHEMA, lastImport.completed_at]
    );
    const keepIds = keep.rows.map(r => Number(r.id));
    if (keepIds.length === 0) {
      console.log('No failures in this batch — nothing to prune.');
      process.exit(0);
    }
    console.log(`Keeping the first ${keepIds.length}: ${keepIds.map(i => '#' + i).join(', ')}`);

    const doomed = await db.query(
      `SELECT count(*)::int AS n, min(id) AS lo, max(id) AS hi
         FROM public.data_reload_runs
        WHERE schema_name = $1 AND status = 'failed' AND started_at > $2
          AND id <> ALL($3::bigint[])`,
      [SCHEMA, lastImport.completed_at, keepIds]
    );
    const { n, lo, hi } = doomed.rows[0];
    console.log(`Would delete ${n} rows (#${lo}–#${hi}).`);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to delete.');
      process.exit(0);
    }

    const res = await db.query(
      `DELETE FROM public.data_reload_runs
        WHERE schema_name = $1 AND status = 'failed' AND started_at > $2
          AND id <> ALL($3::bigint[])`,
      [SCHEMA, lastImport.completed_at, keepIds]
    );
    console.log(`Deleted ${res.rowCount} rows.`);

    const after = await db.query(
      `SELECT status, count(*)::int AS n FROM public.data_reload_runs
        WHERE schema_name = $1 GROUP BY status ORDER BY 1`,
      [SCHEMA]
    );
    console.log('Remaining hypertoy runs by status:');
    for (const r of after.rows) console.log(`  ${r.status}: ${r.n}`);
    process.exit(0);
  } catch (err) {
    console.error('Prune failed:', err.message);
    process.exit(1);
  }
}

run();
