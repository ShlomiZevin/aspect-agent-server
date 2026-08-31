/**
 * Google Sign-In, and the invitations that gate it.
 *
 *   GET  /api/auth/google/config?tenant=   what the login page needs to render
 *   POST /api/auth/google                  { idToken, tenant } -> a session user
 *
 *   GET    /api/auth/google/allowed?tenant=   list invitations   (super-admin)
 *   POST   /api/auth/google/allowed           invite an email    (super-admin)
 *   DELETE /api/auth/google/allowed/:id       revoke one         (super-admin)
 *
 * The config route is public and deliberately thin: it says whether the button
 * should be drawn and which OAuth client to draw it for. It must not leak who
 * has been invited — that list is exactly what an attacker would want.
 */
const express = require('express');
const { and, desc, eq, isNull, or } = require('drizzle-orm');

const db = require('../../services/db.pg');
const { allowedEmails } = require('../../db/schema');
const googleAuth = require('../../services/google-auth.service');
const moduleService = require('../../modules/services/module.service');
const { requireSuperAdmin } = require('../../services/super-admin');

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.name === 'AuthError') return res.status(err.code || 401).json({ error: err.message });
      if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
      console.error(`[google-auth] ${req.method} ${req.originalUrl}:`, err);
      res.status(500).json({ error: 'Sign-in request failed' });
    }
  };
}

// --- sign-in ------------------------------------------------------------------

router.get('/config', handle(async (req, res) => {
  const tenant = String(req.query.tenant || '');
  const state = tenant ? await moduleService.getForDataset(tenant, 'google-auth') : null;
  const live = Boolean(state?.live);

  res.json({
    // Both must hold: the module switched on for this agent, AND a client id on
    // the server. Reporting enabled without one would draw a button that cannot
    // work.
    enabled: live && googleAuth.isConfigured(),
    clientId: live ? googleAuth.CLIENT_ID : '',
    // When the module is off, the old login is the only one — so it is offered
    // regardless of what the setting says.
    allowPasswordLogin: live ? state.settings.allowPasswordlessFallback !== false : true,
  });
}));

router.post('/', handle(async (req, res) => {
  const { idToken, tenant } = req.body;
  if (!tenant) return res.status(400).json({ error: 'tenant is required' });

  const { user, via } = await googleAuth.signIn(idToken, tenant);

  // The same shape the name+phone login returns, so everything downstream —
  // which stores a userId and sends it back — is untouched by this existing.
  res.json({
    userId: user.externalId,
    name: user.name,
    email: user.email,
    role: user.role,
    via,
  });
}));

// --- invitations (super-admin) --------------------------------------------------

const admin = express.Router();
admin.use(requireSuperAdmin);

admin.get('/', handle(async (req, res) => {
  const tenant = req.query.tenant ? String(req.query.tenant) : null;
  const drizzle = db.getDrizzle();

  const rows = await drizzle
    .select()
    .from(allowedEmails)
    .where(tenant
      // A global grant applies here too, so it belongs in this agent's list.
      ? or(eq(allowedEmails.tenant, tenant), isNull(allowedEmails.tenant))
      : undefined)
    .orderBy(desc(allowedEmails.createdAt));

  res.json({ allowed: rows });
}));

admin.post('/', handle(async (req, res) => {
  const { email, tenant, role, note, invitedBy } = req.body;
  const clean = String(email ?? '').trim().toLowerCase();

  // Not a full RFC check — just enough to catch a typo before it becomes a
  // grant nobody can use and nobody notices is broken.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    return res.status(400).json({ error: 'That does not look like an email address' });
  }
  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be user or admin' });
  }

  const drizzle = db.getDrizzle();

  // Re-inviting someone who was revoked brings them back rather than failing on
  // the unique index, which is what whoever typed the address meant.
  const [existing] = await drizzle
    .select().from(allowedEmails)
    .where(and(
      eq(allowedEmails.email, clean),
      tenant ? eq(allowedEmails.tenant, tenant) : isNull(allowedEmails.tenant),
    ))
    .limit(1);

  if (existing) {
    const [revived] = await drizzle
      .update(allowedEmails)
      .set({ revokedAt: null, role: role || existing.role, note: note ?? existing.note })
      .where(eq(allowedEmails.id, existing.id))
      .returning();
    return res.status(200).json({ allowed: revived });
  }

  const [created] = await drizzle
    .insert(allowedEmails)
    .values({ email: clean, tenant: tenant || null, role: role || 'user', note: note || null, invitedBy: invitedBy || null })
    .returning();

  res.status(201).json({ allowed: created });
}));

admin.delete('/:id', handle(async (req, res) => {
  const drizzle = db.getDrizzle();
  // Revoked, not deleted: who was given access and when is worth keeping.
  const [revoked] = await drizzle
    .update(allowedEmails)
    .set({ revokedAt: new Date() })
    .where(eq(allowedEmails.id, Number(req.params.id)))
    .returning();

  if (!revoked) return res.status(404).json({ error: 'No such invitation' });
  res.json({ allowed: revoked });
}));

router.use('/allowed', admin);

module.exports = router;
