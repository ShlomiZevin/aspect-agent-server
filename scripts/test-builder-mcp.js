#!/usr/bin/env node
/**
 * Battery for `/builder/mcp` — the AI front door (builder/routes/mcpRoute.js).
 *
 *   node scripts/test-builder-mcp.js
 *
 * Exits 1 on any failure. See docs/guides/BUILDER_MCP_MAINTENANCE.md §6.
 *
 * Talks to the REAL platform database (.env). Writes only to Claude's own
 * test agent `zz-mcp-test` (created if absent, kept afterwards) and to a
 * throwaway `zz-mcp-born-clean` that it deletes again. It never writes to
 * any other agent.
 *
 * The write checks assert what the Builder would SHOW, not merely that a
 * call returned 200 — because the one serious bug this door has had
 * returned 200 and was invisible.
 */

require('dotenv').config({ quiet: true });
const express = require('express');
const db = require('../services/db.pg');
const bp = require('../builder/services/builderProjects');

const TEST_SLUG = 'zz-mcp-test';
const BORN_CLEAN_SLUG = 'zz-mcp-born-clean';

let fails = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

// ─── Replicas of the client's "unsaved changes" definition ─────────
//
// Mirrors bodyOfAgent / bodyOfCrew in
// aspect-react-client/src/builder/state/BuilderContext.tsx. If those
// change, change these — otherwise the phantom-dirty checks below test
// the wrong thing and pass anyway.

function bodyOfAgent(a) {
  return {
    name: a.name,
    slug: a.slug,
    spec: a.spec,
    persona: a.persona,
    personas: a.personas ?? [],
    defaultCrewId: a.defaultCrewId,
    fields: a.fields,
    domains: a.domains ?? [],
    ...((a.tags?.length) ? { tags: a.tags } : {}),
    parameters: a.parameters ?? [],
    enums: a.enums ?? [],
    cortex: a.cortex ?? [],
    snippets: a.snippets ?? [],
    ...((a.liveBrain?.panels?.length || a.liveBrain?.frame || a.liveBrain?.enabled === false)
      ? { liveBrain: a.liveBrain } : {}),
    ...((a.profiler?.panels?.length || a.profiler?.frame || a.profiler?.ask || a.profiler?.enabled === false)
      ? { profiler: a.profiler } : {}),
    ...((a.triggers?.triggers?.length || a.triggers?.enabled === false)
      ? { triggers: a.triggers } : {}),
  };
}

function bodyOfCrew(c) {
  return {
    name: c.name,
    description: c.description,
    spec: c.spec,
    persona: c.persona,
    addons: c.addons,
    fields: c.fields,
  };
}

/** Key-order-independent; drops undefined like JSON.stringify does. */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/** Would the Builder show "unsaved changes"? And on which keys? */
function agentDirty(agent) {
  const saved = agent.versions.find(v => v.id === agent.viewingVersionId);
  const wc = bodyOfAgent(agent);
  const sv = saved ? saved.body : {};
  const keys = [...new Set([...Object.keys(wc), ...Object.keys(sv)])].sort();
  return keys.filter(k => stable(wc[k]) !== stable(sv[k]));
}

function crewDirty(crew) {
  const saved = crew.versions.find(v => v.id === crew.viewingVersionId);
  return stable(bodyOfCrew(crew)) !== stable(saved ? saved.body : {});
}

// ─── Fixtures ──────────────────────────────────────────────────────

async function ensureTestAgent() {
  const existing = await bp.hydrateProject({ agentSlug: TEST_SLUG });
  if (existing) return;
  await bp.createProject({
    ownerUserId: 'claude-selftest',
    projectName: 'ZZ MCP test (Claude)',
    projectId: 'project_zzmcptest',
    agentId: 'agent_zzmcptest',
    agentSlug: TEST_SLUG,
    agentVersionId: 'ver_zzmcptesta',
    crewId: 'crew_zzmcptest',
    crewVersionId: 'ver_zzmcptestc',
    agentBody: {
      name: 'ZZ MCP test',
      slug: TEST_SLUG,
      spec: 'Claude\'s test agent for /builder/mcp. Safe to delete.',
      persona: '',
      defaultCrewId: 'crew_zzmcptest',
      fields: [
        { id: 'customer_name', name: 'Customer name', type: 'string', description: 'Who we are talking to' },
      ],
    },
    crewBody: { name: 'Main', description: 'Only crew', spec: 'Say hello.', persona: '', addons: [] },
  });
  console.log(`(created ${TEST_SLUG})`);
}

