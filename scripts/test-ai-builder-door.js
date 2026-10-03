#!/usr/bin/env node
/**
 * The battery for the "build with your own AI" door (task #96) — both doors:
 * the HTTP guide/REST and the MCP server on the same personal link.
 *
 *   node scripts/test-ai-builder-door.js                       # local, zolstock
 *   node scripts/test-ai-builder-door.js https://<cloud-run-host> zolstock
 *
 * Needs the `ai-builder` and `otto` modules live for the dataset. Works on any
 * such dataset: the spec it builds comes from that dataset's own brief.
 *
 * Self-cleaning: it acts as throwaway viewers (zz-door-test-*), whose drafts
 * nobody else can see, and deletes every app it creates — with its version
 * history. It never publishes: a published app can only be removed by a
 * super-admin, and it would appear on every colleague's shelf meanwhile.
 * Publish/unpublish rules are covered by the refusal checks below.
 *
 * Exits 1 on any failure.
 */

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const DATASET = process.argv[3] || 'zolstock';
const VIEWER = 'zz-door-test-a';
const OTHER = 'zz-door-test-b';

let failures = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}
const J = { 'content-type': 'application/json' };
const L = (en, he) => ({ en, he: he || en });

async function link(viewerId) {
  const r = await fetch(`${BASE}/api/otto/${DATASET}/ai-link?viewerId=${viewerId}`);
  const j = await r.json();
  if (!j.url) throw new Error(`no link for ${viewerId}: ${JSON.stringify(j)} — is module ai-builder live for ${DATASET}?`);
  // Talk to the server under test even when the link names another host.
  return j.url.replace(/^https?:\/\/[^/]+/, BASE);
}
const post = (url, body) => fetch(url, { method: 'POST', headers: J, body: JSON.stringify(body) });

/** A small spec built from the dataset's own brief: one grouped source. */
function specFromSchema(schema) {
  for (const s of schema.sources) {
    const fields = schema.fields.filter(f => f.sourceId === s.id);
    const text = fields.find(f => f.type === 'text');
    const num = fields.find(f => f.type === 'number');
    if (!text || !num) continue;
    return {
      specVersion: 1,
      resultSets: [{
        id: 'grp', source: s.id,
        aggregate: { groupBy: [text.id], measures: [{ id: 'total', agg: 'sum', field: num.id, label: L('Total', 'סה"כ'), format: 'decimal' }] },
        orderBy: { field: 'total', dir: 'desc' }, limit: 10,
      }],
      blocks: [
        { kind: 'dataTable', from: 'grp', columns: [text.id, 'total'] },
        { kind: 'chart', from: 'grp', variant: 'bar', category: text.id, series: ['total'], title: L('Top 10', 'טופ 10') },
      ],
    };
  }
  throw new Error('no source with both a text and a number field in the brief');
}

