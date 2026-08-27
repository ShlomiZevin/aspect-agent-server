/**
 * Super-admin gate — ONE definition, shared by the inline admin routes in
 * server.js and by feature routers that need the same protection.
 *
 * Extracted from server.js (where it was a file-local const + function) when
 * the Aspect Modules router needed the same check: duplicating the key into a
 * second file would mean two places to rotate it and a real chance of them
 * drifting apart. server.js still owns none of the logic — it just requires
 * this.
 *
 * Intentionally lightweight, as the original comment said: the key is shared
 * with internal users only, and it gates "can see across all tenants" /
 * "can configure things clients cannot", not authentication.
 */

const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || '6724';

/** @returns {boolean} true when the request carries the super-admin header. */
function isSuperAdminRequest(req) {
  return req.headers['x-super-admin-key'] === SUPER_ADMIN_KEY;
}

/**
 * Express middleware form — 403s instead of letting the handler run.
 * Use on routers where EVERY route is super-admin-only (the Modules admin
 * API). Routes that merely widen their scope for a super-admin should keep
 * calling isSuperAdminRequest() directly instead.
 */
function requireSuperAdmin(req, res, next) {
  if (!isSuperAdminRequest(req)) {
    return res.status(403).json({ error: 'Super-admin key required' });
  }
  next();
}

module.exports = { isSuperAdminRequest, requireSuperAdmin, SUPER_ADMIN_KEY };
