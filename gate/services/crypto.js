/**
 * Lybi Gate — every cryptographic step, in one place.
 *
 *   token(type, value)        HMAC-SHA-256 with GATE_TOKEN_KEY → "TKN-ID-3f9a1c0b2d4e".
 *                             The same value always gets the same token (so an ID that
 *                             shows up in a bank's notes matches the ID field), and
 *                             Lybi cannot turn a token back into the value.
 *   encryptForBank(pem, v)    RSA-OAEP (SHA-256) with the BANK's public key. Only the
 *                             bank's private key opens it — Lybi never has that key.
 *   seal / open               AES-256-GCM with GATE_SECRET_KEY, for secrets Lybi must
 *                             use itself (a bank API's auth header).
 *   signPolicy / verifyPolicy ECDSA P-256 (SHA-256) with GATE_SIGNING_KEY over the
 *                             policy's canonical JSON.
 *
 * The three keys come from the environment (.env.production.<env>). Missing → every
 * call throws GateNotConfigured, which the routes answer as 503 'gate_not_configured'.
 */

const crypto = require('crypto');

class GateNotConfigured extends Error {
  constructor(name) { super(`Lybi Gate is not configured: ${name} is missing`); this.code = 'gate_not_configured'; }
}

const cache = {};
function envKey(name) {
  if (cache[name]) return cache[name];
  const raw = process.env[name];
  if (!raw) throw new GateNotConfigured(name);
  cache[name] = Buffer.from(raw, 'base64');
  return cache[name];
}

let signingKey = null;
function signing() {
  if (!signingKey) signingKey = crypto.createPrivateKey({ key: envKey('GATE_SIGNING_KEY'), format: 'der', type: 'pkcs8' });
  return signingKey;
}

const TAG = { il_id: 'ID', passport: 'PASS', credit_card: 'CARD', iban: 'IBAN', bank_account: 'ACC', phone: 'TEL', email: 'MAIL' };

function token(type, value) {
  const mac = crypto.createHmac('sha256', envKey('GATE_TOKEN_KEY')).update(`${type}|${value}`).digest('hex');
  return `TKN-${TAG[type] || 'X'}-${mac.slice(0, 12)}`;
}

function encryptForBank(publicKeyPem, value) {
  return crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(String(value), 'utf8'),
  ).toString('base64');
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', envKey('GATE_SECRET_KEY'), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function open(sealed) {
  const buf = Buffer.from(sealed, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', envKey('GATE_SECRET_KEY'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/** What gets signed: the version and the fields, keys in a fixed order. */
function canonicalPolicy(version, fields) {
  const clean = [...fields]
    .map(f => ({ field: f.field, detected: f.detected, by: f.by, action: f.action }))
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return JSON.stringify({ policy: 'lybi-gate', version, fields: clean });
}

function signPolicy(version, fields) {
  return crypto.sign('sha256', Buffer.from(canonicalPolicy(version, fields)), signing()).toString('base64');
}

function verifyPolicy(version, fields, signature) {
  try {
    return crypto.verify('sha256', Buffer.from(canonicalPolicy(version, fields)), crypto.createPublicKey(signing()), Buffer.from(signature, 'base64'));
  } catch { return false; }
}

function signingPublicKeyPem() {
  return crypto.createPublicKey(signing()).export({ type: 'spki', format: 'pem' });
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return sha256(der.toString('base64')).slice(0, 16).match(/.{4}/g).join(':');
}

/** Fail fast at the first request rather than mid-record. */
function assertConfigured() {
  envKey('GATE_TOKEN_KEY'); envKey('GATE_SECRET_KEY'); signing();
}

module.exports = {
  GateNotConfigured, token, encryptForBank, seal, open, signPolicy, verifyPolicy,
  signingPublicKeyPem, sha256, fingerprint, assertConfigured, canonicalPolicy,
};
