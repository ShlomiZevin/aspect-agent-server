/**
 * Lybi Gate — the field policy (gate_policy_versions).
 *
 * One row per version. At most one 'draft' (what the bank is editing); the
 * newest 'signed' row is what every record is processed with. Signing turns
 * the draft into the next signed version, with an ECDSA signature over its
 * canonical JSON (crypto.signPolicy) — so a version can be verified later.
 *
 * A field the signed policy does not know is HIDDEN, and added to the draft
 * (flagged isNew, with Lybi's suggestion) so the bank sees it and decides.
 * With no signed version at all, every field is hidden.
 *
 * fields = [{ field, detected, by: 'detector'|'name'|'none', action, isNew? }]
 */

const db = require('../../services/db.pg');
const { classify, ACTIONS, canConvert } = require('./detect');
const { signPolicy, verifyPolicy } = require('./crypto');

class PolicyError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const shape = r => r && ({
  id: r.id, version: r.version, status: r.status, fields: r.fields || [], signature: r.signature,
  signedBy: r.signed_by, signedAt: r.signed_at, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

async function signed() {
  const { rows } = await db.query(`SELECT * FROM gate_policy_versions WHERE status = 'signed' ORDER BY version DESC LIMIT 1`);
  return shape(rows[0]) || null;
}

async function draft() {
  const { rows } = await db.query(`SELECT * FROM gate_policy_versions WHERE status = 'draft' LIMIT 1`);
  return shape(rows[0]) || null;
}

/** The draft, created from the signed version (or empty) when there is none. */
async function ensureDraft(actor) {
  const d = await draft();
  if (d) return d;
  const s = await signed();
  const { rows: [{ next }] } = await db.query(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM gate_policy_versions`);
  const fields = (s ? s.fields : []).map(({ isNew, ...f }) => f);
  const { rows } = await db.query(
    `INSERT INTO gate_policy_versions (version, status, fields, created_by) VALUES ($1, 'draft', $2, $3)
     ON CONFLICT DO NOTHING RETURNING *`,
    [next, JSON.stringify(fields), actor || null],
  );
  return shape(rows[0]) || draft(); // lost a race → the other one's draft
}

function validateFields(fields) {
  if (!Array.isArray(fields)) throw new PolicyError(400, 'bad_policy', 'fields must be a list');
  const seen = new Set();
  for (const f of fields) {
    if (!f || typeof f.field !== 'string' || !f.field.trim()) throw new PolicyError(400, 'bad_policy', 'every field needs a name');
    if (seen.has(f.field)) throw new PolicyError(400, 'bad_policy', `field "${f.field}" appears twice`);
    seen.add(f.field);
    if (!ACTIONS.includes(f.action)) throw new PolicyError(400, 'bad_policy', `field "${f.field}": unknown action "${f.action}"`);
    if (f.action === 'conv' && !canConvert(f.detected)) throw new PolicyError(400, 'bad_policy', `field "${f.field}" has no "convert"`);
  }
}

/** Change actions in the draft. Only `action` (and removing isNew) is the bank's to set; detection stays Lybi's. */
async function updateDraft(changes, actor) {
  if (!Array.isArray(changes)) throw new PolicyError(400, 'bad_policy', 'changes must be a list of { field, action }');
  const d = await ensureDraft(actor);
  const byName = new Map(d.fields.map(f => [f.field, { ...f }]));
  for (const c of changes) {
    const f = byName.get(c && c.field);
    if (!f) throw new PolicyError(404, 'no_field', `no field "${c && c.field}" in the draft`);
    f.action = c.action;
    delete f.isNew;
  }
  const fields = [...byName.values()];
  validateFields(fields);
  const { rows } = await db.query(
    `UPDATE gate_policy_versions SET fields = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [JSON.stringify(fields), d.id],
  );
  return shape(rows[0]);
}

/**
 * Add the fields of these rows that the draft does not know yet, with
 * Lybi's detection and suggested action (isNew = the bank hasn't decided).
 * @returns {Promise<{ draft, added: string[] }>}
 */
async function learn(rows, actor) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object');
  const names = [...new Set(list.flatMap(r => Object.keys(r)))].slice(0, 100);
  // Open a draft only when something is new — known fields leave the policy as it is.
  const current = (await draft()) || (await signed());
  const knownNow = new Set((current ? current.fields : []).map(f => f.field));
  if (names.every(n => knownNow.has(n))) return { draft: await draft(), added: [] };
  const d = await ensureDraft(actor);
  const known = new Set(d.fields.map(f => f.field));
  const added = [];
  const fields = [...d.fields];
  for (const name of names) {
    if (known.has(name)) continue;
    const c = await classify(name, list.map(r => r[name]));
    fields.push({ field: name, detected: c.detected, by: c.by, action: c.action, isNew: true });
    added.push(name);
  }
  if (!added.length) return { draft: d, added };
  const { rows: out } = await db.query(
    `UPDATE gate_policy_versions SET fields = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [JSON.stringify(fields), d.id],
  );
  return { draft: shape(out[0]), added };
}

/**
 * Sign the draft: it becomes the active version. Fields Lybi added that the
 * bank hasn't decided on (isNew) block signing unless acceptNew = "take
 * Lybi's suggestions for them".
 */
async function sign(actor, { acceptNew = false } = {}) {
  const d = await draft();
  if (!d) throw new PolicyError(409, 'no_draft', 'nothing to sign — there is no draft');
  if (!d.fields.length) throw new PolicyError(409, 'empty_policy', 'the draft has no fields');
  const undecided = d.fields.filter(f => f.isNew).map(f => f.field);
  if (undecided.length && !acceptNew) {
    const err = new PolicyError(409, 'undecided_fields', `${undecided.length} new field(s) wait for a decision: ${undecided.join(', ')}`);
    err.fields = undecided;
    throw err;
  }
  const fields = d.fields.map(({ isNew, ...f }) => f);
  validateFields(fields);
  const signature = signPolicy(d.version, fields);
  const { rows } = await db.query(
    `UPDATE gate_policy_versions SET status = 'signed', fields = $1, signature = $2, signed_by = $3, signed_at = now(), updated_at = now()
     WHERE id = $4 AND status = 'draft' RETURNING *`,
    [JSON.stringify(fields), signature, actor || null, d.id],
  );
  if (!rows[0]) throw new PolicyError(409, 'no_draft', 'the draft changed while signing — try again');
  return shape(rows[0]);
}

async function versions() {
  const { rows } = await db.query(`SELECT * FROM gate_policy_versions ORDER BY version DESC LIMIT 50`);
  return rows.map(shape).map(v => ({ ...v, valid: v.status === 'signed' ? verifyPolicy(v.version, v.fields, v.signature) : null }));
}

async function verify(version) {
  const { rows } = await db.query(`SELECT * FROM gate_policy_versions WHERE version = $1`, [Number(version)]);
  const v = shape(rows[0]);
  if (!v) throw new PolicyError(404, 'no_version', `no version ${version}`);
  if (v.status !== 'signed') return { version: v.version, status: v.status, valid: null };
  return { version: v.version, status: v.status, signedBy: v.signedBy, signedAt: v.signedAt, valid: verifyPolicy(v.version, v.fields, v.signature) };
}

/** Field → its entry in a policy (null = unknown → hide). */
function entryOf(policy, field) {
  return (policy && policy.fields.find(f => f.field === field)) || null;
}

module.exports = { PolicyError, signed, draft, ensureDraft, updateDraft, learn, sign, versions, verify, entryOf };
