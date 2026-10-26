// Compare two runs of replay-drive: what the customer saw + what was stored.
// Main-lane events must match IN ORDER; offline/parallel events as a set (they
// finish in whatever order the models answer). Token counts ignored (a replay has none).
const [a, b] = process.argv.slice(2).map(f => require(require('path').resolve(f)));
const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'tokens' ? undefined : v)));
// Per add-on: its own events in order (several add-ons can run in parallel, in
// either lane, so their events interleave differently run to run). Turn-level
// events (no instanceId: conversation, assistant.message, done, …) in order.
function split(evs) {
  const per = {}, turn = [];
  for (const e of strip(evs)) {
    if (e.instanceId) (per[e.instanceId] = per[e.instanceId] || []).push(e);
    else turn.push(e);
  }
  const sorted = {};
  for (const k of Object.keys(per).sort()) sorted[k] = per[k];
  return { main: turn, rest: sorted };
}
let diffs = 0;
function walk(x, y, p) {
  if (JSON.stringify(x) === JSON.stringify(y)) return;
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${p}.${k}`);
    return;
  }
  diffs++;
  if (diffs <= 15) console.log(`DIFF ${p}\n   A: ${JSON.stringify(x)?.slice(0, 200)}\n   B: ${JSON.stringify(y)?.slice(0, 200)}`);
}
const sortRuns = rs => strip(rs).map(r => JSON.stringify(r)).sort();
a.conversations.forEach((ca, i) => {
  const cb = b.conversations[i];
  ca.turns.forEach((t, j) => {
    const x = split(t.events), y = split(cb.turns[j].events);
    walk(x.main, y.main, `c${ca.source}.t${j}.turn`);
    walk(x.rest, y.rest, `c${ca.source}.t${j}.addon`);
    walk(t.tokens, cb.turns[j].tokens, `c${ca.source}.t${j}.reply`);
  });
  walk(ca.db.messages, cb.db.messages, `c${ca.source}.messages`);
  walk(strip(ca.db.memory), strip(cb.db.memory), `c${ca.source}.memory`);
  walk(strip(ca.db.conversation), strip(cb.db.conversation), `c${ca.source}.conversation`);
  walk(sortRuns(ca.db.addonRuns), sortRuns(cb.db.addonRuns), `c${ca.source}.addonRuns`);
});
const turns = a.conversations.reduce((n, c) => n + c.turns.length, 0);
console.log(diffs ? `${diffs} differences over ${turns} turns` : `IDENTICAL over ${turns} turns — events, replies, messages, memory, conversation, add-on trail`);
