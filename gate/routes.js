/**
 * Lybi Gate (beta) — the API, mounted at /api/gate (one line in server.js).
 * A side project: nothing here reads or writes agents, crews or the runtime.
 * Client: the management center page (aspect-react-client/src/manage/pages/GatePage/).
 *
 * The bank's systems (an API key, POST only):
 *   POST /v1/records            Authorization: Bearer gk_live_…
 *                               { records: [ {...}, ... ], refField? } (or one object)
 *                               → 201 { policyVersion, records: [{ id, externalRef, actions }], newFields }
 *                               401 'bad_key' · 409 'no_bank_key' · 400/413 on a bad body
 *
 * The management center (its signed-in session — manageSession / manageAccess, read-only):
 *   GET    /overview
 *   GET    /policy                       { signed, draft, publicKeyPem }
 *   PUT    /policy/draft                 { changes: [{ field, action }] }
 *   POST   /policy/learn                 { records: [...] } → fields the draft didn't know, with suggestions
 *   POST   /policy/sign                  { acceptNew? } the draft → the next signed version
 *                                        (409 'undecided_fields' + fields while Lybi-added fields wait for a decision)
 *   GET    /policy/versions              every version + whether its signature verifies
 *   GET    /keys · POST /keys { name } (the key is returned ONCE) · DELETE /keys/:id (revoke)
 *   GET    /connections · POST /connections · PUT /connections/:id · DELETE /connections/:id
 *   POST   /connections/:id/test         { ping } → reachable?
 *   POST   /connections/:id/call         { recordId } → what was sent, and (lookup) the answer after the gate
 *   POST   /setup/mock-bank              connect the mock bank: its public key + a lookup and a handoff connection
 *   POST   /upload                       { fileName, records } — a file, through the same pipeline
 *   GET    /records[?source=] · GET /records/:id
 *   POST   /test                         { record, useDraft? } → a dry run, nothing stored
 *   GET    /log[?kind=&limit=]
 *   GET    /sample                       invented sample records
 *
 * The mock bank (its own secret): /mock-bank/* — see mockBank/router.js.
 */

const express = require('express');
const policy = require('./services/policy');
const records = require('./services/records');
const keys = require('./services/keys');
const connections = require('./services/connections');
const bankKeys = require('./services/bankKeys');
const log = require('./services/log');
const crypto = require('./services/crypto');
const bank = require('./mockBank/bank');
const { sampleRecords } = require('./sample');
const db = require('../services/db.pg');

/** The default door: a signed-in management-center user (any grant). */
async function manageDoor(req, res, next) {
  try {
    const manageSession = require('../builder/services/manageSession');
    const manageAccess = require('../builder/services/manageAccess');
    const who = await manageSession.verify(manageSession.fromRequest(req));
    if (!who) return res.status(401).json({ error: 'Sign in first', code: 'signed_out' });
    const grants = await manageAccess.grantsFor(who.email);
    if (!grants) return res.status(403).json({ error: 'No access for this address', code: 'no_access' });
    req.gateActor = who.email;
    next();
  } catch (err) {
    fail(res, err, 'checking the session');
  }
}

function fail(res, err, what) {
  if (err && err.code === 'gate_not_configured') return res.status(503).json({ error: err.message, code: err.code });
  if (err && err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.fields && { fields: err.fields }) });
  console.error(`[gate] ${what} failed:`, err);
  res.status(500).json({ error: err && err.message ? err.message : 'error' });
}

const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };

