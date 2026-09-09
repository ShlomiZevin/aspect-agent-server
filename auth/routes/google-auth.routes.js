/**
 * Signing in, and the invitations that gate it.
 *
 *   GET  /api/auth/signin/config?tenant=   what the login screen needs to render
 *   POST /api/auth/signin/google           { idToken, tenant }
 *   POST /api/auth/signin/password         { email, password, tenant }
 *
 *   GET    /api/auth/signin/allowed?tenant=   list invitations   (super-admin)
 *   POST   /api/auth/signin/allowed           invite an email    (super-admin)
 *   PUT    /api/auth/signin/allowed/:id/password  set or clear one (super-admin)
 *   DELETE /api/auth/signin/allowed/:id       revoke one         (super-admin)
 *
 * The config route is public and deliberately thin: it says which ways in this
 * client offers and which OAuth client to draw the button for. It must not leak
 * who has been invited — that list is exactly what an attacker would want.
 */
const express = require('express');
const { and, desc, eq, isNull, or } = require('drizzle-orm');

const db = require('../../services/db.pg');
const { allowedEmails } = require('../../db/schema');
const signin = require('../../services/google-auth.service');
const passwords = require('../../services/password.service');
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

function requireTenant(req) {
  const tenant = req.body?.tenant;
  if (!tenant) {
    const err = new Error('tenant is required');
    err.name = 'ValidationError';
    throw err;
  }
  return String(tenant);
}

/** What the login screen needs before it draws anything. Leaks nothing about who is invited. */
router.get('/config', handle(async (req, res) => {
  const tenant = String(req.query.tenant || '');
  const { live, methods, purpose } = tenant
    ? await signin.policyFor(tenant)
    : { live: false, methods: 'both', purpose: 'gate' };

  res.json({
    enabled: live,
    // 'gate' closes the surface until sign-in; 'sync' leaves it open and the
    // sign-in only ties history to an account.
    purpose,
    // Whether this client OFFERS Google — the button belongs on screen wherever
    // the setting allows it. Whether it can complete a sign-in is `clientId`:
    // without a configured OAuth client the UI shows it disabled rather than
    // hiding the option and looking like it was never built.
    google: live && methods !== 'password',
    password: live && methods !== 'google',
    clientId: live && signin.isConfigured() ? signin.CLIENT_ID : '',
  });
}));

router.post('/google', handle(async (req, res) => {
  const tenant = requireTenant(req);
  const { anonUserId, agentName } = req.body;
  const { user, via } = await signin.signInWithGoogle(req.body.idToken, tenant);
  res.json(await signin.toSession(user, via, { anonUserId, agentName, tenant }));
}));

router.post('/password', handle(async (req, res) => {
  const tenant = requireTenant(req);
  const { email, password, anonUserId, agentName } = req.body;
  const { user, via } = await signin.signInWithPassword(email, password, tenant);
  res.json(await signin.toSession(user, via, { anonUserId, agentName, tenant }));
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

  res.json({ allowed: rows.map(strip) });
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
    return res.status(200).json({ allowed: strip(revived) });
  }

  // A password may be set at invite time, or generated so it can be read out
  // once and handed over. Either way only the hash is stored, so the plaintext
  // below is the only time anyone will see it.
  let passwordHash = null;
  let plaintext = null;
  if (req.body.password || req.body.generatePassword) {
    plaintext = req.body.password || passwords.generate();
    passwordHash = await passwords.hash(plaintext);
  }

  const [created] = await drizzle
    .insert(allowedEmails)
    .values({
      email: clean,
      tenant: tenant || null,
      role: role || 'user',
      note: note || null,
      invitedBy: invitedBy || null,
      passwordHash,
      passwordSetAt: passwordHash ? new Date() : null,
    })
    .returning();

  res.status(201).json({ allowed: strip(created), password: plaintext });
}));

/** Sets or clears one invitation's password. */
admin.put('/:id/password', handle(async (req, res) => {
  const drizzle = db.getDrizzle();
  const clear = req.body.clear === true;

  const plaintext = clear ? null : (req.body.password || passwords.generate());
  const passwordHash = clear ? null : await passwords.hash(plaintext);

  const [updated] = await drizzle
    .update(allowedEmails)
    .set({ passwordHash, passwordSetAt: passwordHash ? new Date() : null })
    .where(eq(allowedEmails.id, Number(req.params.id)))
    .returning();

  if (!updated) return res.status(404).json({ error: 'No such invitation' });
  res.json({ allowed: strip(updated), password: plaintext });
}));

/**
 * Never send a hash to a browser, not even to a super-admin.
 *
 * It is of no use to the screen showing it and every use to anyone who obtains
 * the response, and "the admin page had it in a network tab" is how these leak.
 */
function strip(row) {
  const { passwordHash, ...rest } = row;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}

admin.delete('/:id', handle(async (req, res) => {
  const drizzle = db.getDrizzle();
  // Revoked, not deleted: who was given access and when is worth keeping.
  const [revoked] = await drizzle
    .update(allowedEmails)
    .set({ revokedAt: new Date() })
    .where(eq(allowedEmails.id, Number(req.params.id)))
    .returning();

  if (!revoked) return res.status(404).json({ error: 'No such invitation' });
  res.json({ allowed: strip(revoked) });
}));

router.use('/allowed', admin);

module.exports = router;