async function httpDoor() {
  console.log('\n— HTTP door');
  const B = await link(VIEWER);
  const B2 = await link(OTHER);
  ok(B.includes(`/intelligence/${DATASET}/mcp/`), 'personal link issued');

  let r = await fetch(B);
  let t = await r.text();
  ok(r.status === 200 && r.headers.get('content-type').startsWith('text/plain') && t.includes('## Commands'), `guide is text/plain (${t.length} chars)`);
  ok(t.includes('## History and undo') && t.includes('## The whole database'), 'guide covers history and the whole database');
  r = await fetch(B, { headers: { accept: 'text/event-stream' } });
  ok(r.status === 405, `SSE probe -> ${r.status}`);

  const schema = await (await fetch(`${B}/schema?format=json`)).json();
  ok(schema.sources?.length > 0 && schema.fields?.length > 0, `schema: ${schema.sources.length} sources, ${schema.fields.length} fields`);
  const full = await (await fetch(`${B}/schema/full`)).json();
  const open = full.relations?.filter(x => x.open) || [];
  ok(open.length > 0 && full.relations.length > open.length,
    `full schema: ${full.relations?.length} relations, ${open.length} open for screens`);
  ok(open.some(x => x.columns.some(c => c.field)), 'full schema maps open columns to field ids');

  // isolation and auth
  r = await fetch(B.replace(`/intelligence/${DATASET}/`, '/intelligence/__nope__/'));
  ok(r.status === 404, `unknown client -> ${r.status}`);
  r = await fetch(B.slice(0, -3) + 'xyz');
  ok(r.status === 401, `forged token -> ${r.status}`);
  r = await fetch(`${BASE}/intelligence/${DATASET}/mcp`);
  ok(r.status === 401, `link without its key -> ${r.status}`);

  // errors are sentences
  r = await fetch(`${B}/check`, { method: 'POST', headers: J, body: '{"spec": {bad' });
  ok(r.status === 400 && (await r.json()).error?.includes('not valid JSON'), 'bad JSON -> sentence');
  r = await fetch(`${B}/nonsense`);
  ok(r.status === 404 && (await r.json()).error?.includes('Reads are GET'), 'unknown path -> endpoint map');

  // check
  const spec = specFromSchema(schema);
  let j = await (await post(`${B}/check`, { spec })).json();
  ok(j.ok === true, `check valid spec -> ${j.stage} ${j.errors?.join('; ') || ''}`);
  const bad = structuredClone(spec); bad.resultSets[0].source = '__nope__';
  j = await (await post(`${B}/check`, { spec: bad })).json();
  ok(j.ok === false && j.errors.length > 0, 'check invalid spec -> errors');
  const pie = structuredClone(spec); pie.blocks[1].variant = 'pie'; pie.resultSets[0].limit = 40;
  j = await (await post(`${B}/check`, { spec: pie })).json();
  ok(j.ok === false && j.errors.some(e => e.includes('at most 10 slices')), 'pie over 10 slices refused');
  const kpi = structuredClone(spec);
  kpi.blocks.unshift({ kind: 'kpiCards', from: 'grp', cards: [{ id: 'sum_all', label: L('Sum'), agg: 'sum', field: 'total' }] });
  j = await (await post(`${B}/check`, { spec: kpi })).json();
  ok(j.ok === true && Array.isArray(j.warnings), `KPI on a limited set -> ok with ${j.warnings?.length} warning(s)`);

  // create / read / versions / update / restore
  r = await post(`${B}/apps`, { spec: bad, title: L('x') });
  ok(r.status === 422, `save failing spec -> ${r.status}`);
  r = await post(`${B}/apps`, { spec, title: L('Door test'), icon: 'chart', note: 'battery create' });
  j = await r.json();
  ok(r.status === 201 && j.id && j.version === 1, `create -> ${j.id} v${j.version}`);
  const id = j.id;

  j = await (await fetch(`${B}/apps`)).json();
  ok(j.apps.some(a => a.id === id && a.mine === true && a.status === 'draft'), 'list shows own draft (mine)');
  j = await (await fetch(`${B2}/apps`)).json();
  ok(!j.apps.some(a => a.id === id), 'other viewer does not see it');
  r = await fetch(`${B2}/apps/${id}`);
  ok(r.status === 404, `other viewer get -> ${r.status}`);

  const spec2 = structuredClone(spec); spec2.blocks = spec2.blocks.filter(b => b.kind !== 'chart');
  r = await post(`${B}/apps/${id}`, { spec: spec2, note: 'removed the chart' });
  j = await r.json();
  ok(r.status === 200 && j.version === 2 && j.reminder, `update -> v${j.version}, summary reminder`);
  r = await post(`${B2}/apps/${id}`, { spec });
  ok(r.status === 404, `other viewer update -> ${r.status}`);

  j = await (await fetch(`${B}/apps/${id}/versions`)).json();
  ok(j.versions?.length === 2 && j.versions[1].note === 'removed the chart' && j.currentMatchesLatest === true,
    `history: ${j.versions?.map(v => `v${v.version}:${v.note}`).join(', ')}`);

  r = await post(`${B}/apps/${id}/restore`, { version: 1 });
  j = await r.json();
  ok(r.status === 200 && j.restored === 1 && j.version === 3, `restore v1 -> saved as v${j.version}`);
  j = await (await fetch(`${B}/apps/${id}`)).json();
  ok(j.app?.spec?.blocks?.some(b => b.kind === 'chart'), 'restored spec has the chart back');
  r = await post(`${B}/apps/${id}/restore`, { version: 99 });
  ok(r.status === 404, `restore missing version -> ${r.status}`);

  // lifecycle refusals (never publish for real — see the header)
  r = await post(`${B2}/apps/${id}/publish`, {});
  ok(r.status === 404, `other viewer publish -> ${r.status}`);
  r = await post(`${B}/apps/${id}/unpublish`, {});
  j = await r.json();
  ok(r.status === 200 && j.status === 'draft', 'unpublish a draft is a no-op');

  // delete (+ history goes with it)
  r = await fetch(`${B}/apps/${id}`, { method: 'DELETE' });
  j = await r.json();
  ok(j.deleted === true && j.title?.en === 'Door test', 'delete echoes the title');
  r = await fetch(`${B}/apps/${id}`);
  ok(r.status === 404, `deleted app -> ${r.status}`);
  r = await fetch(`${B}/apps/${id}/versions`);
  ok(r.status === 404, `deleted app history -> ${r.status}`);
  return { B, spec };
}

