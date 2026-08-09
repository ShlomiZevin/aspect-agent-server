/**
 * Real pass/fail battery for the Aspect Intelligence "investigate" pipeline
 * (insights/services/investigation.service.js) — same philosophy as
 * scripts/test-zer4u-battery.js: "PASS" means the pipeline actually
 * completed and returned a well-formed insight, not merely "got an HTTP 200".
 *
 * Each investigation is a real 4-LLM-call pipeline (plan/query/synthesize/
 * verify) against the live dataset DB, so this is slow (30-100s+ per
 * prompt) — kept to a short, deliberately varied set rather than zer4u's
 * 30-question list. A DOWNGRADED result (DATA QUALITY tag, or VERIFY still
 * unsatisfied after its own retry) is NOT counted as a failure by itself —
 * that's the safety net correctly doing its job on genuinely ambiguous
 * data — it's printed as a [note] instead so it's visible without dragging
 * the pass rate down for working-as-intended caution.
 *
 * Every insight this script creates is deleted again at the end, under a
 * disposable per-run userId, so a battery run never leaves cruft in
 * anyone's real feed (see project memory: no test cruft in shared dev).
 *
 * Usage:
 *   API_BASE=https://aspect-agent-server-...run.app node scripts/test-insights-battery.js [datasetId]
 */

require('dotenv').config();
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const DATASET = process.argv[2] || 'hypertoy';
const USER_ID = `battery-${crypto.randomUUID()}`;

const PROMPTS = [
  'Main risks for the next 6 months',
  'Which stores will miss Q3 target',
  'Which product family has the steepest margin decline',
  'Which SKUs are tying up the most inventory value with the slowest sell-through',
  'What is the loyalty signup trend over the last several weeks',
  'Bundle opportunities hiding in baskets', // historically the slow/flaky one (basket-affinity self-join) — kept specifically to keep watching it
  '', // empty prompt = "Request a new insight" auto-propose path, a different code path than a typed prompt
];

async function investigate(prompt) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/insights/${DATASET}/investigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, prompt }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ms: Date.now() - t0, httpError: `HTTP ${res.status}: ${body.error || ''}` };
    return { ms: Date.now() - t0, insightId: body.insightIds?.[0] };
  } catch (e) {
    return { ms: Date.now() - t0, httpError: e.message };
  }
}

async function getDetail(insightId) {
  try {
    const res = await fetch(`${API_BASE}/api/insights/${DATASET}/${insightId}?userId=${USER_ID}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function cleanup(ids) {
  for (const id of ids) {
    await fetch(`${API_BASE}/api/insights/${DATASET}/${id}?userId=${USER_ID}`, { method: 'DELETE' }).catch(() => {});
  }
}

(async () => {
  console.log(`Insights battery: ${PROMPTS.length} prompt(s) -> ${API_BASE} (dataset: ${DATASET})\n`);
  const results = [];
  const createdIds = [];

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    const label = prompt || '(auto-propose)';
    const r = await investigate(prompt);

    let verdict = 'PASS', reason = '', note = '';
    if (r.httpError) {
      verdict = 'FAIL'; reason = r.httpError;
    } else if (!r.insightId) {
      verdict = 'FAIL'; reason = 'no insightId in response';
    } else {
      createdIds.push(r.insightId);
      const detail = await getDetail(r.insightId);
      if (!detail) {
        verdict = 'FAIL'; reason = 'detail fetch failed';
      } else if (!detail.headline || !detail.blocks?.length || !detail.chart) {
        verdict = 'FAIL'; reason = 'malformed insight (missing headline/blocks/chart)';
      } else {
        const bits = [`conf=${detail.confidence}`, detail.tag];
        if (detail.evidence?.verification?.verified === false) {
          bits.push(`VERIFY still unsatisfied: ${detail.evidence.verification.issues.join('; ')}`);
        }
        note = `  [${bits.join(' | ')}]`;
      }
    }

    results.push({ label, verdict, reason, ms: r.ms });
    console.log(`${String(i + 1).padStart(2)}. [${verdict}] ${String(r.ms || 0).padStart(6)}ms  ${label.slice(0, 56)}${reason ? '  :: ' + reason : ''}${note}`);
  }

  console.log(`\nCleaning up ${createdIds.length} battery-created insight(s)...`);
  await cleanup(createdIds);

  const fails = results.filter(r => r.verdict === 'FAIL');
  console.log(`\n════════ ${results.length - fails.length}/${results.length} PASS ════════`);
  if (fails.length) {
    console.log('FAILURES:');
    for (const f of fails) console.log(`  - ${f.label}\n      ${f.reason}`);
  }
  process.exit(fails.length ? 1 : 0);
})();
