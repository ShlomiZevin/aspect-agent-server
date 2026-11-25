/**
 * Lybi Gate — records through the signed policy (gate_records).
 *
 * transform(raw) applies the signed policy field by field:
 *   pass  → { a, v }            the value, as is
 *   hide  → { a }               nothing kept
 *   token → { a, t, enc }       the token + the value sealed for the bank
 *   enc   → { a, enc }          sealed for the bank only
 *   conv  → { a, v, enc }       the reduced value + the original sealed for the bank
 * A field the signed policy doesn't know → hide (and it is added to the draft).
 *
 * modelView(data) is what an AI model may receive: pass / token / conv values;
 * hidden and encrypted fields are absent. The raw input lives only in memory
 * for the length of the call.
 */

const db = require('../../services/db.pg');
const policy = require('./policy');
const bankKeys = require('./bankKeys');
const log = require('./log');
const { token, encryptForBank } = require('./crypto');
const { convert } = require('./detect');

class RecordError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const MAX_RECORDS = 500;
const MAX_FIELDS = 100;

function asText(v) {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Validate an incoming list of flat objects. */
function cleanRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new RecordError(400, 'no_records', 'send { records: [ {...}, ... ] } with at least one record');
  if (rows.length > MAX_RECORDS) throw new RecordError(413, 'too_many', `at most ${MAX_RECORDS} records per call`);
  return rows.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new RecordError(400, 'bad_record', `record ${i + 1} is not an object`);
    const keys = Object.keys(r);
    if (keys.length > MAX_FIELDS) throw new RecordError(400, 'bad_record', `record ${i + 1} has more than ${MAX_FIELDS} fields`);
    return r;
  });
}

async function transform(raw, pol, bankKey) {
  const data = {};
  const unknown = [];
  for (const [field, value] of Object.entries(raw)) {
    const v = asText(value);
    const entry = policy.entryOf(pol, field);
    if (!entry) unknown.push(field);
    const action = entry ? entry.action : 'hide';
    if (action === 'hide') { data[field] = { a: 'hide' }; continue; }
    if (!v.trim()) { data[field] = { a: action, empty: true }; continue; }
    if (action === 'pass') { data[field] = { a: 'pass', v }; continue; }
    if (!bankKey) throw new RecordError(409, 'no_bank_key', 'the bank\'s public key is not registered yet — connect the bank first');
    const enc = encryptForBank(bankKey.publicKeyPem, v);
    if (action === 'enc') data[field] = { a: 'enc', enc };
    else if (action === 'token') data[field] = { a: 'token', t: token(entry.detected, v), enc };
    else data[field] = { a: 'conv', v: await convert(entry.detected, v), enc };
  }
  return { data, unknown };
}

function modelView(data) {
  const out = {};
  for (const [k, x] of Object.entries(data || {})) {
    if (x.empty) continue;
    if (x.a === 'pass' || x.a === 'conv') out[k] = x.v;
    else if (x.a === 'token') out[k] = x.t;
  }
  return out;
}

const shape = r => ({
  id: r.id, source: r.source, externalRef: r.external_ref, keyId: r.key_id, connectionId: r.connection_id,
  parentId: r.parent_id, policyVersion: r.policy_version, data: r.data, modelView: modelView(r.data), createdAt: r.created_at,
});

/**
 * Process and store records. source: 'api' | 'file' | 'bank'.
 * @returns {Promise<{ policyVersion, records: [{ id, externalRef, actions }], newFields }>}
 */
async function ingest(rows, { source, keyId = null, connectionId = null, parentId = null, refField = null }) {
  const list = cleanRows(rows);
  const { added } = await policy.learn(list);
  const pol = await policy.signed();
  const bankKey = await bankKeys.active();
  const out = [];
  for (const raw of list) {
    const { data } = await transform(raw, pol, bankKey);
    const ref = refField && raw[refField] != null ? asText(raw[refField]) : null;
    const { rows: ins } = await db.query(
      `INSERT INTO gate_records (source, external_ref, key_id, connection_id, parent_id, policy_version, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [source, ref, keyId, connectionId, parentId, pol ? pol.version : null, JSON.stringify(data)],
    );
    out.push({ id: ins[0].id, externalRef: ref, actions: Object.fromEntries(Object.entries(data).map(([k, x]) => [k, x.a])) });
  }
  return { policyVersion: pol ? pol.version : null, records: out, newFields: added };
}

/** Dry run: what would be stored and what the model would get — nothing saved. */
async function dryRun(raw, { useDraft = false } = {}) {
  const [r] = cleanRows([raw]);
  const pol = useDraft ? (await policy.draft()) || (await policy.signed()) : await policy.signed();
  const { data, unknown } = await transform(r, pol, await bankKeys.active());
  return { policyVersion: pol ? pol.version : null, policyStatus: pol ? pol.status : null, stored: data, modelView: modelView(data), unknown };
}

async function list({ limit = 50, source = null } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const { rows } = source
    ? await db.query(`SELECT * FROM gate_records WHERE source = $1 ORDER BY created_at DESC LIMIT $2`, [source, n])
    : await db.query(`SELECT * FROM gate_records WHERE source <> 'bank' ORDER BY created_at DESC LIMIT $1`, [n]);
  return rows.map(shape);
}

async function get(id) {
  const { rows } = await db.query(`SELECT * FROM gate_records WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: answers } = await db.query(`SELECT * FROM gate_records WHERE parent_id = $1 ORDER BY created_at DESC`, [id]);
  return { ...shape(rows[0]), answers: answers.map(shape) };
}

module.exports = { RecordError, ingest, dryRun, list, get, modelView, transform, asText, actionCounts: log.actionCounts };
