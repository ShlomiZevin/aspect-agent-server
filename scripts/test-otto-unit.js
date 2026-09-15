#!/usr/bin/env node
/**
 * Otto — offline unit battery. No DB, no LLM, no network.
 *
 *   node scripts/test-otto-unit.js
 *
 * Covers: the expression grammar (parse / SQL / eval, including rejects),
 * brief structural validation + heavy-flag derivation, plan and spec
 * validation against a fixture brief, the compiler's SQL output (schema
 * qualification, quoting, LIMIT cap, NULLIF division, GROUP BY), the
 * verification probes (KPI cross-check both agreeing and disagreeing), the
 * build-progress monotonicity, the module descriptor's registry validation,
 * and the Apps-shelf byte-identical guarantee with Otto off.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ name, detail });
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function throws(name, fn, match) {
  try {
    fn();
    check(name, false, 'expected a throw, got none');
  } catch (e) {
    check(name, !match || String(e.message).includes(match),
      `threw '${e.message}', expected to include '${match}'`);
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────

const AUDIT = {
  schemaName: 'testset',
  relations: [
    {
      name: 'mv_stock', kind: 'matview', rows: 12000,
      columns: [
        { name: 'store_name', type: 'text' }, { name: 'item_name', type: 'text' },
        { name: 'category', type: 'text' }, { name: 'supplier_name', type: 'text' },
        { name: 'qty_on_hand', type: 'numeric' }, { name: 'safety_stock', type: 'numeric' },
      ],
    },
    { name: 'facts', kind: 'table', rows: 30_000_000, columns: [{ name: 'x', type: 'numeric' }] },
    { name: 'mv_heavy_agg', kind: 'matview', rows: 6_000_000, columns: [{ name: 'y', type: 'numeric' }] },
  ],
};

const BRIEF = {
  briefVersion: 1,
  sources: [
    {
      id: 'stock', relation: 'mv_stock', heavy: false,
      label: { en: 'Stock', he: 'מלאי' },
      description: { en: 'one row per item per store', he: 'שורה לפריט לסניף' },
    },
  ],
  fields: [
    { id: 'store', sourceId: 'stock', column: 'store_name', type: 'text', format: 'text', label: { en: 'Store', he: 'סניף' } },
    { id: 'item', sourceId: 'stock', column: 'item_name', type: 'text', format: 'text', label: { en: 'Item', he: 'פריט' } },
    { id: 'category', sourceId: 'stock', column: 'category', type: 'text', format: 'text', label: { en: 'Category', he: 'קטגוריה' } },
    { id: 'supplier', sourceId: 'stock', column: 'supplier_name', type: 'text', format: 'text', label: { en: 'Supplier', he: 'ספק' } },
    { id: 'qty', sourceId: 'stock', column: 'qty_on_hand', type: 'number', format: 'int', label: { en: 'Current stock', he: 'מלאי נוכחי' } },
    { id: 'safety', sourceId: 'stock', column: 'safety_stock', type: 'number', format: 'int', label: { en: 'Safety', he: 'מלאי ביטחון' } },
  ],
  caveats: [
    { id: 'snapshot_only', text: { en: 'Snapshot only — no history.', he: 'תמונת מצב בלבד — ללא היסטוריה.' } },
  ],
  starters: [
    { text: { en: 'Stock below safety level', he: 'מלאי מתחת למלאי הביטחון' } },
    { text: { en: 'Sales comparison between branches', he: 'השוואת מכירות בין סניפים' } },
  ],
};

const SPEC = {
  specVersion: 1,
  resultSets: [
    {
      id: 'rows',
      source: 'stock',
      select: ['store', 'item', 'category', 'supplier', 'qty', 'safety'],
      computed: [{ id: 'shortfall', label: { en: 'Shortfall', he: 'חוסר' }, expr: 'safety - qty', format: 'int' }],
      where: 'safety > 0',
      orderBy: { field: 'shortfall', dir: 'desc' },
      limit: 500,
    },
  ],
  blocks: [
    { kind: 'noteLine', caveatIds: ['snapshot_only'] },
    {
      kind: 'kpiCards', from: 'rows',
      cards: [
        { id: 'below', label: { en: 'Rows below safety', he: 'שורות מתחת לביטחון' }, sub: { en: 'store × item', he: 'סניף × פריט' }, agg: 'countWhere', where: 'shortfall > 0', format: 'int', tone: 'alarm' },
        { id: 'units', label: { en: 'Units to order', he: 'יחידות להזמנה' }, agg: 'sum', field: 'shortfall', where: 'shortfall > 0', format: 'int', tone: 'warn' },
      ],
    },
    { kind: 'filterBar', from: 'rows', filters: ['category', 'supplier'] },
    { kind: 'dataTable', from: 'rows', columns: ['store', 'item', 'category', 'supplier', 'qty', 'safety', 'shortfall'], sortable: true, pageSize: 50 },
    {
      kind: 'actionsBar',
      actions: [
        { id: 'export', type: 'exportCsv', from: 'rows', label: { en: 'Export list', he: 'ייצוא רשימה' } },
        { id: 'po', type: 'stub', label: { en: 'Create purchase order', he: 'יצירת הזמנת רכש' }, notice: { en: 'Will be wired to your ordering system.', he: 'יחובר למערכת ההזמנות שלכם.' } },
      ],
    },
  ],
};

const clone = (x) => JSON.parse(JSON.stringify(x));

// ── 1 · expressions ──────────────────────────────────────────────────────

console.log('1. expression grammar');
{
  const ex = require('../otto/services/expressions');

  const ast = ex.parseExpr('safety - qty * 2');
  check('parse precedence', ex.evalExpr(ast, { safety: 10, qty: 3 }) === 4);
  check('fieldsOf', [...ex.fieldsOf(ast)].sort().join(',') === 'qty,safety');

  const sql = ex.toSQL(ex.parseExpr('safety / qty'), id => `"${id}"`);
  check('division renders NULLIF', sql.includes('NULLIF("qty", 0)'), sql);

  const cond = ex.parseCondition('safety - qty > 0');
  check('condition eval true', ex.evalCondition(cond, { safety: 5, qty: 1 }) === true);
  check('condition eval false', ex.evalCondition(cond, { safety: 1, qty: 5 }) === false);
  check('condition NaN row is false', ex.evalCondition(cond, { safety: 'x', qty: 1 }) === false);
  check('condition toSQL != becomes <>',
    ex.conditionToSQL(ex.parseCondition('qty != 3'), id => `"${id}"`).includes('<>'));

  throws('rejects function calls', () => ex.parseExpr('drop(table)'), 'trailing');
  throws('rejects strings', () => ex.parseExpr("name = 'x'"), 'unexpected character');
  throws('rejects trailing input', () => ex.parseExpr('qty 5'), 'trailing');
  throws('rejects sql injection shapes', () => ex.parseExpr('qty; DROP TABLE x'), 'unexpected character');
  throws('condition requires comparison', () => ex.parseCondition('qty + 1'), 'comparison');
}

// ── 2 · brief validation ─────────────────────────────────────────────────

console.log('2. brief validation');
{
  const { validateBrief, applyHeavyFlags } = require('../otto/services/brief.service');

  check('valid brief passes', validateBrief(clone(BRIEF), AUDIT).length === 0,
    validateBrief(clone(BRIEF), AUDIT).join('; '));

  const badRel = clone(BRIEF);
  badRel.sources[0].relation = 'mv_ghost';
  check('unknown relation named', validateBrief(badRel, AUDIT).some(e => e.includes('mv_ghost')));

  const badCol = clone(BRIEF);
  badCol.fields[0].column = 'no_such_col';
  const colErrors = validateBrief(badCol, AUDIT);
  check('unknown column named with the real column list',
    colErrors.some(e => e.includes('no_such_col') && e.includes('store_name')));

  const noHe = clone(BRIEF);
  delete noHe.fields[0].label.he;
  check('missing hebrew label rejected', validateBrief(noHe, AUDIT).some(e => e.includes('en and he')));

  const heavyTable = clone(BRIEF);
  heavyTable.sources.push({
    id: 'facts', relation: 'facts',
    label: { en: 'Facts', he: 'עובדות' }, description: { en: 'raw', he: 'גולמי' },
  });
  heavyTable.fields.push({ id: 'x', sourceId: 'facts', column: 'x', type: 'number', label: { en: 'X', he: 'איקס' } });
  const heavyErrors = applyHeavyFlags(heavyTable, AUDIT);
  check('30M-row raw table rejected as source', heavyErrors.some(e => e.includes('raw table')));

  const heavyMv = clone(BRIEF);
  heavyMv.sources.push({
    id: 'agg', relation: 'mv_heavy_agg',
    label: { en: 'Agg', he: 'מצרפי' }, description: { en: 'agg', he: 'מצרפי' },
  });
  heavyMv.fields.push({ id: 'y', sourceId: 'agg', column: 'y', type: 'number', label: { en: 'Y', he: 'ווי' } });
  check('heavy MATVIEW allowed and flagged', applyHeavyFlags(heavyMv, AUDIT).length === 0
    && heavyMv.sources.find(s => s.id === 'agg').heavy === true);
}

// ── 3 · plan validation ──────────────────────────────────────────────────

console.log('3. plan validation');
{
  const { validatePlan } = require('../otto/services/spec.contract');

  const plan = {
    title: { en: 'Safety Stock', he: 'מלאי ביטחון' },
    summary: { en: 'Items below safety level', he: 'פריטים מתחת למלאי הביטחון' },
    icon: 'box',
    sources: [{ id: 'stock', label: { en: 'Stock file', he: 'קובץ מלאי' } }],
    columns: [{ field: 'store', label: { en: 'Store', he: 'סניף' } }],
    filters: [{ field: 'category', label: { en: 'Category', he: 'קטגוריה' } }],
    kpis: [{ label: { en: 'Below safety', he: 'מתחת לביטחון' }, detail: { en: 'count', he: 'ספירה' } }],
    actions: [],
    notes: [],
  };
  check('valid plan passes', validatePlan(plan, BRIEF).length === 0, validatePlan(plan, BRIEF).join('; '));

  const badField = clone(plan);
  badField.columns[0].field = 'revenue';
  check('field outside the brief rejected', validatePlan(badField, BRIEF).some(e => e.includes('revenue')));

  const badIcon = clone(plan);
  badIcon.icon = 'sparkles';
  check('unknown icon rejected', validatePlan(badIcon, BRIEF).some(e => e.includes('icon')));

  const noCols = clone(plan);
  noCols.columns = [];
  check('empty columns rejected', validatePlan(noCols, BRIEF).length > 0);
}

// ── 4 · spec validation ──────────────────────────────────────────────────

console.log('4. spec validation');
{
  const { validateSpec } = require('../otto/services/spec.contract');

  check('the Safety Stock spec passes', validateSpec(clone(SPEC), BRIEF).length === 0,
    validateSpec(clone(SPEC), BRIEF).join('; '));

  const badKind = clone(SPEC);
  badKind.blocks.push({ kind: 'iframe', src: 'https://evil' });
  check('unknown block kind rejected', validateSpec(badKind, BRIEF).some(e => e.includes('kind')));

  const badRef = clone(SPEC);
  badRef.blocks[3].columns.push('margin');
  check('unknown table column rejected', validateSpec(badRef, BRIEF).some(e => e.includes("'margin'")));

  const collision = clone(SPEC);
  collision.resultSets[0].computed[0].id = 'qty';
  check('computed id collision rejected', validateSpec(collision, BRIEF).some(e => e.includes('collides')));

  const noWhere = clone(SPEC);
  delete noWhere.blocks[1].cards[0].where;
  check('countWhere without where rejected', validateSpec(noWhere, BRIEF).some(e => e.includes('countWhere')));

  const fakeCaveat = clone(SPEC);
  fakeCaveat.blocks[0].caveatIds = ['invented_caveat'];
  check('caveat outside the brief rejected — quoted, never invented',
    validateSpec(fakeCaveat, BRIEF).some(e => e.includes('invented_caveat')));

  const hugeLimit = clone(SPEC);
  hugeLimit.resultSets[0].limit = 999999;
  check('limit above cap rejected', validateSpec(hugeLimit, BRIEF).some(e => e.includes('limit')));

  const agg = clone(SPEC);
  agg.resultSets.push({
    id: 'by_supplier', source: 'stock',
    aggregate: {
      groupBy: ['supplier'],
      measures: [{ id: 'total_qty', agg: 'sum', field: 'qty', label: { en: 'Total', he: 'סה"כ' }, format: 'int' }],
    },
    orderBy: { field: 'total_qty', dir: 'desc' },
  });
  agg.blocks.push({
    kind: 'chart', from: 'by_supplier', variant: 'bar', category: 'supplier',
    series: ['total_qty'], title: { en: 'Stock by supplier', he: 'מלאי לפי ספק' },
  });
  check('aggregate set + chart passes', validateSpec(agg, BRIEF).length === 0,
    validateSpec(agg, BRIEF).join('; '));
}

// ── 5 · compiler ─────────────────────────────────────────────────────────

console.log('5. compiler');
{
  const { compileResultSet, compileKpi, compileSpec } = require('../otto/services/compiler.service');

  const rs = clone(SPEC.resultSets[0]);
  const { sql, columns, limit } = compileResultSet(rs, BRIEF, 'testset');
  check('schema-qualified and quoted', sql.includes('"testset"."mv_stock"'), sql);
  check('fields aliased to ids', sql.includes('"store_name" AS "store"'), sql);
  check('computed inlined', sql.includes('"safety_stock" - "qty_on_hand"') && sql.includes('AS "shortfall"'), sql);
  check('where compiled', sql.includes('WHERE ("safety_stock" > 0)'), sql);
  check('order by alias with NULLS LAST', sql.includes('ORDER BY "shortfall" DESC NULLS LAST'), sql);
  check('limit present', sql.endsWith('LIMIT 500'), sql);
  check('columns in order', columns.join(',') === 'store,item,category,supplier,qty,safety,shortfall');
  check('limit returned', limit === 500);

  const capped = compileResultSet({ ...rs, limit: undefined }, BRIEF, 'testset');
  check('default limit applied', capped.sql.endsWith('LIMIT 500'), capped.sql);

  const kpi = compileKpi(SPEC.blocks[1].cards[1], rs, BRIEF, 'testset');
  check('kpi sums the computed expression over the FULL set',
    kpi.sql.includes('SUM') && kpi.sql.includes('WHERE') && !kpi.sql.includes('LIMIT'), kpi.sql);
  check('kpi combines set-where AND card-where',
    (kpi.sql.match(/AND/g) || []).length >= 1, kpi.sql);

  const aggRs = {
    id: 'by_supplier', source: 'stock',
    aggregate: {
      groupBy: ['supplier'],
      measures: [{ id: 'total_qty', agg: 'sum', field: 'qty', label: { en: 'T', he: 'ט' } }],
    },
  };
  const aggSql = compileResultSet(aggRs, BRIEF, 'testset').sql;
  check('aggregate emits GROUP BY', aggSql.includes('GROUP BY "supplier_name"'), aggSql);
  check('measure aliased', aggSql.includes('SUM("qty_on_hand")::float8 AS "total_qty"'), aggSql);

  const all = compileSpec(clone(SPEC), BRIEF, 'testset');
  check('compileSpec covers all sets and kpis',
    Object.keys(all.resultSets).length === 1 && all.kpis.length === 2);
}

// ── 6 · probes ───────────────────────────────────────────────────────────

console.log('6. verification probes');
{
  const { verifyBuild, jsKpi } = require('../otto/services/probes.service');

  const rows = [
    { store: 'A', item: 'i1', category: 'c', supplier: 's', qty: 2, safety: 10, shortfall: 8 },
    { store: 'A', item: 'i2', category: 'c', supplier: 's', qty: 20, safety: 10, shortfall: -10 },
    { store: 'B', item: 'i1', category: 'c', supplier: 's', qty: 0, safety: 5, shortfall: 5 },
  ];
  const payload = {
    resultSets: { rows: { columns: [], rows, total: 3, truncated: false } },
    kpis: { below: 2, units: 13 },
  };

  check('jsKpi countWhere', jsKpi(SPEC.blocks[1].cards[0], rows) === 2);
  check('jsKpi sum-with-where', jsKpi(SPEC.blocks[1].cards[1], rows) === 13);

  const good = verifyBuild(clone(SPEC), payload);
  check('agreeing build passes', good.passed, JSON.stringify(good.probes.filter(p => !p.passed)));

  const drifted = clone(payload);
  drifted.kpis.units = 999;
  const bad = verifyBuild(clone(SPEC), drifted);
  check('SQL/JS mismatch fails and names the card',
    !bad.passed && bad.probes.some(p => !p.passed && p.probe === 'kpi:units' && p.detail.includes('MISMATCH')));

  const empty = clone(payload);
  empty.resultSets.rows = { columns: [], rows: [], total: 0, truncated: false };
  check('empty result set fails', !verifyBuild(clone(SPEC), empty).passed);

  const truncated = clone(payload);
  truncated.resultSets.rows.truncated = true;
  truncated.kpis.units = 99999; // full-set value legitimately larger than the rows shown
  check('truncated set skips the JS cross-check', verifyBuild(clone(SPEC), truncated).passed);

  const allNull = clone(payload);
  allNull.resultSets.rows.rows = rows.map(r => ({ ...r, shortfall: null }));
  allNull.resultSets.rows.truncated = true; // isolate the numeric probe from the kpi cross-check
  check('all-NULL computed column fails (silent-zero class of bug)',
    verifyBuild(clone(SPEC), allNull).probes.some(p => !p.passed && p.probe === 'numeric:rows.shortfall'));
}

// ── 7 · build progress ───────────────────────────────────────────────────

console.log('7. build progress monotonicity');
{
  const { describeProgress, STAGES, MAX_PROBE_ROUNDS } = require('../otto/services/build-job.service');
  let prev = -1;
  for (let round = 1; round <= MAX_PROBE_ROUNDS; round++) {
    for (const stage of STAGES) {
      const p = describeProgress({ id: 1, screenId: 's', status: 'running', progressStage: `${round}:${stage}` });
      check(`percent monotonic at ${round}:${stage}`, p.percent >= prev, `${p.percent} < ${prev}`);
      check(`percent below 100 while running (${round}:${stage})`, p.percent < 100);
      prev = p.percent;
    }
  }
  const done = describeProgress({ id: 1, screenId: 's', status: 'succeeded', progressStage: '1:validating_totals', report: { ok: 1 } });
  check('terminal is 100 with report', done.percent === 100 && done.report?.ok === 1);
}

// ── 8 · module descriptor ────────────────────────────────────────────────

console.log('8. registry accepts the otto descriptor');
{
  const registry = require('../modules/registry');
  const otto = registry.get('otto');
  check('otto is registered', Boolean(otto));
  check('otto is NOT in the apps group (it is the builder, not a tile)',
    otto.group === undefined);
  check('otto declares all hooks', ['audit', 'proposeBinding', 'renderInfra', 'verify', 'nightlyBuild', 'chatTools', 'manifestFragment']
    .every(h => typeof otto.hooks[h] === 'function'));
  check('renderInfra is a no-op', Array.isArray(otto.hooks.renderInfra()) && otto.hooks.renderInfra().length === 0);
  check('buildModel defaults to Opus 5 (owner decision Q5)',
    otto.settingsSchema.find(f => f.key === 'buildModel')?.default === 'claude-opus-5');
}

// ── 8b · plan charts, pie variant, chart-type coercion ───────────────────

console.log('8b. plan charts / pie / coercion');
{
  const { validatePlan, validateSpec } = require('../otto/services/spec.contract');
  const { coerceChartVariants } = require('../otto/services/spec.service');

  const planWithChart = {
    title: { en: 'Pie test', he: 'בדיקה' }, summary: { en: 'x', he: 'x' }, icon: 'chart',
    sources: [{ id: 'stock', label: { en: 'Stock', he: 'מלאי' } }],
    columns: [{ field: 'store', label: { en: 'Store', he: 'סניף' } }],
    charts: [{ label: { en: 'Stock by supplier (pie)', he: 'מלאי לפי ספק (עוגה)' }, detail: { en: 'one slice per supplier', he: 'פרוסה לספק' } }],
  };
  check('plan with charts validates', validatePlan(planWithChart, BRIEF).length === 0,
    validatePlan(planWithChart, BRIEF).join('; '));
  const badChart = clone(planWithChart);
  delete badChart.charts[0].label.he;
  check('chart label must be bilingual', validatePlan(badChart, BRIEF).some(e => e.includes('charts[0]')));

  const pieSpec = clone(SPEC);
  pieSpec.resultSets.push({
    id: 'by_supplier', source: 'stock',
    aggregate: { groupBy: ['supplier'], measures: [{ id: 'total_qty', agg: 'sum', field: 'qty', label: { en: 'T', he: 'ט' } }] },
    orderBy: { field: 'total_qty', dir: 'desc' }, limit: 10,
  });
  pieSpec.blocks.push({ kind: 'chart', from: 'by_supplier', variant: 'pie', category: 'supplier', series: ['total_qty'], title: { en: 'Pie', he: 'עוגה' } });
  check('pie is a valid chart variant', validateSpec(pieSpec, BRIEF).length === 0, validateSpec(pieSpec, BRIEF).join('; '));
  const badVariant = clone(pieSpec);
  badVariant.blocks[badVariant.blocks.length - 1].variant = 'donut';
  check('unknown variant rejected', validateSpec(badVariant, BRIEF).some(e => e.includes('variant')));

  const coerced = clone(pieSpec);
  coerced.blocks[coerced.blocks.length - 1].variant = 'bar';
  coerceChartVariants(coerced, planWithChart);
  check('plan-named pie overrides a bar the model chose', coerced.blocks[coerced.blocks.length - 1].variant === 'pie');

  // "one line per store" in the DETAIL must not flip a bar chart to line.
  const barPlan = clone(planWithChart);
  barPlan.charts[0].label = { en: 'Stock by supplier (bar)', he: 'x' };
  barPlan.charts[0].detail = { en: 'one line per store, sorted by stock', he: 'x' };
  const stays = clone(pieSpec);
  stays.blocks[stays.blocks.length - 1].variant = 'bar';
  coerceChartVariants(stays, barPlan);
  check('detail prose never flips the variant', stays.blocks[stays.blocks.length - 1].variant === 'bar');

  const untyped = clone(planWithChart);
  untyped.charts[0].label = { en: 'Stock by supplier', he: 'x' };
  const keep = clone(pieSpec);
  keep.blocks[keep.blocks.length - 1].variant = 'line';
  coerceChartVariants(keep, untyped);
  check('untyped plan chart leaves the model choice alone', keep.blocks[keep.blocks.length - 1].variant === 'line');
}

// ── 9 · shelf shape guarantee ────────────────────────────────────────────

console.log('9. Apps shelf byte-identical with Otto off');
{
  const moduleService = require('../modules/services/module.service');
  const screensStore = require('../otto/services/screens.store');
  const apps = require('../modules/services/apps.service');

  const origLive = moduleService.getLiveModules;
  const origList = screensStore.list;
  (async () => {
    try {
      moduleService.getLiveModules = async () => [];
      screensStore.list = async () => [];
      const off = await apps.listApps('testset');
      check('no custom key with otto off', !('custom' in off), JSON.stringify(Object.keys(off)));
      check('no canCreate key with otto off', !('canCreate' in off));
      check('classic keys intact', 'apps' in off && 'planned' in off && 'researchedAt' in off);

      moduleService.getLiveModules = async () => [
        { row: {}, descriptor: require('../modules/otto/module') },
      ];
      screensStore.list = async () => [];
      const on = await apps.listApps('testset');
      check('canCreate true with otto live', on.canCreate === true);
      check('custom array present (empty) with otto live', Array.isArray(on.custom) && on.custom.length === 0);
      check('otto is NOT an app tile', !on.apps.some(a => a.id === 'otto'));

      const has = await apps.hasApps('testset');
      check('hasApps true from canCreate alone', has === true);
    } finally {
      moduleService.getLiveModules = origLive;
      screensStore.list = origList;
    }

    // ── summary ──
    console.log('');
    console.log(`${passed} passed, ${failed} failed`);
    if (failed > 0) {
      for (const f of failures) console.error(`FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
  })();
}