async function mcpDoor(B, spec) {
  console.log('\n— MCP door');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'door-battery', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(B)));

  const info = client.getServerVersion();
  const instr = client.getInstructions() || '';
  ok(info?.name === `aspect-intelligence-${DATASET}`, `initialize: ${info?.name}`);
  ok(instr.includes('the `check_app` tool') && !instr.includes('POST `'), 'instructions name tools, not URLs');
  const { tools } = await client.listTools();
  const names = tools.map(x => x.name);
  const expected = ['get_guide', 'get_schema', 'get_full_schema', 'list_apps', 'get_app', 'check_app', 'create_app',
    'update_app', 'publish_app', 'unpublish_app', 'delete_app', 'list_versions', 'restore_version'];
  ok(expected.every(n => names.includes(n)) && names.length === expected.length, `tools: ${names.length}`);
  ok(tools.find(x => x.name === 'delete_app').annotations?.destructiveHint === true, 'delete_app is destructive');
  ok(tools.filter(x => x.annotations?.readOnlyHint).length === 7, 'seven read-only tools');

  const text = res => res.content?.[0]?.text || '';
  const call = (name, args) => client.callTool({ name, arguments: args || {} });
  let res = await call('get_full_schema');
  ok(JSON.parse(text(res)).relations?.length > 0, 'get_full_schema');
  res = await call('check_app', { spec });
  ok(JSON.parse(text(res)).ok === true, 'check_app');
  res = await call('create_app', { spec, title: L('Door MCP test'), note: 'mcp create' });
  const created = JSON.parse(text(res));
  ok(created.saved && created.version === 1, `create_app -> ${created.id}`);
  res = await call('update_app', { id: created.id, title: L('Door MCP test 2'), note: 'renamed' });
  ok(JSON.parse(text(res)).version === 2, 'update_app -> v2');
  res = await call('list_versions', { id: created.id });
  ok(JSON.parse(text(res)).versions.length === 2, 'list_versions');
  res = await call('restore_version', { id: created.id, version: 1 });
  ok(JSON.parse(text(res)).version === 3, 'restore_version -> v3');
  res = await call('get_app', { id: created.id });
  ok(JSON.parse(text(res)).app.title.en === 'Door MCP test', 'restore brought the old title back');
  res = await call('create_app', { spec: { specVersion: 1 }, title: L('x') });
  ok(res.isError === true, 'failing spec -> isError result');
  res = await call('delete_app', { id: created.id });
  ok(JSON.parse(text(res)).deleted === true, 'delete_app');
  await client.close();
}

(async () => {
  console.log(`AI builder door battery — ${BASE} / ${DATASET}`);
  const { B, spec } = await httpDoor();
  await mcpDoor(B, spec);
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('battery crashed:', err);
  process.exit(1);
});
