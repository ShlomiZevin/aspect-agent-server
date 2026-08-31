/**
 * Google Sign-In: verifying an identity, and deciding whether it may in.
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
 * Whether this email may sign in to this agent, and as what.
 *
 * Two ways in, in this order:
 *   1. An invitation — a row in allowed_emails for this agent, or a global one.
 *   2. The agent's auto-approved domain, if the module has one configured.
 *
 * Order matters: an explicit invitation can grant `admin`, and a domain match
 * only ever grants `user`. Checking the domain first would silently demote
 * someone who had been invited as an admin.
 */
async function authorize(email, tenant) {
  const drizzle = db.getDrizzle();

  const [grant] = await drizzle
    .select()
    .from(allowedEmails)
    .where(and(
      eq(allowedEmails.email, email),
      isNull(allowedEmails.revokedAt),
      // A NULL tenant is a grant across every agent — that is us, not a customer.
      or(eq(allowedEmails.tenant, tenant), isNull(allowedEmails.tenant)),
    ))
    // A tenant-specific grant wins over the global one when both exist.
    .orderBy(sql`${allowedEmails.tenant} NULLS LAST`)
    .limit(1);

  if (grant) return { allowed: true, role: grant.role, via: 'invitation' };

  const settings = await moduleSettings(tenant);
  const domain = String(settings.allowedDomain || '').trim().toLowerCase().replace(/^@/, '');
  if (domain && email.endsWith(`@${domain}`)) {
    return { allowed: true, role: 'user', via: 'domain' };
  }

  return { allowed: false };
}

/** The module's resolved settings for this agent, or {} when it is not live. */
async function moduleSettings(tenant) {
  const state = await moduleService.getForDataset(tenant, 'google-auth');
  return state?.live ? state.settings : {};
}

/** @returns {boolean} is Google sign-in switched on for this agent? */
async function isLiveFor(tenant) {
  return moduleService.isLive(tenant, 'google-auth');
}

/**
 * The whole sign-in: verify, authorize, then find or create the user.
 *
 * The user row is keyed on `google_<sub>`, not on the email: Google subjects are
 * stable and email addresses are not, and someone who changes their address
 * should keep their conversations rather than arrive as a stranger.
 */
async function signIn(idToken, tenant) {
  if (!await isLiveFor(tenant)) {
    throw new AuthError('Google sign-in is not enabled for this agent', 403);
  }

  const identity = await verify(idToken);
  const decision = await authorize(identity.email, tenant);

  if (!decision.allowed) {
    // Deliberately the same answer whether the address is unknown or revoked:
    // the difference is not the signed-in person's business, and telling them
    // turns this into a way to probe who has access.
    throw new AuthError('This Google account has not been given access', 403);
  }

  const drizzle = db.getDrizzle();
  const externalId = `google_${identity.sub}`;

  const [existing] = await drizzle
    .select().from(users).where(eq(users.externalId, externalId)).limit(1);

  if (existing) {
    // Refreshed rather than left as first seen: a changed display name or email
    // otherwise stays stale on the board and in every comment attribution.
    const [updated] = await drizzle
      .update(users)
      .set({
        email: identity.email,
        name: identity.name,
        role: decision.role,
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return { user: updated, via: decision.via };
  }

  const [created] = await drizzle
    .insert(users)
    .values({
      externalId,
      email: identity.email,
      name: identity.name,
      role: decision.role,
      source: 'web',
      tenant,
      lastActiveAt: new Date(),
    })
    .returning();

  return { user: created, via: decision.via };
}

module.exports = { signIn, verify, authorize, isConfigured, isLiveFor, AuthError, CLIENT_ID };
