#!/usr/bin/env node
/**
 * Offline battery — agenda lines and their comments' anchors
 * (services/agendaLines.js). No database, no network.
 *
 *   node scripts/test-agenda-comments.js
 *
 * Proves a comment's line id (`<!-- line:… -->`) survives everything that
 * happens to an action-items topic: ticks, notes, text edits around it, lines
 * added before it — and that ticks / notes still find a line that carries an
 * id (callers address lines by their text WITHOUT the id).
 */
const assert = require('assert');
const {
  listAgendaItems,
  applyAgendaLineChange,
  stampAgendaLineKey,
  splitAnchor,
} = require('../services/agendaLines');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

const keys = list => { let i = 0; return () => list[i++]; };

const DESC = [
  'מקור: פגישה 19.11',
  '- [ ] first point',
  '  > החלטה (19.11): decided',
  '  - a detail',
  '- [ ] second point',
  '- [x] third point',
].join('\r\n');

console.log('agendaLines');

test('splitAnchor reads and strips the id', () => {
  assert.deepStrictEqual(splitAnchor('a point <!-- line:3fa9c1 -->'), { text: 'a point', key: '3fa9c1' });
  assert.deepStrictEqual(splitAnchor('a point'), { text: 'a point', key: null });
  assert.deepStrictEqual(splitAnchor('a <!--line:AB12-->  '), { text: 'a', key: 'ab12' });
});

test('stamp adds the id at the end of the right line, keeps CRLF', () => {
  const r = stampAgendaLineKey(DESC, { index: 1, text: 'second point' }, keys(['aaa111']));
  assert.strictEqual(r.key, 'aaa111');
  assert.strictEqual(r.text, 'second point');
  assert.ok(r.description.includes('- [ ] second point <!-- line:aaa111 -->\r\n'));
  assert.strictEqual(r.description.split('\r\n').length, DESC.split('\r\n').length);
});

test('stamp is idempotent: a line that has an id keeps it', () => {
  const once = stampAgendaLineKey(DESC, { index: 0, text: 'first point' }, keys(['k1k1k1']));
  const twice = stampAgendaLineKey(once.description, { index: 0, text: 'first point' }, keys(['zzzzzz']));
  assert.strictEqual(twice.key, 'k1k1k1');
  assert.strictEqual(twice.description, once.description);
});

test('stamp never reuses an id already in the topic', () => {
  const a = stampAgendaLineKey(DESC, { index: 0, text: 'first point' }, keys(['dup111']));
  const b = stampAgendaLineKey(a.description, { index: 1, text: 'second point' }, keys(['dup111', 'new222']));
  assert.strictEqual(b.key, 'new222');
});

test('stamp refuses a line that moved or changed (409)', () => {
  assert.throws(() => stampAgendaLineKey(DESC, { index: 1, text: 'no such line' }), e => e.status === 409);
});

test('tick and note still find a line that carries an id; the id stays', () => {
  const { description } = stampAgendaLineKey(DESC, { index: 0, text: 'first point' }, keys(['keep01']));
  const ticked = applyAgendaLineChange(description, { index: 0, text: 'first point', checked: true });
  assert.ok(ticked.includes('- [x] first point <!-- line:keep01 -->'));
  const noted = applyAgendaLineChange(ticked, { index: 0, text: 'first point', note: 'my note' });
  const items = listAgendaItems(noted);
  assert.strictEqual(items[0].key, 'keep01');
  assert.strictEqual(items[0].checked, true);
  assert.ok(noted.includes('  > הערה: my note'));
});

test('the id survives a text edit and lines added before it', () => {
  const { description } = stampAgendaLineKey(DESC, { index: 1, text: 'second point' }, keys(['move01']));
  const edited = description
    .replace('- [ ] second point', '- [ ] second point, reworded')
    .replace('- [ ] first point', '- [ ] new line on top\r\n- [ ] first point');
  const item = listAgendaItems(edited).find(it => it.key === 'move01');
  assert.ok(item, 'the id is still in the topic');
  assert.strictEqual(item.text, 'second point, reworded');
  assert.strictEqual(listAgendaItems(edited).findIndex(it => it.key === 'move01'), 2);
});

test('lines without an id behave exactly as before (text match, 409 on ambiguity)', () => {
  const dup = '- [ ] same\n- [ ] same';
  assert.throws(() => applyAgendaLineChange(dup, { index: 5, text: 'same', checked: true }), e => e.status === 409);
  const ok = applyAgendaLineChange(dup, { index: 1, text: 'same', checked: true });
  assert.strictEqual(ok, '- [ ] same\n- [x] same');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
