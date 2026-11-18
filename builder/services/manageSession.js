/**
 * The management center's session token (task #985).
 *
 * After Google vouches for someone (services/google-auth.service.js
 * `verify`, audience-checked), the server hands the browser this token and
 * the browser sends it back as `Authorization: Bearer …` on every
 * /api/manage call. A cookie cannot do it: the site (web.app) and the
 * server (run.app) are different sites.
 *
 *   v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, "v1." + payload))>
 *   payload = { e: email, n: name, p: picture, iat, exp }   (seconds)
 *
 * The token proves WHO someone is, nothing more. What they may see is read
 * from `manage_access` on every request (manageAccess.js), so revoking a
 * grant works at once although the token lives 30 days.
 *
 * The secret is random, made on first use and kept in `provider_config`
 * (key below) — one per environment, by itself, with nothing to set up.
 * provider_config's admin API lists and edits only its whitelisted API-key
 * names, so this row is never shown there. Deleting the row signs everyone
 * out (a new secret is made on the next sign-in).
 */

const crypto = require('crypto');
const db = require('../../services/db.pg');

const SECRET_KEY = 'manage_session_secret';
const VERSION = 'v1';
const SESSION_DAYS = 30;

let secretCache = null;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * This environment's signing secret, created on first use. Insert-then-read,
 * so two instances racing on the very first sign-in agree on one secret.
 */
async function secret() {
  if (secretCache) return secretCache;
  await db.query(
    `INSERT INTO provider_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [SECRET_KEY, b64url(crypto.randomBytes(48))],
  );
  const { rows } = await db.query(`SELECT value FROM provider_config WHERE key = $1`, [SECRET_KEY]);
  const value = rows[0] && rows[0].value;
  if (!value) throw new Error('management center: no session secret');
  secretCache = value;
  return value;
}

function mac(key, body) {
  return b64url(crypto.createHmac('sha256', key).update(body).digest());
}

/**
 * @param {{ email: string, name?: string, picture?: string|null }} who  — from a verified Google token
 * @returns {Promise<{ token: string, expiresAt: string }>}
 */
async function issue({ email, name, picture }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_DAYS * 24 * 3600;
  const payload = b64url(JSON.stringify({ e: email, n: name || email, p: picture || null, iat: now, exp }));
  const body = `${VERSION}.${payload}`;
  return { token: `${body}.${mac(await secret(), body)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * @returns {Promise<{ email: string, name: string, picture: string|null } | null>}
 *   null = missing, forged, malformed or expired.
 */
async function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(mac(await secret(), body));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let p;
  try { p = JSON.parse(fromB64url(parts[1]).toString('utf8')); } catch { return null; }
  if (!p || typeof p.e !== 'string' || !p.e || typeof p.exp !== 'number') return null;
  if (p.exp * 1000 <= Date.now()) return null;
  return { email: p.e, name: p.n || p.e, picture: p.p || null };
}

/** The token from `Authorization: Bearer <token>`, or null. */
function fromRequest(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

/** Tests only: forget the cached secret. */
function _resetForTests() {
  secretCache = null;
}

module.exports = { issue, verify, fromRequest, SESSION_DAYS, SECRET_KEY, _resetForTests };
