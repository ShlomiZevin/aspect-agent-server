/**
 * Build verification — "Validating totals" (M4's fourth stage).
 *
 * A screen does not reach "Ready for review" until these pass. A failed
 * probe fails the BUILD round and its detail feeds back into the spec
 * prompt — the module-init convergence trick applied to screens: every
 * probe names the exact card, set or column to reconsider.
 *
 * The KPI cross-check is two genuinely different computations of the same
 * number: the SQL aggregate over the full set (what the screen will show)
 * versus a JS evaluation of the same card over the delivered rows (what a
 * reader could recompute by hand from the table). They may only be compared
 * when the result set was not truncated — a LIMITed table legitimately
 * holds fewer rows than the KPI covers, and that is a note, not a failure.
 */

const { parseCondition, evalCondition, evalExpr, parseExpr } = require('./expressions');

const FLOAT_TOLERANCE = 0.01;

function jsKpi(card, rows) {
  const filtered = card.where
    ? rows.filter(r => evalCondition(parseCondition(card.where), r))
    : rows;
  switch (card.agg) {
    case 'count':
    case 'countWhere':
      return filtered.length;
    case 'sum':
      return filtered.reduce((a, r) => a + num(r[card.field]), 0);
    case 'avg':
      return filtered.length ? filtered.reduce((a, r) => a + num(r[card.field]), 0) / filtered.length : null;
    case 'min':
      return filtered.length ? Math.min(...filtered.map(r => num(r[card.field]))) : null;
    case 'max':
      return filtered.length ? Math.max(...filtered.map(r => num(r[card.field]))) : null;
    default:
      throw new Error(`jsKpi: unknown agg '${card.agg}'`);
  }
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function close(a, b) {
  if (a === null || b === null) return a === b;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / scale <= FLOAT_TOLERANCE;
}

/**
 * Run every probe over an executed payload.
 * @returns {{passed: boolean, probes: Array<{probe, passed, detail}>}}
 */
function verifyBuild(spec, payload) {
  const probes = [];

  // Every result set must hold rows — a screen whose table is empty on the
  // data it was just built against was planned against the wrong filter or
  // the wrong source, and the user should never be the one to find out.
  for (const rs of spec.resultSets) {
    const set = payload.resultSets[rs.id];
    probes.push({
      probe: `nonempty:${rs.id}`,
      passed: Boolean(set && set.rows.length > 0),
      detail: set
        ? `${set.rows.length} rows${set.truncated ? ' (truncated at limit)' : ''}`
        : 'result set missing from payload',
    });
  }

  // Numeric sanity: a numeric column that is entirely NULL/NaN usually means
  // the wrong column was mapped (the sku-vs-item_number_sales class of bug —
  // rows exist, numbers silently do not).
  for (const rs of spec.resultSets) {
    const set = payload.resultSets[rs.id];
    if (!set || set.rows.length === 0) continue;
    const numericIds = [
      ...(rs.computed || []).map(c => c.id),
      ...(rs.aggregate ? rs.aggregate.measures.map(m => m.id) : []),
    ];
    for (const col of numericIds) {
      const allNull = set.rows.every(r => r[col] === null || r[col] === undefined || Number.isNaN(Number(r[col])));
      probes.push({
        probe: `numeric:${rs.id}.${col}`,
        passed: !allNull,
        detail: allNull ? `every value of '${col}' is NULL — the expression or mapping is wrong` : 'ok',
      });
    }
  }

  // KPI cross-check: SQL value (authoritative, full set) vs JS re-computation
  // over the delivered rows. Only comparable when nothing was truncated.
  for (const block of spec.blocks) {
    if (block.kind !== 'kpiCards') continue;
    const set = payload.resultSets[block.from];
    for (const card of block.cards) {
      const sqlValue = payload.kpis[card.id];
      if (sqlValue === undefined) {
        probes.push({ probe: `kpi:${card.id}`, passed: false, detail: 'KPI value missing from payload' });
        continue;
      }
      if (!set || set.truncated) {
        probes.push({
          probe: `kpi:${card.id}`,
          passed: sqlValue !== null && !Number.isNaN(sqlValue),
          detail: `SQL value ${sqlValue} (rows truncated — JS cross-check skipped)`,
        });
        continue;
      }
      let js;
      try {
        js = jsKpi(card, set.rows);
      } catch (e) {
        probes.push({ probe: `kpi:${card.id}`, passed: false, detail: `JS re-computation failed: ${e.message}` });
        continue;
      }
      probes.push({
        probe: `kpi:${card.id}`,
        passed: close(sqlValue, js),
        detail: close(sqlValue, js)
          ? `SQL ${sqlValue} = rows ${js}`
          : `MISMATCH: SQL over full set = ${sqlValue}, recomputed over delivered rows = ${js} — card '${card.id}' aggregates something different from what the table shows`,
      });
    }
  }

  return { passed: probes.every(p => p.passed), probes };
}

module.exports = { verifyBuild, jsKpi };
