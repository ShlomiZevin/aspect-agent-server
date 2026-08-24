/**
 * Compare two customer-replay runs (Stage 2, Step 6 / T3).
 *
 * Per-question verdicts + aggregate scoreboard → COMPARISON.md next to the
 * runs. Frozen-data rule enforced: refuses to compare when the two runs saw
 * different dataState (unless --force).
 *
 * Verdicts:
 *   better — base failed/empty and post replied; or a gated question now
 *            refuses (no SQL burned); or a money answer gained its caveat
 *   same   — outcome and honesty markers at parity
 *   worse  — base replied (with SQL evidence) and post errored/empty, or a
 *            caveat present at base disappeared
 *   review — ambiguous; listed for the manual honesty audit
 *
 * Usage: node scripts/compare-replays.js <baseFile> <postFile> [--force]
 */
const fs = require('fs');
const path = require('path');

const [baseFile, postFile] = [process.argv[2], process.argv[3]];
if (!baseFile || !postFile) { console.error('Usage: node scripts/compare-replays.js <baseFile> <postFile>'); process.exit(1); }
const force = process.argv.includes('--force');

const A = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const B = JSON.parse(fs.readFileSync(postFile, 'utf8'));

// Frozen-data check
const dsA = JSON.stringify(A.meta.dataState), dsB = JSON.stringify(B.meta.dataState);
if (dsA !== dsB && !force) {
  console.error('❌ dataState differs between runs — comparison invalid (plan §2.5). Re-run the baseline, or pass --force to compare anyway.');
  console.error('base:', dsA, '\npost:', dsB);
  process.exit(1);
}

// The gate-refusal set (absent dimensions — see zolstock.manifest refusals)
const GATED = new Set(['18167', '18239', '18241', '18243', '18251', '18314', '18316', '18546', '22669', '24125', '24167']);

const CAVEAT_RE = /מחירון|list[- ]price|אומדן|estimate|משוער/i;
const DTHROUGH_RE = /2026-08-\d\d|19\.8|באוגוסט|through|עד ה?-?\s?\d{1,2}[./]/i;
const REFUSE_RE = /אין (במאגר|נתוני)|does not (contain|include)|isn['’]t available|not available|לא ניתן|no .{0,25}(data|records|identities|dimension)|cannot|can['’]t/i;

const hasSql = r => (r.evidence || []).some(e => e.sql);
const isMoney = r => (r.evidence || []).some(e => e.sql && /revenue|profit/i.test(e.sql));

const byMid = arr => new Map(arr.map(r => [String(r.mid), r]));
const mapA = byMid(A.results), mapB = byMid(B.results);

const rows = [];
const agg = { better: 0, same: 0, worse: 0, review: 0 };
for (const [mid, a] of mapA) {
  const b = mapB.get(mid);
  if (!b) { rows.push({ mid, verdict: 'review', note: 'missing in post run' }); agg.review++; continue; }

  const aReplied = a.outcome === 'replied', bReplied = b.outcome === 'replied';
  const aCaveat = CAVEAT_RE.test(a.reply || ''), bCaveat = CAVEAT_RE.test(b.reply || '');
  const gated = GATED.has(mid);

  let verdict, note = '';
  if (!bReplied && aReplied) { verdict = 'worse'; note = `post ${b.outcome}: ${String(b.error || '').slice(0, 60)}`; }
  else if (!aReplied && bReplied) { verdict = 'better'; note = 'base failed, post replied'; }
  else if (gated) {
    const bRefusedHonestly = REFUSE_RE.test(b.reply || '');
    const bBurnedSql = hasSql(b);
    if (bRefusedHonestly && !bBurnedSql) { verdict = 'better'; note = 'deterministic refusal, no SQL burned'; }
    else if (bRefusedHonestly) { verdict = 'same'; note = 'refused (SQL still attempted)'; }
    else { verdict = 'review'; note = 'gated question did not read as a refusal'; }
  }
  else if (isMoney(b) && !bCaveat && aCaveat) { verdict = 'worse'; note = 'caveat lost'; }
  else if (isMoney(b) && bCaveat && !aCaveat) { verdict = 'better'; note = 'caveat gained'; }
  else verdict = 'same';

  agg[verdict]++;
  rows.push({
    mid, q: String(a.question).replace(/\s+/g, ' ').slice(0, 70),
    base: `${a.outcome} ${Math.round(a.latencyMs / 1000)}s${aCaveat ? ' ✓cav' : ''}`,
    post: `${b.outcome} ${Math.round(b.latencyMs / 1000)}s${bCaveat ? ' ✓cav' : ''}`,
    verdict, note,
  });
}

