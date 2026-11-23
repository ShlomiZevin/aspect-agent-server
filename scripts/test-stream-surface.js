#!/usr/bin/env node
/**
 * Battery for #1011 — what a turn's runtime stream carries per surface
 * (builder/runtime/streamSurface.js). Fully OFFLINE: no database, no model,
 * no network.
 *
 *   node scripts/test-stream-surface.js
 *
 *   A. No surface / unknown surface → the SAME emit function (byte-identical
 *      stream for the Builder, /live, the embed, simulations).
 *   B. 'go' → every event the customer chat uses keeps exactly the fields it
 *      reads; prompts, raw / parsed outputs, KB text, panels never pass.
 *   C. The runtime POST wires its emit through emitterFor (one filter point).
 *   D. The /go client sends `surface: 'go'`; /live and the Builder don't.
 */

const fs = require('fs');
const path = require('path');
const { emitterFor, filterEvent, surfaceOf, SURFACES } = require('../builder/runtime/streamSurface');

let fails = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
}
function section(t) { console.log(`\n── ${t} ──`); }

const BIG = 'x'.repeat(50000);
// One of every event the runtime emits, with every field it carries today.
const EVENTS = [
  ['conversation', { conversationId: 7, messageId: 11, currentCrewId: 'crew_a' }],
  ['protection.blocked', { conversationId: 7, blockId: 3, detectors: ['id_number'], message: 'Stopped' }],
  ['addon.start', { instanceId: 'i1', pluginId: 'fieldExtractor', lane: 'blocking', label: 'Income', model: { modelId: 'm' }, modelLabel: 'M' }],
  ['addon.skipped', { instanceId: 'i1', reason: 'filter', detail: BIG }],
  ['enum.resolved', { instanceId: 'i1', enumName: 'e', section: null, count: 2, text: BIG }],
  ['dc.resolved', { instanceId: 'i1', fieldName: 'f', section: null, matched: 'a', text: BIG }],
  ['addon.prompt', { instanceId: 'i1', prompt: BIG, historyCount: 3, historyMode: { mode: 'all' } }],
  ['addon.token', { instanceId: 'i2', token: 'Hel' }],
  ['addon.websearch', { instanceId: 'i2', id: 'w1', status: 'done', query: 'rates', kind: 'search', sources: [{ url: 'https://a.example', title: BIG }] }],
  ['addon.output', {
    instanceId: 'i3', label: 'Router', modelLabel: 'M', prompt: BIG, rawOutput: BIG, parsedOutput: { big: BIG },
    memoryWrites: [{ field: 'f', value: BIG }], tokens: { input: 1, output: 2, total: 3 }, durationMs: 9,
    historyMode: { mode: 'all' }, historyCount: 3, targetedKb: [{ text: BIG }], guardrail: { why: BIG },
    transition: { to: 'crew_b', reason: 'income known' }, lane: 'blocking',
  }],
  ['addon.error', { instanceId: 'i4', error: { code: 'empty_output', message: 'No answer', detail: BIG }, label: 'X', modelLabel: 'M', rawOutput: BIG, durationMs: 4 }],
  ['addon.error', { instanceId: null, error: { code: 'runtime_failed', message: 'Something went wrong' } }],
  ['warning', { code: 'transition_cascade_limit', message: BIG }],
  ['assistant.message', { messageId: 12, text: 'Hello there' }],
  ['turn.stopped', {}],
  ['brain.panel', { panelId: 'p1', index: 0, panel: { body: BIG } }],
  ['profiler.panel', { panelId: 'p2', index: 0, panel: { body: BIG } }],
  ['done', { totalMs: 0, outcome: 'sent' }],
];

section('A. no surface → the stream is untouched');
{
  const emit = () => {};
  check('undefined surface returns the same emit', emitterFor(undefined, emit) === emit);
  check('null surface returns the same emit', emitterFor(null, emit) === emit);
  check("'live' (not a filtered surface) returns the same emit", emitterFor('live', emit) === emit);
  check("'builder' returns the same emit", emitterFor('builder', emit) === emit);
  check('an object / prototype key is not a surface', surfaceOf({}) === null && surfaceOf('toString') === null && surfaceOf('__proto__') === null);
}

