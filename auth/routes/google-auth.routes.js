/**
 * Signing in, and the invitations that gate it.
 *
 *   GET  /api/auth/signin/config?tenant=   what the login screen needs to render
 *   POST /api/auth/signin/google           { idToken, tenant }
 *   POST /api/auth/signin/password         { email, password, tenant }
 *
 *   GET    /api/auth/signin/allowed?tenant=   list accounts
 *   POST   /api/auth/signin/allowed           add an account
 *   PUT    /api/auth/signin/allowed/:id       change admin access / projects
 *   PUT    /api/auth/signin/allowed/:id/password  set or clear one
 *   DELETE /api/auth/signin/allowed/:id       revoke one
 *
 * The account routes sit behind the admin, which is itself behind sign-in with
 * admin access (task #113) — no separate super-admin key any more.
 *
 * The config route is public and deliberately thin: it says which ways in this
 * client offers and which OAuth client to draw the button for. It must not leak
 * who has been invited — that list is exactly what an attacker would want.
 */
const express = require('express');
const { desc, eq, isNull, or, sql } = require('drizzle-orm');

const db = require('../../services/db.pg');
const { allowedEmails } = require('../../db/schema');
const signin = require('../../services/google-auth.service');
const passwords = require('../../services/password.service');

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
    // Not tied to `enabled`: the Intelligence Center needs sign-in for every
    // project, module or not (task #113).
    google: methods !== 'password',
    password: methods !== 'google',
    clientId: signin.isConfigured() ? signin.CLIENT_ID : '',
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

admin.get('/', handle(async (req, res) => {
  const tenant = req.query.tenant ? String(req.query.tenant) : null;
  const drizzle = db.getDrizzle();

  const rows = await drizzle
    .select()
    .from(allowedEmails)
    .where(tenant
      // An all-projects account opens this one too, so it belongs in its list.
      ? or(isNull(allowedEmails.tenants), sql`${tenant} = ANY(${allowedEmails.tenants})`)
      : undefined)
    .orderBy(desc(allowedEmails.createdAt));

  res.json({ allowed: rows.map(strip) });
}));

admin.post('/', handle(async (req, res) => {
  const { email, tenant, role, note, invitedBy } = req.body;
  const clean = String(email ?? '').trim().toLowerCase();

  // Not a full RFC check — just enough to catch a typo before it becomes a
  // grant nobody can use and nobody notices is broken.
  // A customer's own user need not be an address — e.g. `thereforyou.aspect.com`
  // (task #113); it signs in with its password.
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean);
  const isUserName = /^[a-z0-9][a-z0-9._-]{2,63}$/.test(clean);
  if (!isEmail && !isUserName) {
    return res.status(400).json({ error: 'Use an email address or a user name (letters, digits, dots, dashes)' });
  }
  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be user or admin' });
  }

  const drizzle = db.getDrizzle();

  // One account per login. Adding a login that already exists adds this
  // project to it (and brings it back if it was revoked) — which is what
  // whoever typed it on this project's page meant.
  const [existing] = await drizzle
    .select().from(allowedEmails)
    .where(eq(allowedEmails.email, clean))
    .limit(1);

  if (existing) {
    const tenants = existing.tenants === null || !tenant
      ? existing.tenants
      : Array.from(new Set([...existing.tenants, tenant]));
    const [revived] = await drizzle
      .update(allowedEmails)
      .set({ revokedAt: null, tenants, role: role || existing.role, note: note ?? existing.note })
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
      tenants: tenant ? [tenant] : null,
      role: role || 'user',
      note: note || null,
      invitedBy: invitedBy || null,
      passwordHash,
      passwordSetAt: passwordHash ? new Date() : null,
    })
    .returning();

  res.status(201).json({ allowed: strip(created), password: plaintext });
}));

/**
 * Changes an account's admin access (`role`) and/or its projects (`tenants`:
 * a non-empty list of project slugs, or null = every project).
 */
admin.put('/:id', handle(async (req, res) => {
  const patch = {};
  if (req.body.role !== undefined) {
    if (!['user', 'admin'].includes(req.body.role)) {
      return res.status(400).json({ error: 'role must be user or admin' });
    }
    patch.role = req.body.role;
  }
  if (req.body.tenants !== undefined) {
    const t = req.body.tenants;
    if (t !== null && !(Array.isArray(t) && t.length && t.every(x => typeof x === 'string' && x.trim()))) {
      return res.status(400).json({ error: 'Pick at least one project, or all projects' });
    }
    patch.tenants = t === null ? null : Array.from(new Set(t.map(x => x.trim())));
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

  const [updated] = await db.getDrizzle()
    .update(allowedEmails)
    .set(patch)
    .where(eq(allowedEmails.id, Number(req.params.id)))
    .returning();
  if (!updated) return res.status(404).json({ error: 'No such account' });
  res.json({ allowed: strip(updated) });
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
