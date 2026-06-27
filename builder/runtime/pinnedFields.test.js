/**
 * pinnedFields tests — runnable with plain Node:
 *   node aspect-agent-server/builder/runtime/pinnedFields.test.js
 *
 * No external test framework dependency (the server repo doesn't ship
 * one). Each `expect`-style helper logs PASS / FAIL and the script
 * exits non-zero on any failure so it can be wired into CI later.
 *
 * Why this file exists: the pinned-field seed is the only piece of
 * the Targeted-KB feature that touches the live runtime. Getting it
 * wrong silently corrupts conversation memory — worth a guard.
 */

const assert = require('node:assert/strict');
const builderMemory = require('./builderMemory');
const { seedPinnedFields } = require('./pinnedFields');

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

function emptyMemory() {
  return { memory: {}, thinking: {}, summary: {}, retrieval: {}, runCounts: {} };
}

function runnable({ agentFields = [], crewFields = [] } = {}) {
  return {
    agent: { body: { fields: agentFields } },
    crew:  { body: { fields: crewFields } },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('seedPinnedFields — happy path', () => {
  it('seeds defaultValue into memory for a pinned enum field with empty slot', () => {
    const memory = emptyMemory();
    const r = runnable({
      agentFields: [
        { id: 'f1', name: 'cards', type: 'enum', source: 'pinned', defaultValue: 'poalim' },
      ],
    });
    const seeded = seedPinnedFields(memory, r);
    assert.equal(seeded, 1);
    assert.equal(builderMemory.findFieldValue(memory, 'cards', 'memory'), 'poalim');
  });

  it('respects a non-null domain when writing the seeded value', () => {
    const memory = emptyMemory();
    const r = runnable({
      agentFields: [
        { id: 'f1', name: 'cards', type: 'enum', source: 'pinned', defaultValue: 'poalim', domain: 'org' },
      ],
    });
    seedPinnedFields(memory, r);
    assert.deepEqual(memory.memory.org, { cards: 'poalim' });
  });

  it('falls back to _general bucket when domain is missing', () => {
    const memory = emptyMemory();
    const r = runnable({
      agentFields: [
        { id: 'f1', name: 'cards', type: 'enum', source: 'pinned', defaultValue: 'poalim' },
      ],
    });
    seedPinnedFields(memory, r);
    // builderMemory normalises null domain to '_general' on apply.
    assert.ok(memory.memory._general && memory.memory._general.cards === 'poalim');
  });
});

describe('seedPinnedFields — preservation', () => {
  it('does NOT overwrite an existing non-empty memory value', () => {
    const memory = emptyMemory();
    builderMemory.applyWrites(memory, [
      { kind: 'memory', domain: 'org', field: 'cards', value: 'discount' },
    ]);
    const r = runnable({
      agentFields: [
        { id: 'f1', name: 'cards', type: 'enum', source: 'pinned', defaultValue: 'poalim', domain: 'org' },
      ],
    });
    const seeded = seedPinnedFields(memory, r);
    assert.equal(seeded, 0);
    assert.equal(memory.memory.org.cards, 'discount');
  });

  it('seeds when an existing value is null (treats null as empty)', () => {
    const memory = emptyMemory();
    memory.memory.org = { cards: null };
    const r = runnable({
      agentFields: [
        { id: 'f1', name: 'cards', type: 'enum', source: 'pinned', defaultValue: 'poalim', domain: 'org' },
      ],
    });
    const seeded = seedPinnedFields(memory, r);
    assert.equal(seeded, 1);
    assert.equal(memory.memory.org.cards, 'poalim');
  });
});

describe('seedPinnedFields — skip cases', () => {
  it('skips non-pinned fields', () => {
    const memory = emptyMemory();
    const r = runnable({
      agentFields: [
        { id: 'f1', name: 'foo', type: 'string', source: 'explicit', defaultValue: 'bar' },
        { id: 'f2', name: 'qux', type: 'enum',   source: 'inferred', defaultValue: 'a' },
      ],
    });
    const seeded = seedPinnedFields(memory, r);
    assert.equal(seeded, 0);
    assert.deepEqual(memory.memory, {});
  });

  it('skips pinned fields without a defaultValue', () => {
    const memory = emptyMemory();
    const r = runnable({
      agentFields: [
        { id: 'f1', name: 'cards', type: 'enum', source: 'pinned' },
      ],
    });
    const seeded = seedPinnedFields(memory, r);
    assert.equal(seeded, 0);
  });

  it('skips pinned non-enum fields (defensive — non-enum pins are nonsensical)', () => {
    const memory = emptyMemory();
    const r = runnable({
      agentFields: [
        { id: 'f1', name: 'foo', type: 'string', source: 'pinned', defaultValue: 'bar' },
      ],
    });
    const seeded = seedPinnedFields(memory, r);
    assert.equal(seeded, 0);
  });

  it('returns 0 on a null memory / null runnable without throwing', () => {
    assert.equal(seedPinnedFields(null, runnable()), 0);
    assert.equal(seedPinnedFields(emptyMemory(), null), 0);
  });
});

describe('seedPinnedFields — multiple + crew scope', () => {
  it('seeds every pinned field across agent + crew scope in one call', () => {
    const memory = emptyMemory();
    const r = runnable({
      agentFields: [
        { id: 'a1', name: 'cards',   type: 'enum', source: 'pinned', defaultValue: 'poalim' },
        { id: 'a2', name: 'region',  type: 'enum', source: 'pinned', defaultValue: 'emea',  domain: 'org' },
      ],
      crewFields: [
        { id: 'c1', name: 'channel', type: 'enum', source: 'pinned', defaultValue: 'phone' },
      ],
    });
    const seeded = seedPinnedFields(memory, r);
    assert.equal(seeded, 3);
    assert.equal(builderMemory.findFieldValue(memory, 'cards',   'memory'), 'poalim');
    assert.equal(builderMemory.findFieldValue(memory, 'region',  'memory'), 'emea');
    assert.equal(builderMemory.findFieldValue(memory, 'channel', 'memory'), 'phone');
  });

  it('is idempotent — running twice produces no extra writes', () => {
    const memory = emptyMemory();
    const r = runnable({
      agentFields: [
        { id: 'a1', name: 'cards', type: 'enum', source: 'pinned', defaultValue: 'poalim' },
      ],
    });
    const first  = seedPinnedFields(memory, r);
    const second = seedPinnedFields(memory, r);
    assert.equal(first,  1);
    assert.equal(second, 0);
  });
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