section("B. 'go' → only what the customer chat reads");
{
  const sent = [];
  const emit = emitterFor('go', (type, payload) => sent.push({ type, payload }));
  for (const [t, p] of EVENTS) emit(t, p);
  const types = sent.map(s => s.type);
  for (const t of ['addon.prompt', 'addon.skipped', 'enum.resolved', 'dc.resolved', 'warning', 'brain.panel', 'profiler.panel']) {
    check(`${t} is not sent`, !types.includes(t));
  }
  const of = t => sent.filter(s => s.type === t).map(s => s.payload);
  const json = JSON.stringify(sent);
  check('no prompt / rawOutput / parsedOutput anywhere', !/"prompt"|"rawOutput"|"parsedOutput"/.test(json));
  check('no large text passes at all', !json.includes('xxxxxxxxxx'), `${json.length} chars`);
  check('conversation intact', JSON.stringify(of('conversation')[0]) === JSON.stringify(EVENTS[0][1]));
  check('protection.blocked intact', JSON.stringify(of('protection.blocked')[0]) === JSON.stringify(EVENTS[1][1]));
  check('addon.start → instanceId + pluginId + label', JSON.stringify(of('addon.start')[0]) === JSON.stringify({ instanceId: 'i1', pluginId: 'fieldExtractor', label: 'Income' }));
  check('addon.token intact', JSON.stringify(of('addon.token')[0]) === JSON.stringify({ instanceId: 'i2', token: 'Hel' }));
  check('addon.websearch → the pill (no sources)', JSON.stringify(of('addon.websearch')[0]) === JSON.stringify({ instanceId: 'i2', id: 'w1', status: 'done', query: 'rates', kind: 'search' }));
  check('addon.output → instanceId + label + transition', JSON.stringify(of('addon.output')[0]) === JSON.stringify({ instanceId: 'i3', label: 'Router', transition: { to: 'crew_b', reason: 'income known' } }));
  check('addon.output without a transition → instanceId + label', JSON.stringify(filterEvent('go', 'addon.output', { instanceId: 'i9', label: 'L', rawOutput: BIG })) === JSON.stringify({ instanceId: 'i9', label: 'L' }));
  const errs = of('addon.error');
  check('addon.error (add-on) → instanceId + code/message only', JSON.stringify(errs[0]) === JSON.stringify({ instanceId: 'i4', error: { code: 'empty_output', message: 'No answer' } }));
  check('addon.error (fatal, instanceId null) intact', JSON.stringify(errs[1]) === JSON.stringify(EVENTS[11][1]));
  check('assistant.message intact', JSON.stringify(of('assistant.message')[0]) === JSON.stringify({ messageId: 12, text: 'Hello there' }));
  check('turn.stopped sent', types.includes('turn.stopped'));
  check('done intact', JSON.stringify(of('done')[0]) === JSON.stringify({ totalMs: 0, outcome: 'sent' }));
  check('an unknown new event type is not sent', filterEvent('go', 'addon.something_new', { a: 1 }) === null);
  check('the input payload is not mutated', EVENTS[9][1].rawOutput === BIG && EVENTS[9][1].prompt === BIG);
  check('go whitelist covers exactly the events useLiveChat handles',
    Object.keys(SURFACES.go).sort().join() === ['addon.error', 'addon.output', 'addon.start', 'addon.token', 'addon.websearch', 'assistant.message', 'conversation', 'done', 'protection.blocked', 'turn.stopped'].sort().join());
}

section('C. one filter point in the runtime POST');
{
  const src = fs.readFileSync(path.join(__dirname, '../builder/routes/runtimeRoute.js'), 'utf8');
  const start = src.indexOf("router.post('/:slug/conversations/:convId/messages'");
  const body = src.slice(start);
  check('the messages POST builds emit through streamSurface.emitterFor(req.body.surface, …)',
    /const emit = streamSurface\.emitterFor\(req\.body && req\.body\.surface,/.test(body));
  check('it writes the SSE frame nowhere else', (body.match(/res\.write\(`data:/g) || []).length === 1);
}

section('D. the client asks for it only on /go');
{
  const client = path.join(__dirname, '../../aspect-react-client/src');
  if (!fs.existsSync(client)) {
    console.log('SKIP  client folder not next to the server');
  } else {
    const page = fs.readFileSync(path.join(client, 'live-chat/LiveChatPage.tsx'), 'utf8');
    const hook = fs.readFileSync(path.join(client, 'live-chat/useLiveChat.ts'), 'utf8');
    const api = fs.readFileSync(path.join(client, 'builder/state/builderApi.ts'), 'utf8');
    const userChat = fs.readFileSync(path.join(client, 'builder/components/ChatPanel/UserChat.tsx'), 'utf8');
    check("LiveChatPage passes surface 'go' only when restricted", /surface: restricted \? 'go' : undefined/.test(page));
    check('useLiveChat forwards it to sendRuntimeMessage', /sendRuntimeMessage\(\{[\s\S]*?\bsurface,[\s\S]*?\}\)/.test(hook));
    check('the request body carries it only when set', /\.\.\.\(args\.surface \? \{ surface: args\.surface \} : \{\}\)/.test(api));
    check('the Builder chat never sends a surface', !/surface/.test(userChat.slice(userChat.indexOf('sendRuntimeMessage({'), userChat.indexOf('sendRuntimeMessage({') + 1500)));
  }
}

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
