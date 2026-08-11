/**
 * Deterministic, code-computed summary of a FULL query result set — the fix
 * for the single worst accuracy bug in the investigation pipeline.
 *
 * THE BUG THIS EXISTS FOR (caught live on hypertoy, 2026-08-10):
 * "Which marketing campaigns drive the most revenue?" produced SQL grouped by
 * (campaign_code, campaign_name) — 20,721 result rows, because campaign_name
 * is really a per-transaction discount amount, so ONE campaign spreads across
 * hundreds of rows. Only the first 30 rows were ever shown to the write-up
 * model (see SAMPLE_LIMIT in investigation.service.js), and it read one row
 * per campaign as that campaign's total. Result:
 *   · campaign 78  reported ₪7,885   — really ₪555,229  (70x)
 *   · campaign 90  reported ₪3,320   — really ₪421,229  (127x)
 *   · "99.7% of revenue unattributed" — really 94.9%
 *   · the true #1 campaign (146, ₪568,402) never appeared at all
 * Every one of those numbers was literally present in the 30 rows shown, so
 * the independent VERIFY pass confirmed them all and the insight shipped at
 * 72% confidence. Verification checks PROVENANCE; it cannot check that the
 * sample represents the population.
 *
 * THE FIX: never ask a model to add up rows it can only partially see.
 * This module re-aggregates the ENTIRE result array in plain JS — no LLM, no
 * sampling — collapsing any accidental extra grain back down to the grain the
 * PLAN step actually asked for, and computes grand totals across every row.
 * Those numbers become the authoritative figures the write-up must use; the
 * 30-row sample is demoted to illustration only.
 *
 * Deliberately conservative: when the declared dimensions can't be mapped to
 * real columns, it does NOT guess a grouping — it still reports grand totals
 * (which are always correct regardless of grain) and flags that no regrouping
 * happened, so the caller can tell the model to avoid per-item claims.
 */

/** Rows beyond this are never shown to a model — must match investigation.service.js. */
const SAMPLE_LIMIT = 30;
/** How many re-aggregated groups to hand to the model. Above the 10-item ranked_list cap, with headroom. */
const TOP_GROUPS = 15;

/**
 * Columns whose values are numeric but which are IDENTIFIERS, not measures —
 * summing `campaign_code` or `store_id` produces a meaningless number that
 * looks perfectly plausible in a headline. Checked on the column NAME because
 * the values themselves are indistinguishable from real measures.
 */
const ID_LIKE = /(^|_)(id|ids|code|codes|key|keys|number|no|sku|barcode|zip|phone|year|month|week|day|quarter)$|^(id|code|key)$/i;

/**
 * Numeric columns that must NEVER be summed. A total of a percentage, a rate,
 * an average, a unit price or a threshold is arithmetically meaningless but
 * looks entirely plausible once it reaches a headline — "₪3,068,664 campaign
 * value" (the sum of every per-transaction discount threshold) was produced
 * by exactly this gap on the first run of this module. These stay visible as
 * columns but get min/max/avg reported instead of a total.
 */
const NON_ADDITIVE = /(pct|percent|rate|ratio|avg|average|mean|median|margin|threshold|price|share|index|score|level|per_unit|_per_)/i;

/** Postgres returns numeric/decimal columns as strings — "1234.56", never 1234.56. */
function parseNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** "Product Family" -> ["product","family"]; used for fuzzy declared-dimension -> column matching. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !['the', 'per', 'by', 'and', 'for', 'total', 'all'].includes(w));
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Splits result columns into dimensions (things you group BY) and measures
 * (things you SUM). A column counts as a measure only when EVERY non-null
 * value parses as a number AND its name isn't identifier-shaped.
 */
function classifyColumns(rows) {
  const columns = Object.keys(rows[0] || {});
  const dimensions = [], measures = [], nonAdditive = [];

  for (const col of columns) {
    const values = rows.map(r => r[col]);
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
    const allNumeric = nonNull.length > 0 && nonNull.every(v => parseNumeric(v) !== null);
    if (!allNumeric || ID_LIKE.test(col)) dimensions.push(col);
    else if (NON_ADDITIVE.test(col)) nonAdditive.push(col);
    else measures.push(col);
  }
  return { dimensions, measures, nonAdditive };
}

function cardinality(rows, col) {
  const seen = new Set();
  for (const r of rows) seen.add(String(r[col]));
  return seen.size;
}

