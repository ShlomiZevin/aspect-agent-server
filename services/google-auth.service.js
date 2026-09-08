/**
 * Sign-in: proving who someone is, deciding whether they may in, and handing
 * back the session the browser then holds.
 *
 * Two ways to prove it — a Google identity, or an email and a password — and
 * ONE place (`authenticate`) that turns a proven identity into a platform user,
 * so the rules about invitations, revocation and roles cannot drift apart
 * between them.
 *
 * Nothing about the person is trusted from the request body: the email, the
 * name and the Google subject all come out of the verified ID token, because a
 * body field saying `email: shlomi@…` is a claim anyone can make.
 *
 * The module id stays `google-auth` (there are live `client_modules` rows under
 * that key) even though it now covers passwords too; user-facing copy says
 * "Sign-In".
 */
const { OAuth2Client } = require('google-auth-library');
const { eq, and, isNull, or, sql } = require('drizzle-orm');
const db = require('./db.pg');
const { users, allowedEmails } = require('../db/schema');
const moduleService = require('../modules/services/module.service');
const conversationService = require('./conversation.service');
const passwords = require('./password.service');

const MODULE_ID = 'google-auth';
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';

// One shared refusal for every reason access is denied. "No such account" vs
// "wrong password" tells whoever is guessing which half they got right and
// turns the form into a way to enumerate who has access.
const DENIED = 'That account has not been given access';

// A real scrypt hash of a value nothing will ever match, so the password check
// costs the same whether or not the account exists (see authenticateWithPassword).
const DUMMY_HASH = 'scrypt$16384$0000000000000000000000000000000000000000000000000000000000000000$'
  + '0'.repeat(128);

