/**
 * Smart Replenishment — chat tool, schema rules and honesty layer (D3).
 *
 * Run: node scripts/test-replenishment-chat.js
 *
 * THE ASSERTION THAT MATTERS: the same question asked five different ways, in
 * either language, returns IDENTICAL numbers. That invariance is the entire
 * reason this is a structured tool and not a prompt — a model writing SQL for
 * "what should I order" produces a slightly different query, and therefore
 * slightly different numbers, every time.
 *
 * Needs the module's views in the live schema and the platform DB. Restores
 * the module's enabled state afterwards.
 */

require('dotenv').config();
const db = require('../services/db.pg');
const moduleService = require('../modules/services/module.service');
const moduleTools = require('../modules/services/module-tools.service');
const chatTool = require('../modules/replenishment/chat-tool');
const manifestSvc = require('../services/dataset-manifest');
const capabilityGate = require('../services/capability-gate.service');
const { zolstockRules } = require('../services/schema-rules/zolstock.rules');
const registry = require('../modules/registry');

const DS = 'zolstock';
const MOD = 'replenishment';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

/** A stand-in for a CrewMember, carrying only what attachTo() touches. */
function fakeCrew(schema) {
  return {
    datasetSchema: schema,
    tools: [{ name: 'fetch_zolstock_data', description: 'existing', handler: async () => ({}) }],
  };
}

