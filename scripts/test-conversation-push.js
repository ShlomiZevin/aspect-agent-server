/**
 * test-conversation-push.js — does a proactive message actually reach an
 * open chat that is connected somewhere else? (Builder V2 Triggers, T4.)
 *
 * See docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * The whole point of doing this through Postgres LISTEN/NOTIFY rather
 * than an in-memory Set is that Cloud Run runs 1–3 copies of the server:
 * the customer's chat is connected to one, the trigger may fire on
 * another. An in-memory channel passes every local test and then drops
 * most pushes in production, which is exactly the kind of bug that only
 * shows up as "proactive doesn't work sometimes".
 *
 * So the assertion that matters here is the cross-process one: a NOTIFY
 * issued by a SEPARATE node process must reach a subscriber in this one.
 *
 * Safe by default — it only sends notifications on a Postgres channel
 * and writes nothing.
 *
 * Usage:  node scripts/test-conversation-push.js
 * Writes: verification/conversation-push/results.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('../services/db.pg');
const push = require('../services/conversation-push.service');

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Wait for a subscriber callback, or give up. */
function waitFor(ms) {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const timer = setTimeout(() => resolve(null), ms);
  return { promise, hit: (v) => { clearTimeout(timer); resolve(v); } };
}

/** Fire a NOTIFY from a genuinely separate node process. */
function notifyFromAnotherProcess(conversationId, payload) {
  const code = `
    require('dotenv').config();
    const db = require('${path.join(__dirname, '..', 'services', 'db.pg').replace(/\\/g, '\\\\')}');
    const push = require('${path.join(__dirname, '..', 'services', 'conversation-push.service').replace(/\\/g, '\\\\')}');
    (async () => {
      await db.initialize();
      await push.push(${Number(conversationId)}, ${JSON.stringify(payload)});
      process.exit(0);
    })().catch(e => { console.error(e.message); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..') },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

async function main() {
  await db.initialize();
  console.log('\nConversation push battery\n');

  const CONV_A = 999000001;   // ids that cannot collide with real rows
  const CONV_B = 999000002;

  console.log('[1] subscribing');
  const gotA = waitFor(6000);
  const unsubA = await push.subscribe(CONV_A, p => gotA.hit(p));
  check('a subscriber opens a LISTEN connection', push.stats().listening,
    JSON.stringify(push.stats()));

  console.log('\n[2] cross-process delivery — the reason this exists');
  await notifyFromAnotherProcess(CONV_A, { type: 'proactive.message', messageId: 4242 });
  const received = await gotA.promise;
  check('a NOTIFY from a SEPARATE process reaches this subscriber', !!received,
    received ? `got messageId=${received.messageId}` : 'TIMED OUT — an in-memory channel would fail exactly here');
  check('the payload survives the round trip',
    received?.conversationId === CONV_A && received?.messageId === 4242,
    JSON.stringify(received));

  console.log('\n[3] routing — one conversation never hears another\'s push');
  const gotB = waitFor(1500);
  const wrongA = waitFor(1500);
  const unsubB = await push.subscribe(CONV_B, p => gotB.hit(p));
  const unsubA2 = await push.subscribe(CONV_A, p => wrongA.hit(p));
  await push.push(CONV_B, { type: 'proactive.message', messageId: 7 });
  const bGot = await gotB.promise;
  const aGot = await wrongA.promise;
  check('the intended conversation receives it', bGot?.messageId === 7, JSON.stringify(bGot));
  check('the other conversation does NOT', aGot === null,
    aGot ? `LEAKED: ${JSON.stringify(aGot)}` : 'clean');
  unsubB(); unsubA2();

  console.log('\n[4] unsubscribing actually stops delivery');
  unsubA();
  const afterUnsub = waitFor(1200);
  const unsubProbe = await push.subscribe(CONV_B, () => {});
  await push.push(CONV_A, { type: 'proactive.message', messageId: 99 });
  const late = await afterUnsub.promise;
  check('an unsubscribed chat receives nothing', late === null,
    late ? 'still receiving after unsubscribe — this would leak connections' : 'clean');
  unsubProbe();
  check('the registry is empty once everyone leaves', push.stats().subscribers === 0,
    JSON.stringify(push.stats()));

  console.log('\n[5] a push can never break the caller');
  // The message is already saved by the time push runs, so a failure
  // here must cost a refresh and never an exception up the stack.
  let threw = false;
  try {
    await push.push(CONV_A, { type: 'x', huge: 'y'.repeat(100) });
  } catch { threw = true; }
  check('push resolves rather than throwing', !threw);

  const outDir = path.join(__dirname, '..', 'verification', 'conversation-push');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
    ranAt: new Date().toISOString(),
    passed: results.length - failures,
    failed: failures,
    checks: results,
  }, null, 2));

  console.log(`\n════════ ${results.length - failures}/${results.length} PASS ════════`);
  console.log('Written to verification/conversation-push/results.json');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nBattery failed to run:', err.message);
  console.error(err);
  process.exit(1);
});
