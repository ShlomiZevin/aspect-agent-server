/**
 * Lybi Gate — the bank's APIs that Lybi calls (gate_connections).
 *
 * kind 'lookup'  : a question in the middle of a conversation (e.g. "is this
 *                  person already a customer?"). The bank's ANSWER goes through
 *                  the same signed policy before anything else sees it, and is
 *                  stored as a record (source 'bank') under the record it was
 *                  about.
 * kind 'handoff' : the end of the journey — the record goes to the bank.
 *
 * What leaves Lybi for each field in send_fields ('*' = every field) follows
 * the record's stored form — never a raw value unless the policy passes it:
 *   pass → { value } · token → { token, enc } · enc → { enc } · conv → { value, enc } · hide → not sent
 *
 * The request body: { ref, fields: { <field>: {...} } }. Auth: one header
 * (e.g. Authorization: Bearer …) whose value is sealed with GATE_SECRET_KEY.
 * URLs must be https, or http on localhost (the local harness).
 */

const db = require('../../services/db.pg');
const records = require('./records');
const log = require('./log');
const { seal, open } = require('./crypto');

class ConnectionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const TIMEOUT_MS = 10000;

const shape = r => ({
  id: r.id, kind: r.kind, name: r.name, method: r.method, url: r.url, sendFields: r.send_fields || [],
  authHeader: r.auth_header, hasSecret: !!r.auth_secret_enc, enabled: r.enabled,
  lastCalledAt: r.last_called_at, lastStatus: r.last_status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

function validate(c) {
  if (!['lookup', 'handoff'].includes(c.kind)) throw new ConnectionError(400, 'bad_connection', 'kind must be lookup or handoff');
  if (!String(c.name || '').trim()) throw new ConnectionError(400, 'bad_connection', 'a connection needs a name');
  let u;
  try { u = new URL(c.url); } catch { throw new ConnectionError(400, 'bad_connection', 'the URL is not valid'); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new ConnectionError(400, 'bad_connection', 'the URL must be https');
  if (c.method && !['GET', 'POST'].includes(c.method)) throw new ConnectionError(400, 'bad_connection', 'method must be GET or POST');
  if (c.sendFields && (!Array.isArray(c.sendFields) || c.sendFields.some(f => typeof f !== 'string'))) throw new ConnectionError(400, 'bad_connection', 'sendFields must be a list of field names');
}

async function list() {
  const { rows } = await db.query(`SELECT * FROM gate_connections ORDER BY created_at`);
  return rows.map(shape);
}

async function getRow(id) {
  const { rows } = await db.query(`SELECT * FROM gate_connections WHERE id = $1`, [id]);
  if (!rows[0]) throw new ConnectionError(404, 'no_connection', 'no such connection');
  return rows[0];
}

async function create(c, actor) {
  validate(c);
  const { rows } = await db.query(
    `INSERT INTO gate_connections (kind, name, method, url, send_fields, auth_header, auth_secret_enc, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [c.kind, c.name.trim(), c.method || 'POST', c.url, JSON.stringify(c.sendFields || []),
      c.authHeader || null, c.authSecret ? seal(c.authSecret) : null, actor || null],
  );
  return shape(rows[0]);
}

async function update(id, c) {
  const cur = shape(await getRow(id));
  const next = { ...cur, ...c };
  validate(next);
  const { rows } = await db.query(
    `UPDATE gate_connections SET name=$1, method=$2, url=$3, send_fields=$4, auth_header=$5,
       auth_secret_enc = CASE WHEN $6::text IS NULL THEN auth_secret_enc ELSE $6 END, enabled=$7, updated_at=now()
     WHERE id=$8 RETURNING *`,
    [next.name.trim(), next.method, next.url, JSON.stringify(next.sendFields || []), next.authHeader || null,
      c.authSecret ? seal(c.authSecret) : null, next.enabled !== false, id],
  );
  return shape(rows[0]);
}

async function remove(id) {
  const { rowCount } = await db.query(`DELETE FROM gate_connections WHERE id = $1`, [id]);
  if (!rowCount) throw new ConnectionError(404, 'no_connection', 'no such connection');
}

/** The outgoing form of one stored field (null = not sent). */
function outgoing(x) {
  if (!x || x.a === 'hide' || x.empty) return null;
  if (x.a === 'pass') return { value: x.v };
  if (x.a === 'token') return { token: x.t, enc: x.enc };
  if (x.a === 'enc') return { enc: x.enc };
  return { value: x.v, enc: x.enc };
}

async function send(row, body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (row.auth_header && row.auth_secret_enc) headers[row.auth_header] = open(row.auth_secret_enc);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const url = row.method === 'GET' ? `${row.url}?q=${encodeURIComponent(JSON.stringify(body))}` : row.url;
    const res = await fetch(url, { method: row.method, headers, body: row.method === 'GET' ? undefined : JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, ok: false, json: null, ms: Date.now() - started, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function stamp(id, status) {
  await db.query(`UPDATE gate_connections SET last_called_at = now(), last_status = $1 WHERE id = $2`, [status, id]);
}

/** A reachability check: { ping: true }, no record data. */
async function test(id, actor) {
  const row = await getRow(id);
  const r = await send(row, { ping: true });
  const status = r.ok ? 'ok' : 'error';
  await stamp(id, r.ok ? `ok ${r.status}` : `error ${r.status || r.error}`);
  await log.write({ kind: 'connection_test', direction: 'out', status, httpStatus: r.status || null, actor, connectionId: id, durationMs: r.ms, summary: { name: row.name, error: r.error || undefined } });
  return { ok: r.ok, httpStatus: r.status, ms: r.ms, error: r.error || (r.ok ? undefined : (r.json && r.json.error) || 'the bank answered with an error') };
}

/**
 * Call a connection about one stored record.
 * @returns {Promise<{ ok, httpStatus, ms, sent, skipped, answer? }>}
 *   sent    = { field: action } of what left Lybi (and in which form)
 *   answer  = lookup: { recordId, stored, modelView, newFields } · handoff: the bank's confirmation
 */
async function call(id, recordId, actor) {
  const row = await getRow(id);
  if (!row.enabled) throw new ConnectionError(409, 'disabled', 'this connection is off');
  const rec = await records.get(recordId);
  if (!rec) throw new ConnectionError(404, 'no_record', 'no such record');

  const wanted = (row.send_fields || []).includes('*') ? Object.keys(rec.data) : (row.send_fields || []);
  const fields = {}; const sent = {}; const skipped = [];
  for (const f of wanted) {
    const o = outgoing(rec.data[f]);
    if (!o) { skipped.push(f); continue; }
    fields[f] = o;
    sent[f] = rec.data[f].a;
  }
  const body = { ref: rec.externalRef || rec.id, fields };
  const r = await send(row, body);
  await stamp(id, r.ok ? `ok ${r.status}` : `error ${r.status || r.error}`);
  await log.write({
    kind: row.kind === 'lookup' ? 'bank_call' : 'handoff', direction: 'out', status: r.ok ? 'ok' : 'error', httpStatus: r.status || null,
    actor, connectionId: id, recordId, durationMs: r.ms,
    summary: { name: row.name, sent, skipped, error: r.error || undefined },
  });
  const result = { ok: r.ok, httpStatus: r.status, ms: r.ms, sent, skipped, request: body };
  if (!r.ok) return { ...result, error: r.error || (r.json && r.json.error) || 'the bank answered with an error' };

  if (row.kind === 'handoff') return { ...result, answer: r.json };

  // A lookup's answer passes the gate before anything else sees it.
  const answer = r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? (r.json.data && typeof r.json.data === 'object' ? r.json.data : r.json) : null;
  if (!answer) {
    await log.write({ kind: 'bank_answer', direction: 'in', status: 'rejected', httpStatus: r.status, actor, connectionId: id, recordId, summary: { name: row.name, reason: 'not a JSON object' } });
    return { ...result, ok: false, error: 'the bank\'s answer is not a JSON object' };
  }
  const ing = await records.ingest([answer], { source: 'bank', connectionId: id, parentId: recordId });
  const stored = await records.get(ing.records[0].id);
  await log.write({
    kind: 'bank_answer', direction: 'in', status: 'ok', httpStatus: r.status, actor, connectionId: id, recordId: stored.id,
    policyVersion: ing.policyVersion, summary: { name: row.name, actions: log.actionCounts(stored.data), newFields: ing.newFields },
  });
  return { ...result, answer: { recordId: stored.id, stored: stored.data, modelView: stored.modelView, newFields: ing.newFields } };
}

module.exports = { ConnectionError, list, create, update, remove, test, call, getRow };
