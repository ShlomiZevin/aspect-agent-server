/**
 * Lybi Gate — the keys a bank's systems use on POST /api/gate/v1/records.
 * A key is "gk_live_<32 random url-safe chars>". It is returned ONCE, at
 * creation; Lybi keeps only its SHA-256 and a display prefix.
 */

const crypto = require('crypto');
const db = require('../../services/db.pg');
const { sha256 } = require('./crypto');

const shape = r => ({
  id: r.id, name: r.name, prefix: r.prefix, createdBy: r.created_by, createdAt: r.created_at,
  lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, active: !r.revoked_at,
});

async function list() {
  const { rows } = await db.query(`SELECT * FROM gate_keys ORDER BY created_at DESC`);
  return rows.map(shape);
}

async function create(name, actor) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) { const e = new Error('a key needs a name'); e.status = 400; e.code = 'bad_key'; throw e; }
  const key = `gk_live_${crypto.randomBytes(24).toString('base64url')}`;
  const { rows } = await db.query(
    `INSERT INTO gate_keys (name, prefix, hash, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [clean, `${key.slice(0, 12)}…`, sha256(key), actor || null],
  );
  return { ...shape(rows[0]), key };
}

async function revoke(id) {
  const { rows } = await db.query(`UPDATE gate_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

/** The key row for an Authorization header, or null (missing / unknown / revoked). */
async function authenticate(header) {
  const m = /^Bearer\s+(gk_live_[A-Za-z0-9_-]{20,})\s*$/.exec(String(header || ''));
  if (!m) return null;
  const { rows } = await db.query(
    `UPDATE gate_keys SET last_used_at = now() WHERE hash = $1 AND revoked_at IS NULL RETURNING *`,
    [sha256(m[1])],
  );
  return rows[0] ? shape(rows[0]) : null;
}

module.exports = { list, create, revoke, authenticate };
