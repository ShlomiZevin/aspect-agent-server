#!/usr/bin/env node
/**
 * Build (or refresh) a Vertex Lab agent on Lybi Staging — the lab agents for
 * comparing the Direct and Vertex model routes (board #996,
 * scripts/compare-vertex-direct.js).
 *
 * Anthropic models only, on every add-on. The definition lives in a fixture
 * under scripts/fixtures/ (default vertex-lab-agent.json; the all-Sonnet
 * variant is vertex-lab-sonnet-agent.json); this script only sends it.
 *
 *   node scripts/setup-vertex-lab.js [--fixture=vertex-lab-sonnet-agent.json]   # create if missing, else save as new versions
 *   node scripts/setup-vertex-lab.js --dry                                       # print what it would do
 *
 * Fixture shape: { name, slug, agent: <agent body keys>, crews: { <key>: { name, description, addons } } }.
 * The FIRST crew is the one created with the agent. In an add-on, `"__CREW_ID:<key>__"`
 * becomes that crew's real id (Rules transitions); a `prompt` given as an array is
 * joined, and an array item `{ "file": "x.md" }` inlines scripts/fixtures/x.md.
 *
 * Writes through the staging server's own doors, never a database:
 *   - Builder MCP  POST /builder/mcp/agents                   (create, minted ids)
 *   - Builder API  POST /api/builder/agents/:id/crews         (add further crews — the MCP has no "add crew")
 *   - Builder MCP  POST /builder/mcp/agents/:slug[/crews/:id] (bodies, normalised, new versions)
 *   - Builder API  PATCH /api/builder/agents/:id              (into the Builder domain "Shlomi")
 * Nothing is published: the harness runs the ACTIVE version.
 */
const fs = require('fs');
const path = require('path');

const STAGING = 'https://lybi-server-700084613835.me-west1.run.app';
const SHLOMI_DOMAIN = 'ws_8bhctox2mqhlzb43'; // Builder domain "Shlomi" on staging
const args = process.argv.slice(2);
const arg = (name, dflt) => { const h = args.find(a => a.startsWith(`--${name}=`)); return h ? h.slice(name.length + 3) : dflt; };
const DRY = args.includes('--dry');
const SERVER = arg('server', STAGING);
if (SERVER !== STAGING && !args.includes('--i-know-this-is-not-staging')) {
  console.error(`Refusing: this script writes an agent and is meant for Lybi Staging (${STAGING}).`);
  process.exit(1);
}

const FIXTURES = path.join(__dirname, 'fixtures');
const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, arg('fixture', 'vertex-lab-agent.json')), 'utf8'));
const crewDefs = Object.entries(fx.crews).map(([key, def]) => ({ key, ...def }));
const rid = p => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

/** Prompts given as arrays are joined; { file } items are inlined. */
function inlinePrompts(addons) {
  return addons.map(a => {
    const p = a.config && a.config.prompt;
    if (!Array.isArray(p)) return a;
    const text = p.map(part => (typeof part === 'string' ? part : fs.readFileSync(path.join(FIXTURES, part.file), 'utf8').replace(/\r\n/g, '\n').trim())).join('');
    return { ...a, config: { ...a.config, prompt: text } };
  });
}

async function call(method, url, body) {
  if (DRY && method !== 'GET') { console.log(`[dry] ${method} ${url}`); return { status: 200, text: '', json: null }; }
  const r = await fetch(SERVER + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text answer */ }
  return { status: r.status, text, json };
}
function must(res, what) {
  if (res.status >= 300) { console.error(`${what} failed: HTTP ${res.status}\n${res.text.slice(0, 1500)}`); process.exit(1); }
  return res;
}
async function hydrate() {
  const r = await call('GET', `/api/builder/projects?agentSlug=${fx.slug}&ownerUserId=vertex-lab-setup`);
  return r.status === 200 && r.json && r.json.agents ? r.json.agents[0] : null;
}

(async () => {
  let agent = await hydrate();
  if (!agent) {
    console.log(`Creating "${fx.name}" (${fx.slug}) on ${SERVER} …`);
    const res = must(await call('POST', '/builder/mcp/agents', {
      name: fx.name, slug: fx.slug,
      body: { ...fx.agent },
      crew: { name: crewDefs[0].name, description: crewDefs[0].description },
    }), 'create agent');
    console.log(res.text.split('\n')[0]);
    if (DRY) return;
    agent = await hydrate();
  }
  if (!agent) { console.error('Agent not readable after create.'); process.exit(1); }

  // Map every fixture crew to a real crew (the first is the agent's default crew).
  const ids = {};
  for (const [i, def] of crewDefs.entries()) {
    let crew = agent.crews.find(c => c.name === def.name) || (i === 0 ? agent.crews.find(c => c.id === agent.defaultCrewId) : null);
    if (!crew) {
      const crewId = rid('crew');
      console.log(`Adding crew "${def.name}" (${crewId}) …`);
      must(await call('POST', `/api/builder/agents/${agent.id}/crews`, {
        crewId, versionId: rid('ver'),
        body: { name: def.name, description: def.description, spec: '', addons: [], fields: [] },
      }), 'add crew');
      crew = { id: crewId };
    }
    ids[def.key] = crew.id;
  }

  // Agent body (personas, fields, cortex) — whole body, keeps the current route.
  const agentBody = { ...(agent.versions.find(v => v.id === agent.activeVersionId) || {}).body, ...fx.agent, cortex: inlinePrompts(fx.agent.cortex || []) };
  delete agentBody.modelRoute; // absent = keep the current route (MCP keep-rule)
  console.log('Saving the agent body …');
  console.log(must(await call('POST', `/builder/mcp/agents/${fx.slug}`, { body: agentBody, description: `${fx.name}: personas, fields, agent add-ons (all Claude)` }), 'save agent').text.split('\n')[0]);

  const withIds = obj => {
    let s = JSON.stringify(obj);
    for (const [key, id] of Object.entries(ids)) s = s.split(`__CREW_ID:${key}__`).join(id);
    return JSON.parse(s);
  };
  for (const def of crewDefs) {
    console.log(`Saving crew "${def.name}" (${ids[def.key]}) …`);
    const body = withIds({ name: def.name, description: def.description, spec: '', addons: inlinePrompts(def.addons), fields: [] });
    console.log(must(await call('POST', `/builder/mcp/agents/${fx.slug}/crews/${ids[def.key]}`, { body, description: `${fx.name}: ${def.name} crew (all Claude)` }), `save crew ${def.name}`).text.split('\n')[0]);
  }

  console.log('Moving it into the Builder domain "Shlomi" …');
  must(await call('PATCH', `/api/builder/agents/${agent.id}`, { workspaceId: SHLOMI_DOMAIN }), 'move to domain');

  const route = await call('GET', `/builder/mcp/agents/${fx.slug}/model-route`);
  console.log('\n' + route.text.slice(0, 1200));
  console.log(`\nBuilder: https://lybi-staging.web.app/${fx.slug}/builder`);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