/**
 * Generic naming furniture that carries no entity meaning — a column called
 * `family_description` is just as much "the family" as one called `family`,
 * so these words must not count against it when scoring.
 */
const NOISE_WORDS = new Set(['description', 'desc', 'name', 'label', 'code', 'ids', 'key', 'number', 'title', 'value', 'total']);

/**
 * Maps each declared dimension (plain English, from the PLAN step — e.g.
 * "campaign") onto the best real result column.
 *
 * Scored by (1) how many of the declared dimension's words appear in the
 * column name, then (2) how many words in the COLUMN name are left
 * UNEXPLAINED by the declaration. That second term is what separates a real
 * entity column from a derived annotation, and it fixes both observed
 * mis-mappings:
 *   · "campaign" → campaign_code (0 unexplained) beats campaign_value_threshold
 *     (2: "value", "threshold") — the accidental extra grain that exploded
 *     340 campaigns into 20,721 rows.
 *   · "product family" → family_description (0 unexplained) beats
 *     steepest_decline_family (2: "steepest", "decline") — a sparse
 *     LEFT JOIN annotation that would otherwise have become the grouping key
 *     while the real entity got summed away.
 * Density then cardinality break any remaining tie: a column that is NULL on
 * most rows, or that has only one distinct value, is not a breakdown.
 */
function mapDeclaredDimensions(rows, dimensionCols, declaredDimensions) {
  const chosen = [];
  const used = new Set();

  for (const declared of declaredDimensions) {
    const words = tokenize(declared);
    if (words.length === 0) continue;

    const scored = dimensionCols
      .filter(col => !used.has(col))
      .map(col => {
        const norm = normalizeName(col);
        const hits = words.filter(w => norm.includes(w)).length;
        const colWords = tokenize(col).filter(w => !NOISE_WORDS.has(w));
        const unexplained = colWords.filter(w => !words.some(dw => w.includes(dw) || dw.includes(w))).length;
        const nonNull = rows.filter(r => r[col] !== null && r[col] !== undefined && r[col] !== '').length;
        return { col, hits, unexplained, density: nonNull / rows.length, card: cardinality(rows, col) };
      })
      .filter(c => c.hits > 0 && c.card > 1)
      .sort((a, b) =>
        (b.hits - a.hits) ||
        (a.unexplained - b.unexplained) ||
        (b.density - a.density) ||
        (a.card - b.card) ||
        (a.col.length - b.col.length));

    if (scored.length > 0) {
      chosen.push(scored[0].col);
      used.add(scored[0].col);
    }
  }

  return { groupBy: chosen, collapsed: dimensionCols.filter(c => !used.has(c)) };
}

/** Picks the measure the ranking should be ordered by — a declared measure if one maps, else the largest-magnitude column. */
function pickPrimaryMeasure(rows, measures, declaredMeasures) {
  for (const declared of declaredMeasures || []) {
    const words = tokenize(declared);
    const hit = measures.find(m => {
      const norm = normalizeName(m);
      return words.some(w => norm.includes(w));
    });
    if (hit) return hit;
  }
  // Fall back to whichever measure carries the most magnitude — for a
  // revenue/count pair that's revenue, which is nearly always what a
  // "top N" question is really about.
  let best = measures[0] || null, bestMag = -Infinity;
  for (const m of measures) {
    const mag = rows.reduce((a, r) => a + Math.abs(parseNumeric(r[m]) ?? 0), 0);
    if (mag > bestMag) { bestMag = mag; best = m; }
  }
  return best;
}

/**
 * @param {Object[]} data - the COMPLETE result rows (not a sample)
 * @param {Object} spec - { dimensions: string[], measures: string[] } from the PLAN step
 * @returns {Object} digest — see formatForPrompt() for what reaches the model
 */