class AuthError extends Error {
  constructor(message, code = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

// ── module policy ───────────────────────────────────────────────────────────

/**
 * How this agent's sign-in behaves, resolved in one place.
 *
 *   live     — the Sign-In module is switched on for this agent
 *   methods  — 'both' | 'google' | 'password'
 *   purpose  — 'gate'  the surface is closed until an invited person signs in
 *              'sync'  the surface stays open; signing in only ties the person's
 *                      history to an account so it follows them between devices.
 *
 * `purpose` never changes WHO may sign in — only invited addresses may, both
 * ways — it changes whether the chat is usable before they do.
 *
 * @returns {Promise<{live:boolean, methods:'both'|'google'|'password', purpose:'gate'|'sync'}>}
 */
async function policyFor(tenant) {
  const state = tenant ? await moduleService.getForDataset(tenant, MODULE_ID) : null;
  const live = Boolean(state?.live);
  const settings = live ? (state.settings || {}) : {};
  return {
    live,
    methods: settings.methods || 'both',
    purpose: settings.purpose === 'sync' ? 'sync' : 'gate',
  };
}

/** @returns {boolean} whether the server can accept Google logins at all. */
function isConfigured() {
  return Boolean(CLIENT_ID);
}

function assertLive(policy) {
  if (!policy.live) throw new AuthError('Sign-in is not enabled for this agent', 403);
}

function assertMethod(policy, method) {
  if (policy.methods !== 'both' && policy.methods !== method) {
    throw new AuthError(
      method === 'google'
        ? 'This client signs in with an email and password'
        : 'This client signs in with Google',
      403,
    );
  }
}

// ── identity ────────────────────────────────────────────────────────────────

let oauthClient = null;
function oauth() {
  if (!oauthClient) oauthClient = new OAuth2Client(CLIENT_ID);
  return oauthClient;
}

/**
 * Verifies a Google ID token and returns the identity Google vouches for.
 *
 * `audience` is passed so a token minted for some other application cannot be
 * replayed here — without it, any valid Google token would verify.
 */
async function verify(idToken) {
  if (!isConfigured()) throw new AuthError('Google sign-in is not configured on this server', 503);
  if (!idToken) throw new AuthError('Missing Google credential', 400);

  let payload;
  try {
    const ticket = await oauth().verifyIdToken({ idToken, audience: CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    // The library's message names the signature or the clock; neither is the
    // caller's business, and both read as "sign in again".
    throw new AuthError('Google sign-in could not be verified', 401);
  }

  if (!payload?.email) throw new AuthError('Google account has no email address', 401);
  if (payload.email_verified === false) {
    throw new AuthError('That Google account has an unverified email address', 403);
  }

  return {
    sub: payload.sub,
    email: String(payload.email).toLowerCase(),
    name: payload.name || payload.email,
    picture: payload.picture || null,
  };
}

/**
 * The invitation that lets this email into this agent, or null.
 *
 * Access is granted ahead of time, one address at a time. A grant with no
 * tenant spans every agent — that is us, not a customer — and a grant for a
 * specific agent wins over it, so a person can be an admin on one client and an
 * ordinary user everywhere else.
 */
async function grantFor(email, tenant) {
  const [grant] = await db.getDrizzle()
    .select()
    .from(allowedEmails)
    .where(and(
      eq(allowedEmails.email, email),
      isNull(allowedEmails.revokedAt),
      or(eq(allowedEmails.tenant, tenant), isNull(allowedEmails.tenant)),
    ))
    .orderBy(sql`${allowedEmails.tenant} NULLS LAST`)
    .limit(1);

  return grant || null;
}

// ── the two ways in ─────────────────────────────────────────────────────────

/**
 * Sign in with Google.
 *
 * The user row keys on `google_<sub>`, not on the email: Google subjects are
 * stable and addresses are not, and someone who changes their address should
 * keep their history rather than arrive as a stranger.
 *
 * An invitation is required regardless of `purpose` — 'sync' opens the chat to
 * anonymous use, it does not open sign-in to strangers. Accounts are added on
 * the Access page.
 */
async function signInWithGoogle(idToken, tenant) {
  const policy = await policyFor(tenant);
  assertLive(policy);
  assertMethod(policy, 'google');

  const identity = await verify(idToken);
  const grant = await grantFor(identity.email, tenant);
  if (!grant) throw new AuthError(DENIED, 403);

  const user = await upsertUser({
    externalId: `google_${identity.sub}`,
    email: identity.email,
    name: identity.name,
    role: grant.role,
    tenant,
  });

  return { user, via: 'google' };
}

/**
 * Sign in with an email and a password.
 *
 * Every failure answers identically, and the hash is verified even when there
 * is no grant (against DUMMY_HASH) so an unknown address takes the same time as
 * a known one — otherwise the instant reply for addresses nobody invited is the
 * same disclosure the shared message is avoiding.
 */
async function signInWithPassword(email, password, tenant) {
  const policy = await policyFor(tenant);
  assertLive(policy);
  assertMethod(policy, 'password');

  const clean = String(email ?? '').trim().toLowerCase();
  const grant = await grantFor(clean, tenant);
  const matches = await passwords.verify(password, grant?.passwordHash || DUMMY_HASH);

  if (!grant || !grant.passwordHash || !matches) throw new AuthError(DENIED, 403);

  const user = await upsertUser({
    externalId: `email_${clean}`, // no external subject to key on
    email: clean,
    name: grant.note || clean.split('@')[0],
    role: grant.role,
    tenant,
  });

  return { user, via: 'password' };
}

// ── from a proven identity to a session ─────────────────────────────────────

/**
 * Finds or creates the platform user behind a proven identity.
 *
 * Refreshed rather than left as first seen: a changed display name, email or
 * role otherwise stays stale on the board and in every comment attribution.
 */
async function upsertUser({ externalId, email, name, role, tenant }) {
  const drizzle = db.getDrizzle();

  const [existing] = await drizzle
    .select().from(users).where(eq(users.externalId, externalId)).limit(1);

  if (existing) {
    const [updated] = await drizzle
      .update(users)
      .set({ email, name, role, lastActiveAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await drizzle
    .insert(users)
    .values({ externalId, email, name, role, source: 'web', tenant, lastActiveAt: new Date() })
    .returning();

  return created;
}

/**
 * Turns an authenticated user into the session payload the browser stores.
 *
 * `userId` is the external id — what every surface already stores and sends
 * back. When the browser was chatting anonymously and passes that `anonUserId`,
 * those conversations are re-parented onto this account first, so the history
 * the person already has is not stranded on a session they can no longer reach.
 * A second device signing in as the same person has no anon history to move and
 * simply reads the account's conversations back.
 *
 * Neither step may fail the sign-in: the person is authenticated either way.
 */
async function toSession(user, via, { anonUserId = null, agentName = null } = {}) {
  if (anonUserId && anonUserId !== user.externalId) {
    try {
      await conversationService.attachAnonConversations(anonUserId, user.externalId, agentName);
    } catch (err) {
      console.error('[sign-in] attachAnonConversations:', err.message);
    }
  }

  let conversations = [];
  try {
    conversations = await conversationService.getUserConversations(user.externalId, agentName);
  } catch (err) {
    console.error('[sign-in] getUserConversations:', err.message);
  }

  return {
    userId: user.externalId,
    name: user.name,
    email: user.email,
    role: user.role,
    via,
    conversations,
  };
}

module.exports = {
  policyFor,
  isConfigured,
  verify,
  grantFor,
  signInWithGoogle,
  signInWithPassword,
  toSession,
  AuthError,
  CLIENT_ID,
  MODULE_ID,
};
