#!/usr/bin/env node
/**
 * Proves the production CORS check behaves exactly as before for every
 * existing site, and that partner domains added through /builder/mcp/domains
 * are allowed on top.
 *
 *   node scripts/test-partner-cors.js
 *
 * It does NOT boot server.js (that starts reload self-heal loops against the
 * live customer data DB). Instead it extracts the literal production
 * `app.use(cors({...}))` block from server.js and runs it through the real
 * `cors` package, with the real partner-origins service on the real platform
 * DB. So what is tested is the code that ships, not a copy of it.
 *
 * Adds and then removes one throwaway origin (https://zz-cors-test.example).
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('../services/db.pg');
const partnerOrigins = require('../services/partner-origins.service');

const TEST_ORIGIN = 'https://zz-cors-test.example';

let fails = 0;
const check = (n, c, extra = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!c) fails++;
};

/** The production branch's cors block, verbatim from server.js. */
function productionCorsBlock() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf('// Production CORS (strict)');
  if (start < 0) throw new Error('Could not find the production CORS block in server.js');
  const from = src.indexOf('app.use(cors({', start);
  const to = src.indexOf('}));', from);
  return src.slice(from, to + 4);
}

async function probe(base, origin, method = 'GET') {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (method === 'OPTIONS') {
    headers['Access-Control-Request-Method'] = 'POST';
    headers['Access-Control-Request-Headers'] = 'content-type';
  }
  const r = await fetch(`${base}/api/agents/x/conversations`, { method, headers });
  return { status: r.status, allow: r.headers.get('access-control-allow-origin') };
}

(async () => {
  // Before the DB is up, has() must answer false without throwing — the
  // server takes requests before startServer() finishes.
  let threw = false;
  try { check('before DB init: unknown origin is simply not a partner', partnerOrigins.has(TEST_ORIGIN) === false); }
  catch { threw = true; }
  check('before DB init: has() does not throw', !threw);

  await db.initialize();
  await partnerOrigins.remove(TEST_ORIGIN).catch(() => {});

  const app = express();
  // eslint-disable-next-line no-new-func
  new Function('app', 'cors', 'partnerOrigins', productionCorsBlock())(app, cors, partnerOrigins);
  app.get('/api/agents/:slug/conversations', (_req, res) => res.json({ ok: true }));
  app.post('/api/agents/:slug/conversations', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    console.log('\n── existing sites: unchanged ──');
    for (const o of ['https://lybi.ai', 'https://lybi-prod.web.app', 'https://aspect-agents.web.app',
      'https://freeda-2b4af.web.app', 'https://app.freeda.ai', 'https://primyo.io']) {
      const g = await probe(base, o);
      const p = await probe(base, o, 'OPTIONS');
      check(`${o} allowed (GET + preflight)`, g.status === 200 && g.allow === o && p.status === 204 && p.allow === o,
        `${g.status}/${p.status}`);
    }
    const none = await probe(base, null);
    check('no Origin (curl, servers, apps) allowed', none.status === 200);

    console.log('\n── unknown site: still rejected ──');
    const unk = await probe(base, TEST_ORIGIN);
    check('unregistered origin rejected exactly as before', unk.status === 500 && !unk.allow, `status ${unk.status}`);

    console.log('\n── partner site ──');
    check('normalize strips path/slash and lower-cases',
      partnerOrigins.normalize('HTTPS://ZZ-CORS-TEST.example/') === TEST_ORIGIN);
    check('normalize refuses a path', partnerOrigins.normalize(`${TEST_ORIGIN}/chat`) === null);
    check('normalize refuses plain http off localhost', partnerOrigins.normalize('http://zz.example') === null);
    check('normalize allows http://localhost:5173', partnerOrigins.normalize('http://localhost:5173') === 'http://localhost:5173');

    await partnerOrigins.add(TEST_ORIGIN);
    const g = await probe(base, TEST_ORIGIN);
    const p = await probe(base, TEST_ORIGIN, 'OPTIONS');
    check('registered partner allowed (GET + preflight)',
      g.status === 200 && g.allow === TEST_ORIGIN && p.status === 204, `${g.status}/${p.status}`);

    await partnerOrigins.remove(TEST_ORIGIN);
    check('removed partner rejected again', (await probe(base, TEST_ORIGIN)).status === 500);
    check('existing site still fine after all that', (await probe(base, 'https://lybi.ai')).status === 200);
  } catch (err) {
    console.error('ERROR:', err.message);
    fails++;
  } finally {
    await partnerOrigins.remove(TEST_ORIGIN).catch(() => {});
    srv.close();
    console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
    await db.close().catch(() => {});
    process.exit(fails === 0 ? 0 : 1);
  }
})();