function buildResultDigest(data, spec = {}) {
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    return { rowCount: 0, empty: true, truncatedSample: false, measures: [], grandTotals: {}, groups: [], groupBy: [], collapsedColumns: [], regrouped: false };
  }

  const { dimensions: dimensionCols, measures, nonAdditive } = classifyColumns(rows);
  const { groupBy, collapsed } = mapDeclaredDimensions(rows, dimensionCols, spec.dimensions || []);

  // Grand totals are computed over EVERY row and are correct no matter how
  // the SQL was grained — this is what makes percentage claims trustworthy.
  const grandTotals = {};
  for (const m of measures) {
    grandTotals[m] = rows.reduce((a, r) => a + (parseNumeric(r[m]) ?? 0), 0);
  }

  // Ranges, never sums — see NON_ADDITIVE.
  const ranges = {};
  for (const m of nonAdditive) {
    const vals = rows.map(r => parseNumeric(r[m])).filter(v => v !== null);
    if (vals.length > 0) {
      ranges[m] = { min: Math.min(...vals), max: Math.max(...vals), avg: vals.reduce((a, b) => a + b, 0) / vals.length };
    }
  }

  const primaryMeasure = pickPrimaryMeasure(rows, measures, spec.measures);

  let groups = [];
  const regrouped = groupBy.length > 0;
  if (regrouped) {
    const byKey = new Map();
    for (const r of rows) {
      const key = groupBy.map(c => String(r[c] ?? '—')).join(' · ');
      let g = byKey.get(key);
      if (!g) { g = { key, rows: 0, values: Object.fromEntries(measures.map(m => [m, 0])) }; byKey.set(key, g); }
      g.rows++;
      for (const m of measures) g.values[m] += parseNumeric(r[m]) ?? 0;
    }
    groups = [...byKey.values()];
    if (primaryMeasure) groups.sort((a, b) => Math.abs(b.values[primaryMeasure]) - Math.abs(a.values[primaryMeasure]));
  }

  // Pre-computed roll-ups for the handful of combined figures a write-up
  // almost always wants ("the top 5 together are X, or Y% of the total").
  // Without these the model does that addition and that division itself, and
  // gets them wrong: on the first run after the digest shipped it stated the
  // top 5 as "5.09% of ₪98.3M" when ₪2.42M/₪98.3M is 2.46% — 5.09% was the
  // share of ALL 28 campaigns. Every figure here is exact by construction.
  const rollups = {};
  if (regrouped && primaryMeasure && groups.length > 0) {
    const grand = grandTotals[primaryMeasure] || 0;
    const cum = n => groups.slice(0, n).reduce((a, g) => a + g.values[primaryMeasure], 0);
    for (const n of [1, 3, 5, 10]) {
      if (groups.length >= n) {
        const value = cum(n);
        rollups[`top${n}`] = { value, share: grand ? (100 * value / grand) : null, entities: groups.slice(0, n).map(g => g.key) };
      }
    }
    // "Everything except the single biggest group" — when one bucket dominates
    // (an unattributed/"no campaign"/"other" catch-all, which is extremely
    // common in real retail data), this is the figure the finding is actually
    // about, and it's the one the model is most likely to mis-derive.
    if (groups.length > 1) {
      const rest = groups.slice(1).reduce((a, g) => a + g.values[primaryMeasure], 0);
      rollups.excludingLargest = { value: rest, share: grand ? (100 * rest / grand) : null, largest: groups[0].key, count: groups.length - 1 };
    }
  }

  // Superlative questions ("which family had the STEEPEST margin decline")
  // are about a metric that cannot be summed, so the ranking above — which is
  // by an additive measure — does not answer them. But the exact answer is
  // still computable whenever no aggregation is required, i.e. each row
  // already carries one value of that metric. Without this the model picked a
  // family off the by-revenue ranking and called it "the steepest single-month
  // drop of any family" (Lego, -2.19pp) when the real answer was -194.10pp,
  // and the verifier passed it because -2.19pp was genuinely in the sample.
  // Computed for EVERY numeric column, not just the non-summable ones: a
  // min/max over rows is exact regardless of additivity, and the column that
  // actually carries the superlative is often one the name-based additivity
  // rule can't classify either way (`mom_change` says nothing about whether
  // the thing that changed was a ratio or a quantity).
  const extremes = {};
  const rowLabel = r => (dimensionCols.length ? dimensionCols.map(c => String(r[c] ?? '—')).join(' · ') : '(row)');

  // MATERIALITY. A ratio computed on a tiny base is arithmetically correct and
  // analytically worthless: a product family with ₪119 of sales swinging
  // -194pp of margin outranks every real decline in the business, and a
  // write-up will faithfully call it "the steepest decline of any family".
  // Nothing in the pipeline used to prevent that — the number is real, so
  // VERIFY passes it. Here the same extremes are computed a second time over
  // only the rows that carry a meaningful share of the primary additive
  // measure, so the model is handed both lists and told which one answers a
  // business question. Threshold is relative (share of the grand total), so it
  // needs no per-dataset tuning.
  const MATERIAL_SHARE = 0.005; // 0.5% of the total measure
  let materialRows = rows, materialityBasis = null;
  if (primaryMeasure && grandTotals[primaryMeasure]) {
    const cutoff = Math.abs(grandTotals[primaryMeasure]) * MATERIAL_SHARE;
    const filtered = rows.filter(r => Math.abs(parseNumeric(r[primaryMeasure]) ?? 0) >= cutoff);
    // Only worth reporting separately when it actually changes the picture and
    // still leaves enough rows to rank.
    if (filtered.length >= 3 && filtered.length < rows.length) {
      materialRows = filtered;
      materialityBasis = { measure: primaryMeasure, cutoff, kept: filtered.length, dropped: rows.length - filtered.length };
    }
  }

  for (const col of [...nonAdditive, ...measures].slice(0, 6)) {
    const build = src => {
      const vals = src.map(r => ({
        key: rowLabel(r),
        value: parseNumeric(r[col]),
        // The supporting magnitude travels WITH the extreme, so "-194.10" can
        // never be read without seeing the ₪119 it rests on.
        base: primaryMeasure && primaryMeasure !== col ? parseNumeric(r[primaryMeasure]) : null,
      })).filter(x => x.value !== null);
      if (vals.length < 3) return null;
      const sorted = [...vals].sort((a, b) => a.value - b.value);
      if (sorted[0].value === sorted[sorted.length - 1].value) return null;
      return { lowest: sorted.slice(0, 5), highest: sorted.slice(-5).reverse() };
    };
    const all = build(rows);
    if (!all) continue;
    extremes[col] = all;
    if (materialityBasis) {
      const material = build(materialRows);
      if (material) extremes[col].material = material;
    }
  }

  return {
    rowCount: rows.length,
    empty: false,
    rollups,
    extremes,
    materiality: materialityBasis,
    truncatedSample: rows.length > SAMPLE_LIMIT,
    sampleLimit: SAMPLE_LIMIT,
    dimensionColumns: dimensionCols,
    measures,
    nonAdditive,
    ranges,
    primaryMeasure,
    grandTotals,
    groupBy,
    regrouped,
    collapsedColumns: collapsed,
    distinctGroups: groups.length,
    groups: groups.slice(0, TOP_GROUPS),
  };
}

