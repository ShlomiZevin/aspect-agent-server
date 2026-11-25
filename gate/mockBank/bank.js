/**
 * The mock bank — stands in for the bank's side of Lybi Gate so the flow is
 * real end to end: Lybi calls it over HTTP like any bank API.
 *
 * It owns its own key pair (gate_mockbank_keys): Lybi gets only the PUBLIC
 * key; the PRIVATE key is read here and nowhere else. It opens the values
 * Lybi sealed for it, answers lookups with an invented customer, and confirms
 * handoffs WITHOUT echoing the opened values back (Lybi must never see them).
 * Every answer is invented and stable per person.
 */

const crypto = require('crypto');
const db = require('../../services/db.pg');

async function row() {
  const { rows } = await db.query(`SELECT * FROM gate_mockbank_keys ORDER BY id DESC LIMIT 1`);
  return rows[0] || null;
}

const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newSecret = () => `mb_${crypto.randomBytes(24).toString('base64url')}`;

/**
 * Make the bank's key pair on first use.
 * @returns {Promise<{ publicKeyPem: string, secret: string|null }>} secret only when just created
 */
async function ensure() {
  const r = await row();
  if (r) return { publicKeyPem: r.public_key_pem, secret: null };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const secret = newSecret();
  await db.query(
    `INSERT INTO gate_mockbank_keys (private_key_pem, public_key_pem, api_secret_hash) VALUES ($1, $2, $3)`,
    [privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }), hash(secret)],
  );
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), secret };
}

/** A new API secret (the old one stops working). Returned once. */
async function rotateSecret() {
  await ensure();
  const secret = newSecret();
  await db.query(`UPDATE gate_mockbank_keys SET api_secret_hash = $1 WHERE id = (SELECT max(id) FROM gate_mockbank_keys)`, [hash(secret)]);
  return secret;
}

async function authorized(header) {
  const m = /^Bearer\s+(\S+)\s*$/.exec(String(header || ''));
  const r = await row();
  return !!(m && r && crypto.timingSafeEqual(Buffer.from(hash(m[1])), Buffer.from(r.api_secret_hash)));
}

async function openAll(fields) {
  const r = await row();
  const key = crypto.createPrivateKey(r.private_key_pem);
  const out = {};
  for (const [name, f] of Object.entries(fields || {})) {
    if (f && typeof f.enc === 'string') {
      try {
        out[name] = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(f.enc, 'base64')).toString('utf8');
      } catch { out[name] = null; }
    } else if (f && f.value != null) {
      out[name] = String(f.value);
    }
  }
  return out;
}

function validIlId(seed) {
  let x = seed;
  const d = [];
  for (let i = 0; i < 8; i++) { x = (x * 1103515245 + 12345) % 2147483648; d.push(i === 0 ? 1 + (x % 9) : x % 10); }
  let s = 0;
  d.forEach((n, i) => { let v = n * (i % 2 ? 2 : 1); if (v > 9) v -= 9; s += v; });
  return d.join('') + ((10 - (s % 10)) % 10);
}

/** An invented answer about one person, stable for the same passport / ref. */
async function lookup(body) {
  const opened = await openAll(body.fields);
  const who = opened.passportNumber || opened.leadId || body.ref || 'unknown';
  const seed = [...String(who)].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 1000003, 7);
  const existing = seed % 3 !== 0;
  return {
    existingCustomer: existing ? 'כן' : 'לא',
    accountStatus: existing ? 'חשבון עו״ש פעיל' : 'אין חשבון',
    creditLimit: existing ? String(4000 + (seed % 7) * 1500) : '0',
    riskScore: (0.05 + (seed % 9) / 40).toFixed(2),
    branch: ['סניף חיפה', 'סניף ירושלים', 'סניף תל אביב'][seed % 3],
    internalNotes: `נבדק מול מערכת הליבה. ת״ז ממליץ ${validIlId(seed)} מאומתת.`,
  };
}

/** Confirm a handoff: which fields arrived and opened — never the values. */
async function handoff(body) {
  const opened = await openAll(body.fields);
  const fields = Object.keys(body.fields || {});
  return {
    received: fields.length,
    opened: fields.map(f => ({ field: f, sealed: !!(body.fields[f] && body.fields[f].enc), ok: opened[f] != null })),
    reference: `BJ-${crypto.createHash('sha256').update(String(body.ref)).digest('hex').slice(0, 8).toUpperCase()}`,
  };
}

module.exports = { ensure, rotateSecret, authorized, lookup, handoff };
