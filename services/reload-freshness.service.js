/**
 * Post-reload MV freshness assertion (Stage 3, item C).
 *
 * After a schema swap, every materialized view that carries the dataset's
 * date column must reach the same max date as the base sales rows. The
 * Stage-1 reload rebuilds MVs fresh each night, so this SHOULD always pass —
 * the assertion exists so the pre-Stage-1 failure mode (views silently stale
 * behind the fact table, every aggregate answer wrong by omission) can never
 * return unnoticed.
 *
 * LOG-AND-SURFACE ONLY. This must never fail or slow a reload materially:
 * every path is wrapped, and the result is cached in-process for
 * data-health.service to display in the data-status panel.
 *
 * Generic: activation requires `manifest.freshness` — datasets without a
 * manifest (or without the block) are skipped silently.
 */

const lastResults = new Map(); // schemaName -> { at, ok, details }

/**
 * @param {string} schemaName
 * @param {Object} pool - pg pool for the dataset's data DB
 * @param {(step: string, msg: string) => void} [emitLog]
 * @returns {Promise<{ok: boolean, details: Array}|null>} null when skipped
 */
async function assertFreshness(schemaName, pool, emitLog = () => {}) {
  try {
    const manifest = require('./dataset-manifest').get(schemaName);
    const f = manifest?.freshness;
    if (!f) return null;

    const { rows: [base] } = await pool.query(
      `SELECT MAX(${f.baseDateColumn}) AS max_date FROM ${f.baseTable}` +
      (f.baseFilter ? ` WHERE ${f.baseFilter}` : ''));
    const baseMax = base?.max_date ? String(base.max_date).slice(0, 10) : null;
    if (!baseMax) return null;

    let { rows: views } = await pool.query(`
      SELECT m.matviewname AS name
      FROM pg_matviews m
      WHERE m.schemaname = $1
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = m.schemaname AND c.relname = m.matviewname
            AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        )`, [schemaName, f.dateColumn]);
    // When the manifest names the views that must track the base (it should:
    // dated views built from OTHER record kinds legitimately lag the sales
    // max), check only those. Unlisted-but-dated views are someone's semantic
    // decision, not staleness evidence.
    if (Array.isArray(f.views) && f.views.length) {
      views = views.filter(v => f.views.includes(v.name));
    }

    const details = [];
    let ok = true;
    for (const v of views) {
      try {
        const { rows: [r] } = await pool.query(
          `SELECT MAX(${f.dateColumn}) AS max_date FROM ${schemaName}.${v.name}`);
        const viewMax = r?.max_date ? String(r.max_date).slice(0, 10) : null;
        const fresh = viewMax === baseMax;
        if (!fresh) ok = false;
        details.push({ view: v.name, viewMax, baseMax, fresh });
      } catch (err) {
        details.push({ view: v.name, error: err.message.slice(0, 120) });
      }
    }

    const result = { at: new Date().toISOString(), ok, baseMax, details };
    lastResults.set(schemaName, result);
    if (ok) {
      emitLog('freshness', `Freshness check OK: ${details.length} dated view(s) all reach ${baseMax}`);
    } else {
      const stale = details.filter(d => d.fresh === false).map(d => `${d.view} (${d.viewMax})`).join(', ');
      emitLog('freshness', `⚠️ FRESHNESS MISMATCH: base ${f.baseTable} reaches ${baseMax} but: ${stale}`);
      console.error(`🔴 [reload-freshness] ${schemaName}: stale views after swap — ${stale} vs base ${baseMax}`);
    }
    return result;
  } catch (err) {
    // The assertion is a guard, never a blocker.
    console.warn(`⚠️ [reload-freshness] ${schemaName}: check failed (${err.message}) — reload unaffected`);
    return null;
  }
}

/** Last known result for the data-status panel (may be null). */
function lastResult(schemaName) {
  return lastResults.get(schemaName) || null;
}

module.exports = { assertFreshness, lastResult };
