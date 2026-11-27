#!/usr/bin/env node
/**
 * Build (or refresh) the "Vertex Lab" agent on Lybi Staging — the lab agent
 * for comparing the Direct and Vertex model routes (board #996,
 * scripts/compare-vertex-direct.js).
 *
 * Anthropic models only, on every add-on. The definition lives in
 * scripts/fixtures/vertex-lab-agent.json; this script only sends it.
 *
 *   node scripts/setup-vertex-lab.js            # create if missing, else save the fixture as new versions
 *   node scripts/setup-vertex-lab.js --dry      # print what it would do
 *
 * Writes through the staging server's own doors, never a database:
 *   - Builder MCP  POST /builder/mcp/agents                   (create, minted ids)
 *   - Builder API  POST /api/builder/agents/:id/crews         (add the second crew — the MCP has no "add crew")
 *   - Builder MCP  POST /builder/mcp/agents/:slug[/crews/:id] (bodies, normalised, new versions)
 *   - Builder API  PATCH /api/builder/agents/:id              (into the Builder domain "Shlomi")
 * Nothing is published: the harness runs the ACTIVE version.
 */
const fs = require('fs');
const path = require('path');

const STAGING = 'https://lybi-server-700084613835.me-west1.run.app';
const SHLOMI_DOMAIN = 'ws_8bhctox2mqhlzb43'; // Builder domain "Shlomi" on staging
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const SERVER = (args.find(a => a.startsWith('--server=')) || '').slice(9) || STAGING;
if (SERVER !== STAGING && !args.includes('--i-know-this-is-not-staging')) {
  console.error(`Refusing: this script writes an agent and is meant for Lybi Staging (${STAGING}).`);
  process.exit(1);
}

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vertex-lab-agent.json'), 'utf8'));
const rid = p => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

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
      crew: { name: fx.crews.intake.name, description: fx.crews.intake.description },
    }), 'create agent');
    console.log(res.text.split('\n')[0]);
    if (DRY) return;
    agent = await hydrate();
  }
  if (!agent) { console.error('Agent not readable after create.'); process.exit(1); }

  const intake = agent.crews.find(c => c.name === fx.crews.intake.name) || agent.crews.find(c => c.id === agent.defaultCrewId);
  let plan = agent.crews.find(c => c.name === fx.crews.plan.name);
  if (!plan) {
    const crewId = rid('crew');
    console.log(`Adding crew "${fx.crews.plan.name}" (${crewId}) …`);
    must(await call('POST', `/api/builder/agents/${agent.id}/crews`, {
      crewId, versionId: rid('ver'),
      body: { name: fx.crews.plan.name, description: fx.crews.plan.description, spec: '', addons: [], fields: [] },
    }), 'add crew');
    plan = { id: crewId };
  }

  // Agent body (personas, fields, cortex) — whole body, keeps the current route.
  const agentBody = { ...(agent.versions.find(v => v.id === agent.activeVersionId) || {}).body, ...fx.agent };
  delete agentBody.modelRoute; // absent = keep the current route (MCP keep-rule)
  console.log('Saving the agent body …');
  console.log(must(await call('POST', `/builder/mcp/agents/${fx.slug}`, { body: agentBody, description: 'Vertex Lab: personas, fields, offline summarizer (all Claude)' }), 'save agent').text.split('\n')[0]);

  const withIds = c => JSON.parse(JSON.stringify(c).split('__PLAN_CREW_ID__').join(plan.id));
  for (const [crew, def] of [[intake, fx.crews.intake], [plan, fx.crews.plan]]) {
    console.log(`Saving crew "${def.name}" (${crew.id}) …`);
    const body = withIds({ name: def.name, description: def.description, spec: '', addons: def.addons, fields: [] });
    console.log(must(await call('POST', `/builder/mcp/agents/${fx.slug}/crews/${crew.id}`, { body, description: `Vertex Lab: ${def.name} crew (all Claude)` }), `save crew ${def.name}`).text.split('\n')[0]);
  }

  console.log('Moving it into the Builder domain "Shlomi" …');
  must(await call('PATCH', `/api/builder/agents/${agent.id}`, { workspaceId: SHLOMI_DOMAIN }), 'move to domain');

  const route = await call('GET', `/builder/mcp/agents/${fx.slug}/model-route`);
  console.log('\n' + route.text.slice(0, 1200));
  console.log(`\nBuilder: https://lybi-staging.web.app/${fx.slug}/builder`);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