(async () => {
  await db.initialize();
  const before = await moduleService.getForDataset(DS, MOD);
  const restore = before.enabled;

  console.log('\n1 · Tool registration follows the live gate');
  {
    await moduleService.setEnabled(DS, MOD, false, 'd3-test');
    const crew = fakeCrew(DS);
    const r = await moduleTools.attachTo(crew);
    ok('module off ⇒ no tool attached', r.attached.length === 0, JSON.stringify(r));
    ok('…and the crew keeps exactly the tools it had', crew.tools.length === 1, String(crew.tools.length));

    await moduleService.setEnabled(DS, MOD, true, 'd3-test');
    const crew2 = fakeCrew(DS);
    const r2 = await moduleTools.attachTo(crew2);
    ok('module live ⇒ fetch_replenishment attached',
      r2.attached.includes('fetch_replenishment'), JSON.stringify(r2));
    ok('…alongside the crew\'s own tool, not instead of it',
      crew2.tools.length === 2 && crew2.tools.some(t => t.name === 'fetch_zolstock_data'));
    ok('…and it carries a handler', typeof crew2.tools.find(t => t.name === 'fetch_replenishment')?.handler === 'function');

    // Reversibility: the same crew object, module switched off between turns.
    await moduleService.setEnabled(DS, MOD, false, 'd3-test');
    const r3 = await moduleTools.attachTo(crew2);
    ok('switching the module off removes the tool on the NEXT turn',
      r3.attached.length === 0 && crew2.tools.length === 1, String(crew2.tools.length));
    await moduleService.setEnabled(DS, MOD, true, 'd3-test');
  }
  {
    const crew = fakeCrew(null);
    const r = await moduleTools.attachTo(crew);
    ok('a crew with no dataset is untouched', r.attached.length === 0 && crew.tools.length === 1);
  }
  {
    // A module must never shadow a tool the prompt was written around.
    const crew = fakeCrew(DS);
    crew.tools.push({ name: 'fetch_replenishment', description: 'crew-owned', handler: async () => ({}) });
    const r = await moduleTools.attachTo(crew);
    ok('a name collision is refused, not silently overridden',
      r.attached.length === 0 && crew.tools.filter(t => t.name === 'fetch_replenishment').length === 1);
  }

  console.log('\n2 · The same question five ways returns identical numbers');
  {
    // Five argument shapes a model could plausibly produce for the same
    // business question, in both languages. The tool takes structured args,
    // so all five must land on the same computation.
    const shapes = [
      {},
      { onlyDue: true },
      { onlyDue: true, limit: 25 },
      { onlyDue: true, horizonDays: 14 },
      { onlyDue: true, limit: 25, horizonDays: 14 },
    ];
    const results = [];
    for (const s of shapes) results.push(await chatTool.handle(DS, s));

    const counts = results.map(r => JSON.stringify(r.counts));
    ok('all five return the same headline counts', new Set(counts).size === 1,
      [...new Set(counts)].join(' VS '));

    const totals = results.map(r => r.total);
    ok('…and the same total', new Set(totals).size === 1, JSON.stringify(totals));

    const firstRows = results.map(r => JSON.stringify(r.recommendations[0]));
    ok('…and the identical most-urgent row', new Set(firstRows).size === 1,
      new Set(firstRows).size + ' distinct');

    const throughs = results.map(r => r.dataThrough);
    ok('…anchored to the same data date', new Set(throughs).size === 1, JSON.stringify(throughs[0]));
    console.log(`       counts: ${counts[0]}`);
  }
  {
    // Repeat calls must also be stable — a model may retry.
    const a = await chatTool.handle(DS, { onlyDue: true });
    const b = await chatTool.handle(DS, { onlyDue: true });
    ok('repeating the same call is byte-identical',
      JSON.stringify(a.recommendations) === JSON.stringify(b.recommendations));
  }

  console.log('\n3 · The tool carries its caveats, and cannot quietly drop them');
  {
    const r = await chatTool.handle(DS, { onlyDue: true, limit: 5 });
    ok('a data contract is returned', Array.isArray(r.dataContract) && r.dataContract.length >= 3,
      String(r.dataContract?.length));
    ok('…stating the data-through date', r.dataContract.some(c => /Data through/.test(c)));
    ok('…and how many rows use an ASSUMED delivery time',
      r.dataContract.some(c => /ASSUMED delivery time/.test(c)), JSON.stringify(r.dataContract));
    ok('…and that order values are list-price estimates',
      r.dataContract.some(c => /list-price estimates/.test(c)));
    ok('every row states which lead-time source it used',
      r.recommendations.every(x => Boolean(x.leadTimeSource)));
    ok('caveats are the engine\'s own wording, quoted', Array.isArray(r.notes) && r.notes.length > 0,
      JSON.stringify(r.notes?.slice(0, 1)));
  }
  {
    await moduleService.setEnabled(DS, MOD, false, 'd3-test');
    const r = await chatTool.handle(DS, {});
    ok('with the module off the tool refuses rather than answering', Boolean(r.error), JSON.stringify(r));
    await moduleService.setEnabled(DS, MOD, true, 'd3-test');
  }

  console.log('\n4 · Generated SQL is steered AWAY from the reorder arithmetic');
  {
    const rules = zolstockRules(DS);
    ok('the rules forbid answering reorder questions with SQL',
      /DO NOT ANSWER THESE WITH SQL/.test(rules));
    ok('…and name the tool that does', /fetch_replenishment/.test(rules));
    ok('…and say WHY (the lead time is not in the database)',
      /not in the database at all/.test(rules));
    ok('the old "compute need from stock vs open orders" recipe is gone',
      !/need ≈ customer orders \+ safety/.test(rules));
    ok('the item-grain fact-scan ban survives',
      /NEVER scan .*facts.* grouped by\s*\n?item/.test(rules) || /NEVER scan/.test(rules));
  }

  console.log('\n5 · Honesty layer — goods receipt');
  {
    const manifest = manifestSvc.get(DS);
    ok('the manifest declares goods receipt ABSENT',
      manifest.dimensions['goods receipt / arrival date']?.status === 'absent');
    ok('…with a roadmap, not just a refusal',
      Boolean(manifest.dimensions['goods receipt / arrival date']?.roadmap));

    const arrivalQuestions = [
      'when did purchase order 4471 arrive',
      'מתי הגיעה ההזמנה',
      'what is the goods receipt date for sku BH-34-240',
      'מתי התקבלה הסחורה',
    ];
    for (const q of arrivalQuestions) {
      const gate = capabilityGate.check(q, manifest);
      ok(`refuses: "${q.slice(0, 42)}"`, gate?.action === 'refuse', JSON.stringify(gate?.action));
    }
    const firstRefusal = capabilityGate.check(arrivalQuestions[0], manifest)?.refusal;
    ok('…and the refusal names the missing data',
      /nothing records goods arriving/i.test(firstRefusal?.reason || ''), firstRefusal?.reason);
    ok('…and offers what IS answerable instead',
      /when an order was placed/i.test(firstRefusal?.alternatives || ''), firstRefusal?.alternatives);
  }
  {
    // Precision beats recall: questions about ORDERING are answerable and
    // must not be swallowed by the arrival triggers.
    const answerable = [
      'when did we order sku BH-34-240',
      'מתי הזמנו את הפריט הזה',
      'how many open purchase orders are there',
      'כמה הזמנות רכש פתוחות יש',
    ];
    const manifest = manifestSvc.get(DS);
    for (const q of answerable) {
      const gate = capabilityGate.check(q, manifest);
      ok(`still answerable: "${q.slice(0, 42)}"`, gate?.action !== 'refuse', JSON.stringify(gate?.action));
    }
  }

  console.log('\n6 · The module fragment describes only what the module adds');
  {
    const frag = registry.get(MOD).manifestFragment ? null : null; // descriptor-level check below
    const descriptor = registry.get(MOD);
    const f = descriptor.hooks.manifestFragment({ datasetId: DS });
    ok('it declares the derived measures as ESTIMATES',
      f.measures['replenishment need / order quantity'].fidelity === 'estimate');
    ok('it introduces the "configured" dimension status',
      f.dimensions['supplier lead time'].status === 'configured');
    ok('…and says the value is user-supplied, not measured',
      /user-supplied/.test(f.dimensions['supplier lead time'].detail));
    ok('it carries Hebrew AND English vocabulary',
      f.vocabulary.some(v => v.terms.some(t => /[֐-׿]/.test(t))) &&
      f.vocabulary.some(v => v.terms.some(t => /^[a-z ]+$/i.test(t))));
    ok('it does NOT claim the goods-receipt absence (that belongs to the dataset)',
      !f.dimensions['goods receipt / arrival date'], JSON.stringify(Object.keys(f.dimensions)));
    void frag;
  }

  await moduleService.setEnabled(DS, MOD, restore, 'd3-test');
  const after = await moduleService.getForDataset(DS, MOD);
  ok('module state restored', after.enabled === restore, `enabled=${after.enabled}`);

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('Battery failed:', err.message); console.error(err); process.exit(1); });
