#!/usr/bin/env node
/**
 * Error center (task #903) — offline battery. No database, no model.
 *
 *   node scripts/test-error-center.js
 *
 * Checks: secrets are scrubbed, repeats share a fingerprint while
 * different problems don't, the kind guess, and the one rule — record()
 * never throws and never waits the caller, even with no database at all.
 */

const errorCenter = require('../builder/services/errorCenter');
const { scrub, normalise, fingerprintOf } = errorCenter._internal;

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('\nScrubbing');
const dirty = 'call failed key=sk-ant-api03-abcdefghijklmnop Bearer eyJhbGciOi.xyz AIzaSyA1234567890abcdefghijk postgres://app:hunter2@10.0.0.1/db password: s3cret';
const clean = scrub(dirty);
check('OpenAI / Anthropic key removed', !/sk-ant-api03-abcdef/.test(clean), clean);
check('Bearer token removed', !/eyJhbGciOi/.test(clean), clean);
check('Gemini key removed', !/AIzaSyA1234567890/.test(clean), clean);
check('database password removed', !/hunter2/.test(clean), clean);
check('password value removed', !/s3cret/.test(clean), clean);
check('the readable part stays', /call failed/.test(clean));

console.log('\nGrouping');
const fp = m => fingerprintOf({ area: 'turn', kind: 'code', code: 'runtime_failed', message: m });
check('same problem, different conversation number → one group',
  fp('Conversation 1812 not found') === fp('Conversation 1907 not found'));
check('same problem, different crew id → one group',
  fp('No crew crew_x8k2abcd on agent') === fp('No crew crew_99zzqqpp on agent'));
check('different problem → different group',
  fp('Agent has no defaultCrewId; nothing to run') !== fp('Agent version row missing'));
check('same message, different area → different group',
  fp('boom') !== fingerprintOf({ area: 'addon', kind: 'code', code: 'runtime_failed', message: 'boom' }));
check('normalise blanks numbers', normalise('took 4312 ms') === 'took # ms');

console.log('\nKind');
const kindOf = (msg, extra = {}) => errorCenter.classify(Object.assign(new Error(msg), extra));
check('429 → model_rate_limit', kindOf('Too Many Requests', { status: 429 }) === 'model_rate_limit');
check('rate limit text → model_rate_limit', kindOf('Rate limit reached for gpt-5') === 'model_rate_limit');
check('timeout → model_timeout', kindOf('Request timed out') === 'model_timeout');
check('statement timeout (57014) → database', kindOf('canceling statement due to statement timeout', { code: '57014' }) === 'database');
check('missing relation → database', kindOf('relation "foo" does not exist') === 'database');
check('overloaded → model_other', kindOf('Overloaded', { status: 529 }) === 'model_other');
check('refusal → model_refusal', kindOf('The model refused to answer (content policy)') === 'model_refusal');
check('DNS failure → external', kindOf('getaddrinfo ENOTFOUND api.example.com', { code: 'ENOTFOUND' }) === 'external');
check('anything else → code', kindOf('Agent has no defaultCrewId; nothing to run') === 'code');
check('a bare string does not crash', errorCenter.classify('just text') === 'code');
check('null does not crash', errorCenter.classify(null) === 'code');

console.log('\nLoad-test turns (task #902) — timing summary and the kind of a failed turn');
const { timingSummary, turnErrorKind } = require('../builder/services/simulationJobs')._internal;
const sum = timingSummary([{ ok: true, ms: 3000 }, { ok: true, ms: 1000 }, { ok: false, ms: 9 }, { ok: true, ms: 2000 }, { ok: true, ms: 8000 }]);
check('median of the answered turns (failed turn left out)', sum && sum.medianMs === 2500 && sum.turns === 4, JSON.stringify(sum));
check('slowest turn', sum && sum.maxMs === 8000 && sum.p95Ms === 8000);
check('no answered turn → no summary', timingSummary([{ ok: false, ms: 5 }]) === null);
const mk = (m, x) => Object.assign(new Error(m), x);
check("the agent's own failure is classified by its words", turnErrorKind(mk('turn failed', { status: 502, turnFailure: 'Rate limit reached for gpt-5' })) === 'model_rate_limit');
check('front door 429 → server_unavailable, not a model limit', turnErrorKind(mk('x', { upstreamStatus: 429 })) === 'server_unavailable');
check('front door 503 → server_unavailable', turnErrorKind(mk('x', { upstreamStatus: 503 })) === 'server_unavailable');
check('turn timeout → model_timeout', turnErrorKind(mk('The operation was aborted due to timeout', { name: 'TimeoutError' })) === 'model_timeout');
check('broken setup → code', turnErrorKind(mk('x', { turnFailure: 'Agent has no defaultCrewId; nothing to run' })) === 'code');

console.log('\nAlerts — which errors email (errorRules + errorAlerts)');
const { isAlertable } = require('../builder/services/errorAlerts');
check('our-code error in a customer conversation alerts', isAlertable({ kind: 'code', source: 'customer', area: 'turn', conversationId: 5 }));
check('…the same in the Builder test chat does not', !isAlertable({ kind: 'code', source: 'builder', area: 'turn', conversationId: 5 }));
check('…nor in a simulation (load tests make errors on purpose)', !isAlertable({ kind: 'code', source: 'simulation', area: 'turn', conversationId: 5 }));
check('a rate limit never alerts (it is retried)', !isAlertable({ kind: 'model_rate_limit', source: 'customer', area: 'model', conversationId: 5 }));
check('a server crash alerts', isAlertable({ kind: 'code', source: null, area: 'server', conversationId: null }));