async function removeIfPresent(slug) {
  const p = await bp.hydrateProject({ agentSlug: slug });
  if (p) await bp.deleteProject({ projectId: p.id });
}

// ─── Run ───────────────────────────────────────────────────────────

(async () => {
  await db.initialize();
  await ensureTestAgent();

  const app = express();
  app.use('/builder/mcp', require('../builder/routes/mcpRoute'));
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/builder/mcp`;

  const get = async (p, headers) => {
    const r = await fetch(base + p, { headers });
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
  };
  const post = async (p, obj) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(obj),
    });
    return { status: r.status, text: await r.text() };
  };
  const hydrate = slug => bp.hydrateProject({ agentSlug: slug });

  try {
    // ── surface ──
    section('entry page');
    const doc = await get('');
    check('200', doc.status === 200, `status ${doc.status}`);
    check('text/plain (readers refuse text/markdown)', /text\/plain/.test(doc.type), doc.type);
    check('starts with the title', doc.text.startsWith('# Lybi'));
    check('no unresolved template', !doc.text.includes('${'));
    check('own URLs are absolute', doc.text.includes(`${base}/agents`));
    check('points at /addons', doc.text.includes(`${base}/addons`));
    check('teaches the folder check', doc.text.includes('drafts/<agent-slug>.json'));
    check('teaches create', doc.text.includes(`POST ${base}/agents`));

    const proxied = await get('', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'lybi.ai' });
    check('behind a proxy, URLs use the public host', proxied.text.includes('https://lybi.ai/builder/mcp/agents'));
    check('…including the bundle URL', proxied.text.includes('https://lybi.ai/api/builder/ai-bundle'));

    section('code + addons');
    const ts = await get('/code/builder/types/index.ts');
    check('real file served', ts.status === 200 && ts.text.length > 500, `${ts.text.length} chars`);
    check('directory lists', (await get('/code/builder/addons/')).status === 200);
    check('bare /code works', (await get('/code')).status === 200);
    check('outside the allowlist → 404', (await get('/code/services/db.pg.js')).status === 404);
    check('.. traversal → 404', (await get('/code/builder/../../.env')).status === 404);
    check('missing file → 404', (await get('/code/builder/nope.js')).status === 404);

    const fs = require('fs');
    const path = require('path');
    const addonCount = fs.readdirSync(path.join(__dirname, '..', 'builder', 'addons'))
      .filter(f => f.endsWith('.addon.json')).length;
    const addons = await get('/addons');
    const served = (addons.text.match(/## builder\/addons\//g) || []).length;
    check('/addons serves every descriptor', addons.status === 200 && served === addonCount,
      `${served}/${addonCount}`);

    // ── reads ──
    section('reads');
    const list = await get('/agents');
    check('agent list', list.status === 200 && list.text.includes(TEST_SLUG));
    const one = await get(`/agents/${TEST_SLUG}`);
    let parsed = null;
    try { parsed = JSON.parse(one.text); } catch { /* checked below */ }
    check('one agent is JSON with nested crews',
      one.status === 200 && Array.isArray(parsed?.agents?.[0]?.crews));
    check('versions carry bodies', !!parsed?.agents?.[0]?.versions?.[0]?.body);
    check('conversations', (await get(`/agents/${TEST_SLUG}/conversations`)).status === 200);
    check('change log', (await get(`/agents/${TEST_SLUG}/log`)).status === 200);
    check('unknown agent → 404', (await get('/agents/definitely-not-real-xyz')).status === 404);

    // ── agent write ──
    section('agent write');
    const a0 = (await hydrate(TEST_SLUG)).agents[0];
    const stamp = new Date().toISOString();
    const edited = JSON.parse(JSON.stringify(a0.versions.find(v => v.id === a0.viewingVersionId).body));
    edited.spec = `Edited by the battery at ${stamp}`;

    const w = await post(`/agents/${TEST_SLUG}`, { body: edited, description: 'battery' });
    check('200', w.status === 200, `status ${w.status}`);
    check('reply says it is not live', /NOT live/.test(w.text));

    const a1 = (await hydrate(TEST_SLUG)).agents[0];
    check('one new version', a1.versions.length === a0.versions.length + 1,
      `${a0.versions.length} → ${a1.versions.length}`);
    check('ACTIVE moved', a1.activeVersionId !== a0.activeVersionId);
    check('PUBLISHED did not move', (a1.publishedVersionId ?? null) === (a0.publishedVersionId ?? null));
    check('THE BUILDER SHOWS THE EDIT (working copy)', a1.spec === edited.spec, a1.spec);
    check('previous version intact',
      a1.versions.find(v => v.id === a0.activeVersionId).body.spec !== edited.spec);
    const dirty1 = agentDirty(a1);
    check('no phantom "unsaved changes"', dirty1.length === 0, dirty1.join(', '));

    // ── crew write ──
    section('crew write');
    const c0 = a1.crews[0];
    const crewEdited = JSON.parse(JSON.stringify(c0.versions.find(v => v.id === c0.viewingVersionId).body));
    crewEdited.spec = `Crew edited by the battery at ${stamp}`;
    const wc = await post(`/agents/${TEST_SLUG}/crews/${c0.id}`, { body: crewEdited, description: 'battery' });
    check('200', wc.status === 200, `status ${wc.status}`);

    const c1 = (await hydrate(TEST_SLUG)).agents[0].crews.find(c => c.id === c0.id);
    check('one new version', c1.versions.length === c0.versions.length + 1);
    check('ACTIVE moved', c1.activeVersionId !== c0.activeVersionId);
    check('PUBLISHED did not move', (c1.publishedVersionId ?? null) === (c0.publishedVersionId ?? null));
    check('THE BUILDER SHOWS THE EDIT', c1.spec === crewEdited.spec);
    check('no phantom "unsaved changes"', !crewDirty(c1));

    // ── create ──
    section('create');
    await removeIfPresent(BORN_CLEAN_SLUG);
    const cr = await post('/agents', { name: 'ZZ MCP born clean' });
    check('200', cr.status === 200, `status ${cr.status}`);
    const born = await hydrate(BORN_CLEAN_SLUG);
    check('exists under the derived slug', !!born, BORN_CLEAN_SLUG);
    if (born) {
      const d = agentDirty(born.agents[0]);
      check('clean at birth — no phantom notice', d.length === 0, d.join(', '));
      check('its crew is clean too', !crewDirty(born.agents[0].crews[0]));
    }
    check('duplicate name → 409', (await post('/agents', { name: 'ZZ MCP born clean' })).status === 409);
    check('no name → 400', (await post('/agents', {})).status === 400);
    await removeIfPresent(BORN_CLEAN_SLUG);
    check('throwaway removed', !(await hydrate(BORN_CLEAN_SLUG)));

    // ── refusals ──
    section('refusals');
    check('string body → 400', (await post(`/agents/${TEST_SLUG}`, { body: 'nope' })).status === 400);
    check('missing body → 400', (await post(`/agents/${TEST_SLUG}`, {})).status === 400);
    const badCrew = await post(`/agents/${TEST_SLUG}/crews/crew_nope`, { body: {} });
    check('unknown crew → 404 naming the real crews',
      badCrew.status === 404 && badCrew.text.includes('crew_zzmcptest'), badCrew.text.slice(0, 80));
    check('write to unknown agent → 404',
      (await post('/agents/definitely-not-real-xyz', { body: {} })).status === 404);
  } catch (err) {
    console.error('\nBATTERY ERROR:', err.message);
    fails++;
  } finally {
    await removeIfPresent(BORN_CLEAN_SLUG).catch(() => {});
    srv.close();
    console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
    await db.close().catch(() => {});
    process.exit(fails === 0 ? 0 : 1);
  }
})();