// Aggregates
const stat = arr => {
  const lat = arr.map(r => r.latencyMs).sort((x, y) => x - y);
  const money = arr.filter(isMoney);
  return {
    replied: arr.filter(r => r.outcome === 'replied').length,
    medianLat: Math.round(lat[Math.floor(lat.length / 2)] / 1000),
    p90Lat: Math.round(lat[Math.floor(lat.length * 0.9)] / 1000),
    moneyN: money.length,
    moneyCaveat: money.filter(r => CAVEAT_RE.test(r.reply || '')).length,
    moneyDThrough: money.filter(r => DTHROUGH_RE.test(r.reply || '')).length,
  };
};
const sA = stat(A.results), sB = stat(B.results);

const md = [];
md.push(`# Customer-replay comparison — ${A.meta.tag} → ${B.meta.tag}`);
md.push(`\nGenerated ${new Date().toISOString()} · data through ${A.meta.dataState.find(s => s.recordType === 'sales')?.maxDate} (identical in both runs${force ? ' — FORCED' : ''})\n`);
md.push(`## Scoreboard\n`);
md.push(`| metric | ${A.meta.tag} | ${B.meta.tag} |`);
md.push(`|---|---|---|`);
md.push(`| replied | ${sA.replied}/${A.results.length} | ${sB.replied}/${B.results.length} |`);
md.push(`| median latency | ${sA.medianLat}s | ${sB.medianLat}s |`);
md.push(`| p90 latency | ${sA.p90Lat}s | ${sB.p90Lat}s |`);
md.push(`| money answers with basis caveat | ${sA.moneyCaveat}/${sA.moneyN} | ${sB.moneyCaveat}/${sB.moneyN} |`);
md.push(`| money answers naming data-through | ${sA.moneyDThrough}/${sA.moneyN} | ${sB.moneyDThrough}/${sB.moneyN} |`);
md.push(`\n**Verdicts:** better ${agg.better} · same ${agg.same} · worse ${agg.worse} · review ${agg.review}\n`);
md.push(`## Per-question\n`);
md.push(`| mid | question | ${A.meta.tag} | ${B.meta.tag} | verdict | note |`);
md.push(`|---|---|---|---|---|---|`);
for (const r of rows) md.push(`| ${r.mid} | ${r.q} | ${r.base || ''} | ${r.post || ''} | ${r.verdict} | ${r.note} |`);

const out = path.join(path.dirname(postFile), 'COMPARISON.md');
fs.writeFileSync(out, md.join('\n'));
console.log(`Verdicts: better ${agg.better} · same ${agg.same} · worse ${agg.worse} · review ${agg.review}`);
console.log(`Money caveat: ${sA.moneyCaveat}/${sA.moneyN} → ${sB.moneyCaveat}/${sB.moneyN} · data-through: ${sA.moneyDThrough}/${sA.moneyN} → ${sB.moneyDThrough}/${sB.moneyN}`);
console.log(`→ ${out}`);
const worse = rows.filter(r => r.verdict === 'worse');
if (worse.length) { console.log('\nWORSE:'); for (const w of worse) console.log(`  ${w.mid} ${w.q} — ${w.note}`); }
const review = rows.filter(r => r.verdict === 'review');
if (review.length) { console.log('\nREVIEW:'); for (const w of review) console.log(`  ${w.mid} ${w.q} — ${w.note}`); }