const runAsync = async () => {
  console.log('\nHandling rule: retry a rate limit (services/llm.js)');
  const errorRules = require('../builder/services/errorRules');
  errorRules.RULES.model_rate_limit.retry.waitMs = [5, 5]; // keep the battery fast
  const llm = require('../services/llm');
  const provider = llm._getProviderForModel('gpt-4o-mini', null);
  const realOneShot = provider.sendOneShot;
  const realStream = provider.sendMessageStreamWithPrompt;
  const rateLimit = () => Object.assign(new Error('429 Rate limit reached'), { status: 429 });
  const silence = console.warn; console.warn = () => {};
  try {
    let calls = 0;
    provider.sendOneShot = async () => { calls++; if (calls <= 2) throw rateLimit(); return { text: 'ok' }; };
    const out = await llm.sendOneShot('sys', 'hi', { model: 'gpt-4o-mini', context: 'battery' });
    check('one-shot: two rate limits, then an answer → the answer, after 3 tries', out === 'ok' && calls === 3, `calls=${calls}`);

    calls = 0;
    provider.sendOneShot = async () => { calls++; throw rateLimit(); };
    let threw = null;
    try { await llm.sendOneShot('sys', 'hi', { model: 'gpt-4o-mini', context: 'battery' }); } catch (e) { threw = e; }
    check('one-shot: still limited after the retries → the original error, 3 tries in all', threw && threw.status === 429 && calls === 3, `calls=${calls}`);

    calls = 0;
    provider.sendOneShot = async () => { calls++; throw Object.assign(new Error('Something else'), { status: 400 }); };
    threw = null;
    try { await llm.sendOneShot('sys', 'hi', { model: 'gpt-4o-mini', context: 'battery' }); } catch (e) { threw = e; }
    check('one-shot: any other error is not retried', threw && calls === 1, `calls=${calls}`);

    calls = 0;
    provider.sendMessageStreamWithPrompt = async function* () { calls++; if (calls === 1) throw rateLimit(); yield 'a'; yield 'b'; };
    const got = [];
    for await (const c of llm.sendMessageStreamWithPrompt('hi', 1, { model: 'gpt-4o-mini' })) got.push(c);
    check('stream: rate limit before anything was sent → retried, reply arrives once', got.join('') === 'ab' && calls === 2, `${got.join('')} calls=${calls}`);

    calls = 0;
    provider.sendMessageStreamWithPrompt = async function* () { calls++; yield 'a'; throw rateLimit(); };
    const got2 = [];
    threw = null;
    try { for await (const c of llm.sendMessageStreamWithPrompt('hi', 1, { model: 'gpt-4o-mini' })) got2.push(c); } catch (e) { threw = e; }
    check('stream: rate limit after text was sent → NOT retried (never send a reply twice)', threw && calls === 1 && got2.join('') === 'a', `calls=${calls}`);
  } finally {
    provider.sendOneShot = realOneShot;
    provider.sendMessageStreamWithPrompt = realStream;
    console.warn = silence;
  }

  console.log('\nContext — a model error inside an add-on knows where it was, and is counted once');
  const seen = [];
  await errorCenter.withContext({ agentSlug: 'a1', conversationId: 7, detail: { addon: { instanceId: 'x1' } } }, async () => {
    const e = new Error('boom');
    const ctx = errorCenter.currentContext();
    seen.push(ctx.agentSlug === 'a1' && ctx.conversationId === 7 && ctx.detail.addon.instanceId === 'x1');
    check('wasRecorded is false before record()', !errorCenter.wasRecorded(e));
    errorCenter.record(e, { area: 'model' });
    check('…and true after, so the add-on and turn hooks skip it', errorCenter.wasRecorded(e));
  });
  check('the context carries agent, conversation and add-on', seen[0] === true);
  check('outside withContext there is no context', Object.keys(errorCenter.currentContext()).length === 0);
};

console.log('\nThe one rule — recording never breaks the caller');
(async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  let threw = false;
  let returned;
  const t0 = Date.now();
  try {
    // No database initialised in this process: the write must fail quietly.
    returned = errorCenter.record(new Error('boom'), { area: 'turn', code: 'runtime_failed', agentSlug: 'x', conversationId: 1 });
    errorCenter.record(null, {});
    errorCenter.record('a string', undefined);
  } catch {
    threw = true;
  }
  const took = Date.now() - t0;
  check('record() does not throw', !threw);
  check('record() returns at once (nothing to await)', returned === undefined && took < 20, `${took} ms`);
  await new Promise(r => setTimeout(r, 50));
  console.warn = originalWarn;
  check('a failed write is only a warning in the log', warnings.length >= 1 && warnings.every(w => w.includes('[error-center]')), warnings.join(' | '));

  // The router / context checks record too; their DB-less write warnings are expected noise.
  console.warn = () => {};
  await runAsync();
  await new Promise(r => setTimeout(r, 50));
  console.warn = originalWarn;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