function baseUrl(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}${req.baseUrl}`;
}

/**
 * @param {{ requireAdmin?: Function }} [opts]  requireAdmin must set req.gateActor (default: the management center's session)
 */
function createGateRouter({ requireAdmin = manageDoor } = {}) {
  const router = express.Router();

  router.use('/mock-bank', require('./mockBank/router'));

  // ── The bank's systems ────────────────────────────────────────────
  router.post('/v1/records', async (req, res) => {
    const started = Date.now();
    let key = null;
    try {
      crypto.assertConfigured();
      key = await keys.authenticate(req.get('authorization'));
      if (!key) {
        await log.write({ kind: 'inbound', direction: 'in', status: 'rejected', httpStatus: 401, summary: { reason: 'bad or revoked key' }, durationMs: Date.now() - started });
        return res.status(401).json({ error: 'missing, unknown or revoked key', code: 'bad_key' });
      }
      const body = req.body;
      const rows = Array.isArray(body) ? body : Array.isArray(body && body.records) ? body.records : body && typeof body === 'object' ? [body] : null;
      const refField = (body && typeof body.refField === 'string' && body.refField) || 'leadId';
      const out = await records.ingest(rows, { source: 'api', keyId: key.id, refField });
      await log.write({
        kind: 'inbound', direction: 'in', status: 'ok', httpStatus: 201, actor: key.prefix, policyVersion: out.policyVersion,
        recordId: out.records.length === 1 ? out.records[0].id : null, durationMs: Date.now() - started,
        summary: { key: key.name, records: out.records.length, newFields: out.newFields, actions: out.records[0] ? countActions(out.records) : {} },
      });
      res.status(201).json(out);
    } catch (err) {
      if (err && err.status) {
        await log.write({ kind: 'inbound', direction: 'in', status: 'rejected', httpStatus: err.status, actor: key && key.prefix, summary: { reason: err.code }, durationMs: Date.now() - started });
      }
      fail(res, err, 'inbound records');
    }
  });

  // ── The management center ─────────────────────────────────────────
  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/overview', wrap('overview', async (_req, res) => {
    let configured = true;
    try { crypto.assertConfigured(); } catch { configured = false; }
    const [signed, draft, bankKey, keyList, conns, counts, today] = await Promise.all([
      policy.signed(), policy.draft(), bankKeys.active(), keys.list(), connections.list(),
      db.query(`SELECT source, count(*)::int AS n FROM gate_records GROUP BY source`),
      db.query(`SELECT kind, status, count(*)::int AS n FROM gate_log WHERE at >= date_trunc('day', now()) GROUP BY kind, status`),
    ]);
    res.json({
      configured,
      bankKey: bankKey && { name: bankKey.name, fingerprint: bankKey.fingerprint, createdAt: bankKey.createdAt },
      policy: {
        signed: signed && { version: signed.version, signedBy: signed.signedBy, signedAt: signed.signedAt, fields: signed.fields.length },
        draft: draft && { version: draft.version, fields: draft.fields.length, newFields: draft.fields.filter(f => f.isNew).length },
      },
      keys: { active: keyList.filter(k => k.active).length, total: keyList.length },
      connections: conns.map(c => ({ id: c.id, kind: c.kind, name: c.name, enabled: c.enabled, lastStatus: c.lastStatus, lastCalledAt: c.lastCalledAt })),
      records: Object.fromEntries(counts.rows.map(r => [r.source, r.n])),
      today: today.rows,
    });
  }));

  admin.get('/policy', wrap('policy', async (_req, res) => {
    let publicKeyPem = null;
    try { publicKeyPem = crypto.signingPublicKeyPem(); } catch { /* not configured */ }
    res.json({ signed: await policy.signed(), draft: await policy.draft(), publicKeyPem });
  }));
  admin.put('/policy/draft', wrap('policy draft', async (req, res) => {
    const d = await policy.updateDraft(req.body && req.body.changes, req.gateActor);
    res.json({ draft: d });
  }));
  admin.post('/policy/learn', wrap('policy learn', async (req, res) => {
    const { draft, added } = await policy.learn(req.body && req.body.records, req.gateActor);
    res.json({ draft, added });
  }));
  admin.post('/policy/sign', wrap('policy sign', async (req, res) => {
    crypto.assertConfigured();
    const s = await policy.sign(req.gateActor, { acceptNew: !!(req.body && req.body.acceptNew) });
    await log.write({ kind: 'policy_signed', direction: 'admin', status: 'ok', actor: req.gateActor, policyVersion: s.version, summary: { fields: s.fields.length } });
    res.json({ signed: s });
  }));
  admin.get('/policy/versions', wrap('policy versions', async (_req, res) => res.json({ versions: await policy.versions() })));

  admin.get('/keys', wrap('keys', async (_req, res) => res.json({ keys: await keys.list() })));
  admin.post('/keys', wrap('create key', async (req, res) => {
    const k = await keys.create(req.body && req.body.name, req.gateActor);
    await log.write({ kind: 'key_created', direction: 'admin', status: 'ok', actor: req.gateActor, summary: { name: k.name, prefix: k.prefix } });
    res.status(201).json({ key: k });
  }));
  admin.delete('/keys/:id', wrap('revoke key', async (req, res) => {
    const k = await keys.revoke(req.params.id);
    if (!k) return res.status(404).json({ error: 'no such active key', code: 'no_key' });
    await log.write({ kind: 'key_revoked', direction: 'admin', status: 'ok', actor: req.gateActor, summary: { name: k.name, prefix: k.prefix } });
    res.json({ key: k });
  }));

  admin.get('/connections', wrap('connections', async (_req, res) => res.json({ connections: await connections.list() })));
  admin.post('/connections', wrap('create connection', async (req, res) => {
    const c = await connections.create(req.body || {}, req.gateActor);
    await log.write({ kind: 'connection_saved', direction: 'admin', status: 'ok', actor: req.gateActor, connectionId: c.id, summary: { name: c.name, kind: c.kind } });
    res.status(201).json({ connection: c });
  }));
  admin.put('/connections/:id', wrap('update connection', async (req, res) => {
    const c = await connections.update(req.params.id, req.body || {});
    await log.write({ kind: 'connection_saved', direction: 'admin', status: 'ok', actor: req.gateActor, connectionId: c.id, summary: { name: c.name, kind: c.kind } });
    res.json({ connection: c });
  }));
  admin.delete('/connections/:id', wrap('delete connection', async (req, res) => {
    await connections.remove(req.params.id);
    await log.write({ kind: 'connection_deleted', direction: 'admin', status: 'ok', actor: req.gateActor, connectionId: req.params.id });
    res.json({ ok: true });
  }));
  admin.post('/connections/:id/test', wrap('test connection', async (req, res) => res.json(await connections.test(req.params.id, req.gateActor))));
  admin.post('/connections/:id/call', wrap('call connection', async (req, res) => {
    crypto.assertConfigured();
    res.json(await connections.call(req.params.id, req.body && req.body.recordId, req.gateActor));
  }));

  admin.post('/setup/mock-bank', wrap('connect the mock bank', async (req, res) => {
    crypto.assertConfigured();
    const base = baseUrl(req);
    await bank.ensure();
    // Take the bank's public key the way a real one would arrive: from the bank.
    const pk = await fetch(`${base}/mock-bank/public-key`);
    if (!pk.ok) throw Object.assign(new Error(`the mock bank did not answer (${pk.status})`), { status: 502, code: 'bank_unreachable' });
    const bankKey = await bankKeys.register('בנק הדגמה', await pk.text());
    const secret = await bank.rotateSecret();
    const existing = await connections.list();
    const want = [
      { kind: 'lookup', name: 'בנק הדגמה – בדיקת לקוח', url: `${base}/mock-bank/customers/lookup`, sendFields: ['leadId', 'passportNumber'] },
      { kind: 'handoff', name: 'בנק הדגמה – העברה בסיום', url: `${base}/mock-bank/handoff`, sendFields: ['*'] },
    ];
    const saved = [];
    for (const w of want) {
      const c = { ...w, method: 'POST', authHeader: 'Authorization', authSecret: `Bearer ${secret}` };
      const cur = existing.find(e => e.kind === w.kind && e.url === w.url);
      saved.push(cur ? await connections.update(cur.id, c) : await connections.create(c, req.gateActor));
    }
    await log.write({ kind: 'bank_connected', direction: 'admin', status: 'ok', actor: req.gateActor, summary: { bank: bankKey.name, fingerprint: bankKey.fingerprint, connections: saved.map(s => s.name) } });
    res.json({ bankKey: { name: bankKey.name, fingerprint: bankKey.fingerprint }, connections: saved });
  }));

  admin.post('/upload', wrap('upload', async (req, res) => {
    crypto.assertConfigured();
    const started = Date.now();
    const fileName = String((req.body && req.body.fileName) || 'file').slice(0, 120);
    const out = await records.ingest(req.body && req.body.records, { source: 'file', refField: (req.body && req.body.refField) || 'leadId' });
    await log.write({
      kind: 'file', direction: 'in', status: 'ok', httpStatus: 201, actor: req.gateActor, policyVersion: out.policyVersion, durationMs: Date.now() - started,
      summary: { file: fileName, records: out.records.length, newFields: out.newFields, actions: countActions(out.records) },
    });
    res.status(201).json(out);
  }));

  admin.get('/records', wrap('records', async (req, res) => res.json({ records: await records.list({ limit: req.query.limit, source: req.query.source || null }) })));
  admin.get('/records/:id', wrap('record', async (req, res) => {
    const r = await records.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'no such record', code: 'no_record' });
    res.json({ record: r });
  }));

  admin.post('/test', wrap('test', async (req, res) => {
    crypto.assertConfigured();
    const out = await records.dryRun(req.body && req.body.record, { useDraft: !!(req.body && req.body.useDraft) });
    await log.write({ kind: 'test', direction: 'admin', status: 'ok', actor: req.gateActor, policyVersion: out.policyVersion, summary: { policy: out.policyStatus, actions: log.actionCounts(out.stored), unknown: out.unknown } });
    res.json(out);
  }));

  admin.get('/log', wrap('log', async (req, res) => res.json({ log: await log.list({ limit: req.query.limit, kind: req.query.kind || null }) })));
  admin.get('/sample', wrap('sample', async (_req, res) => res.json({ records: sampleRecords() })));

  router.use(admin);
  return router;
}

/** { action: count } over a batch's per-record actions. */
function countActions(recs) {
  const c = {};
  for (const r of recs) for (const a of Object.values(r.actions || {})) c[a] = (c[a] || 0) + 1;
  return c;
}

module.exports = { createGateRouter };
