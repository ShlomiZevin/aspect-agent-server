/**
 * Lybi Gate — the bank's public key (gate_bank_keys). Lybi encrypts with it;
 * the matching private key stays at the bank. One active key at a time;
 * registering a new one retires the old (records already sealed keep
 * opening with the bank's old private key — that is the bank's to keep).
 */

const crypto = require('crypto');
const db = require('../../services/db.pg');
const { fingerprint } = require('./crypto');

async function active() {
  const { rows } = await db.query(`SELECT * FROM gate_bank_keys WHERE active ORDER BY id DESC LIMIT 1`);
  const r = rows[0];
  return r ? { id: r.id, name: r.name, publicKeyPem: r.public_key_pem, fingerprint: r.fingerprint, createdAt: r.created_at } : null;
}

async function register(name, publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem); // throws on a bad PEM
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) {
    const err = new Error('the bank key must be RSA, 2048 bits or more'); err.status = 400; err.code = 'bad_bank_key'; throw err;
  }
  const fp = fingerprint(publicKeyPem);
  const current = await active();
  if (current && current.fingerprint === fp) return current;
  await db.query(`UPDATE gate_bank_keys SET active = false WHERE active`);
  await db.query(`INSERT INTO gate_bank_keys (name, public_key_pem, fingerprint) VALUES ($1, $2, $3)`, [name, publicKeyPem, fp]);
  return active();
}

module.exports = { active, register };
