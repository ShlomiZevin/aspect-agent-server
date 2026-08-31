/**
 * Sign-in: proving who someone is, and deciding whether they may in.
 *
 * Two ways to prove it — a Google identity, or an email and a password — and
 * one place that decides what happens next, so the rules about invitations,
 * revocation and roles cannot differ between them.
 *
 * The client obtains an ID token from Google Identity Services and posts it
 * here. Nothing about the person is trusted from the request body — the email,
 * the name and the subject all come out of the verified token, because a body
 * field saying `email: shlomi@...` is a claim anyone can make.
 *
 * Verification uses google-auth-library, which arrives with `googleapis` and is
 * already a dependency. Firebase Auth would have been a second SDK, a second
 * identity store and a second thing to keep configured for the same result.
 */
const { OAuth2Client } = require('google-auth-library');
const { eq, and, isNull, or, sql } = require('drizzle-orm');
const db = require('./db.pg');
const { users, allowedEmails } = require('../db/schema');
const moduleService = require('../modules/services/module.service');
const passwords = require('./password.service');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';

let client = null;
function oauth() {
  if (!client) client = new OAuth2Client(CLIENT_ID);
  return client;
}

class AuthError extends Error {
  constructor(message, code = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** @returns {boolean} whether the server is configured to accept Google logins at all. */
function isConfigured() {
  return Boolean(CLIENT_ID);
}

/**
 * Verifies the token and returns the identity Google vouches for.
 *
 * `audience` is passed so a token minted for some other application cannot be
 * replayed here — without it, any valid Google token would verify.
 */
async function verify(idToken) {
  if (!isConfigured()) {
    throw new AuthError('Google sign-in is not configured on this server', 503);
  }
  if (!idToken) throw new AuthError('Missing Google credential', 400);

  let payload;
  try {
    const ticket = await oauth().verifyIdToken({ idToken, audience: CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
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
 * tenant spans every agent -- that is us, not a customer -- and a grant for a
 * specific agent wins over it, so a person can be an admin on one client and an
 * ordinary user everywhere else.
 */
async function grantFor(email, tenant) {
  const drizzle = db.getDrizzle();

  const [grant] = await drizzle
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

/** The module's resolved settings for this agent, or {} when it is not live. */
async function moduleSettings(tenant) {
  const state = await moduleService.getForDataset(tenant, 'google-auth');
  return state?.live ? state.settings : {};
}

/** @returns {'both'|'google'|'password'} how this client signs in. */
async function methodsFor(tenant) {
  const settings = await moduleSettings(tenant);
  return settings.methods || 'both';
}

async function assertMethodAllowed(tenant, method) {
  const allowed = await methodsFor(tenant);
  if (allowed !== 'both' && allowed !== method) {
    throw new AuthError(
      method === 'google'
        ? 'This client signs in with an email and password'
        : 'This client signs in with Google',
      403,
    );
  }
}

/** @returns {boolean} is Google sign-in switched on for this agent? */
async function isLiveFor(tenant) {
  return moduleService.isLive(tenant, 'google-auth');
}

/** The same refusal for every reason access is denied — see signIn. */
const DENIED = 'That account has not been given access';

/**
 * Sign in with Google.
 *
 * The user row keys on `google_<sub>`, not on the email: Google subjects are
 * stable and addresses are not, and someone who changes their address should
 * keep their history rather than arrive as a stranger.
 */
async function signInWithGoogle(idToken, tenant) {
  await assertEnabled(tenant);
  await assertMethodAllowed(tenant, 'google');

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
 * Every failure below answers the same way. Saying "no such account" or "wrong
 * password" tells whoever is guessing which half they got right, and turns the
 * form into a way to enumerate who has access.
 */
async function signInWithPassword(email, password, tenant) {
  await assertEnabled(tenant);
  await assertMethodAllowed(tenant, 'password');

  const clean = String(email ?? '').trim().toLowerCase();
  const grant = await grantFor(clean, tenant);

  // The hash is verified even when there is no grant, against a dummy value, so
  // an unknown address takes the same time as a known one. Without it the reply
  // is instant for addresses nobody invited, which is the same disclosure the
  // shared message above is avoiding.
  const stored = grant?.passwordHash || DUMMY_HASH;
  const matches = await passwords.verify(password, stored);

  if (!grant || !grant.passwordHash || !matches) throw new AuthError(DENIED, 403);

  const user = await upsertUser({
    // Keyed on the address, since there is no external subject to key on.
    externalId: `email_${clean}`,
    email: clean,
    name: grant.note || clean.split('@')[0],
    role: grant.role,
    tenant,
  });

  return { user, via: 'password' };
}

// A real scrypt hash of a value nothing will ever match, so the comparison in
// signInWithPassword costs the same whether or not the account exists.
const DUMMY_HASH = 'scrypt$16384$0000000000000000000000000000000000000000000000000000000000000000$'
  + '0'.repeat(128);

async function assertEnabled(tenant) {
  if (!await isLiveFor(tenant)) {
    throw new AuthError('Sign-in is not enabled for this agent', 403);
  }
}

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

module.exports = {
  signInWithGoogle,
  signInWithPassword,
  verify,
  grantFor,
  methodsFor,
  isConfigured,
  isLiveFor,
  AuthError,
  CLIENT_ID,
};