function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : 4;
  return Number(n.toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp });
}

/**
 * Renders the digest as the AUTHORITATIVE block injected into both the
 * SYNTHESIZE and VERIFY prompts. Deliberately blunt about what the model is
 * and is not allowed to do with the raw sample — the sample being mistaken
 * for the population is the entire failure this module exists to prevent.
 */
function formatForPrompt(digest) {
  if (digest.empty) return 'AUTHORITATIVE AGGREGATES: the query returned ZERO rows.';

  const lines = [];
  lines.push('AUTHORITATIVE AGGREGATES (computed in code over ALL ' + digest.rowCount.toLocaleString('en-US') + ' result rows — NOT a sample, NOT model arithmetic).');
  lines.push('These figures are correct by construction. Use them verbatim for every total, share, ranking and percentage.');
  lines.push('');

  lines.push('GRAND TOTALS across every row:');
  for (const [m, v] of Object.entries(digest.grandTotals)) lines.push(`  · ${m} = ${fmt(v)}`);
  if (!Object.keys(digest.grandTotals).length) lines.push('  (none — no additive measure in this result)');

  if (Object.keys(digest.ranges || {}).length > 0) {
    lines.push('');
    lines.push('NOT SUMMABLE (percentages / rates / averages / unit prices / thresholds — a total of these is meaningless, so none is given; use only the range or a single row\'s value):');
    for (const [m, r] of Object.entries(digest.ranges)) lines.push(`  · ${m}: min ${fmt(r.min)}, max ${fmt(r.max)}, avg ${fmt(r.avg)}`);
  }

  if (Object.keys(digest.extremes || {}).length > 0) {
    lines.push('');
    lines.push(`EXACT PER-ROW EXTREMES, scanned across EVERY row. This is the ONLY valid basis for a superlative — "steepest", "highest", "lowest", "worst", "best". The entity ranking further down is ordered by ${digest.primaryMeasure || 'one additive measure'} only, and does NOT answer a superlative about any other metric; do not read one off it:`);
    const withBase = x => (x.base === null || x.base === undefined
      ? `${x.key} (${fmt(x.value)})`
      : `${x.key} (${fmt(x.value)}, on ${digest.primaryMeasure}=${fmt(x.base)})`);
    for (const [col, e] of Object.entries(digest.extremes)) {
      lines.push(`  · ${col} — lowest: ${e.lowest.map(withBase).join('; ')}`);
      lines.push(`  · ${col} — highest: ${e.highest.map(withBase).join('; ')}`);
      if (e.material) {
        lines.push(`    ↳ MATERIAL ONLY (${col}) — lowest: ${e.material.lowest.map(withBase).join('; ')}`);
        lines.push(`    ↳ MATERIAL ONLY (${col}) — highest: ${e.material.highest.map(withBase).join('; ')}`);
      }
    }
    if (digest.materiality) {
      const m = digest.materiality;
      lines.push('');
      lines.push(`MATERIALITY — ${m.dropped.toLocaleString('en-US')} of ${digest.rowCount.toLocaleString('en-US')} rows carry less than ${fmt(m.cutoff)} of ${m.measure} (under 0.5% of the total) and are EXCLUDED from the "MATERIAL ONLY" lists above.`);
      lines.push('A ratio, percentage or change computed on a tiny base is arithmetically correct but analytically worthless — a family with a few hundred shekels of sales will out-rank the entire business on any percentage measure. When the finding is a superlative or a ranking meant to drive a decision, USE THE MATERIAL LIST. If you deliberately report an extreme from the full list, you MUST state its base alongside it (e.g. "-194pp, but on only ₪119 of sales") and must not call it the business\'s steepest/worst without that qualifier.');
    }
  }

  if (digest.regrouped) {
    lines.push('');
    lines.push(`TRUE TOTALS PER ${digest.groupBy.join(' + ').toUpperCase()} (re-aggregated across all rows, ranked by ${digest.primaryMeasure}; ${digest.distinctGroups.toLocaleString('en-US')} distinct in total, top ${Math.min(digest.groups.length, TOP_GROUPS)} shown):`);
    for (const [i, g] of digest.groups.entries()) {
      const parts = Object.entries(g.values).map(([m, v]) => `${m}=${fmt(v)}`).join(', ');
      const share = digest.primaryMeasure && digest.grandTotals[digest.primaryMeasure]
        ? ` (${(100 * g.values[digest.primaryMeasure] / digest.grandTotals[digest.primaryMeasure]).toFixed(2)}% of ${digest.primaryMeasure})`
        : '';
      lines.push(`  ${i + 1}. ${g.key} — ${parts}${share} [from ${g.rows.toLocaleString('en-US')} raw rows]`);
    }
    if (Object.keys(digest.rollups || {}).length > 0) {
      lines.push('');
      lines.push(`PRE-COMPUTED COMBINED FIGURES for ${digest.primaryMeasure} (exact — use these verbatim instead of adding groups up yourself, and instead of dividing to get a share):`);
      for (const [key, r] of Object.entries(digest.rollups)) {
        const share = r.share === null || r.share === undefined ? '' : ` = ${r.share.toFixed(2)}% of the grand total`;
        const extra = key === 'excludingLargest'
          ? ` (the other ${r.count} excluding "${r.largest}")`
          : (r.entities ? ` (${r.entities.join(', ')})` : '');
        lines.push(`  · ${key}: ${fmt(r.value)}${share}${extra}`);
      }
    }

    if (digest.collapsedColumns.length > 0) {
      lines.push('');
      lines.push(`NOTE: the SQL grouped at a FINER grain than the question asked for. Column(s) [${digest.collapsedColumns.join(', ')}] were an accidental extra breakdown and have been summed away above. Do NOT present those columns as entities, and do NOT read any single raw row as an entity's total.`);
    }
  } else {
    lines.push('');
    lines.push('NOTE: the result could not be re-aggregated to a single named entity, so no per-item totals are authoritative. State the grand totals and the observed pattern, but do NOT claim a per-item total or a ranking.');
  }

  if (digest.truncatedSample) {
    lines.push('');
    lines.push(`CRITICAL: you are shown only ${digest.sampleLimit} of ${digest.rowCount.toLocaleString('en-US')} raw rows below (${(100 * digest.sampleLimit / digest.rowCount).toFixed(2)}% of the result). Those rows are ILLUSTRATIVE ONLY. You may NOT sum them, count them, rank from them, or infer any total from them — every such figure must come from the authoritative aggregates above. A raw row is not an entity's total.`);
  }

  return lines.join('\n');
}

module.exports = { buildResultDigest, formatForPrompt, parseNumeric, classifyColumns, SAMPLE_LIMIT, TOP_GROUPS };
