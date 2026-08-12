/**
 * Re-applies the (corrected) figure-checking logic to results already captured
 * by test-insights-suite.js, by re-executing each insight's cited SQL again.
 * Avoids re-running 42 real investigations just to fix a flaw in the checker.
 *
 * Usage: node scripts/recheck-insights-suite.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const registry = require('../insights/datasets/registry');
const { buildResultDigest } = require('../insights/services/result-digest.service');

// Same helpers as the suite — kept in sync deliberately by importing nothing
// from it (the suite is a script, not a module).
function norm(s) { return String(s ?? '').toLowerCase().replace(/[#"'`]/g, '').replace(/\s+/g, ' ').trim(); }
function toNumber(v) {
  const s = String(v ?? '');
  const m = /(-?[\d,]+(?:\.\d+)?)\s*([KM])?/i.exec(s);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  if (m[2]) n *= m[2].toUpperCase() === 'K' ? 1e3 : 1e6;
  if (s.trimStart().startsWith('-') && n > 0) n = -n;
  return n;
}
function checkFigure(fig, digest) {
  const reported = toNumber(fig.value);
  if (reported === null) return { verdict: 'n/a', actual: null, note: 'non-numeric' };
  if (!digest.regrouped || digest.groups.length === 0) return { verdict: 'n/a', actual: null, note: 'no authoritative grouping' };

  // Roll-up labels ("Top 10 Stores", "Combined target (5 stores)", "Remaining
  // 46 Stores") describe an aggregate ACROSS groups, not one entity, so there
  // is no single group to compare them with. Matching them loosely to one
  // group produced nine phantom failures against figures that were exactly
  // right — e.g. "Top 10 Stores: ₪24,978,277", verified correct by SQL, was
  // compared against a single store's ₪2,366,026.
  if (/\b(top|bottom|combined|remaining|rest|overall|others?|average|avg|total)\b/i.test(fig.label) ||
      /\(\s*\d+\s*[^)]*\)/.test(fig.label)) {
    return { verdict: 'n/a', actual: null, note: 'aggregate label — not a single entity' };
  }
  // Ranked-list labels often carry an annotation ("store-114 — avg attainment
  // 46.2%"); match on the entity part only.
  fig = { ...fig, label: String(fig.label).split(/\s+[\u2014\u2013]\s+/)[0] };
  const target = norm(fig.label);
  let hit = digest.groups.find(g => norm(g.key) === target);
  if (!hit) {
    const loose = digest.groups.filter(g => { const k = norm(g.key); return k.includes(target) || target.includes(k); });
    if (loose.length !== 1) return { verdict: 'n/a', actual: null, note: loose.length ? 'ambiguous label' : 'label not in groups' };
    hit = loose[0];
  }
  if (/%|pp\b|pts\b/i.test(String(fig.value))) return { verdict: 'n/a', actual: null, note: 'percentage — no additive counterpart' };
  const candidates = Object.values(hit.values).filter(v => Number.isFinite(v));
  let best = null, bestErr = Infinity;
  for (const c of candidates) {
    const err = Math.abs(c) < 1e-9 ? (Math.abs(reported) < 1e-9 ? 0 : Infinity) : Math.abs(reported - c) / Math.abs(c);
    if (err < bestErr) { bestErr = err; best = c; }
  }
  if (best === null) return { verdict: 'n/a', actual: null, note: 'no numeric measure' };
  return { verdict: bestErr <= 0.015 ? 'MATCH' : 'MISMATCH', actual: best, err: bestErr };
}

async function main() {
  const dir = path.join(__dirname, '..');
  const files = fs.readdirSync(dir).filter(f => /^suite-results-.*\.json$/.test(f));
  for (const file of files) {
    const ds = file.replace('suite-results-', '').replace('.json', '');
    const pool = registry.get(ds).getPool();
    const rows = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const r of rows) {
      if (r.error || !r.sql) continue;
      try {
        const fresh = await pool.query(r.sql);
        const truth = buildResultDigest(fresh.rows, { dimensions: r.aggregation?.groupedBy || [], measures: [] });
        r.checks = (r.checks || []).map(c => {
          const { verdict, actual, err, note, ...fig } = c;
          return { ...fig, ...checkFigure(fig, truth) };
        });
        r.mismatches = r.checks.filter(x => x.verdict === 'MISMATCH').length;
        r.matches = r.checks.filter(x => x.verdict === 'MATCH').length;
      } catch (e) {
        r.recheckError = e.message.slice(0, 120);
      }
    }
    fs.writeFileSync(path.join(dir, file), JSON.stringify(rows, null, 2));
    console.log(`rechecked ${ds}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
