require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const assert = require('assert');
const db = require('../../services/db.pg');
const { allowedEmails } = require('../../db/schema');
const { eq } = require('drizzle-orm');
const signin = require('../../services/google-auth.service');
const passwords = require('../../services/password.service');
const moduleService = require('../../modules/services/module.service');
const registry = require('../../modules/registry');

/**
 * Checks the sign-in gate against the real platform DB.
 *
 * What is NOT tested here is Google token verification: that needs a real
 * credential, and google-auth-library is the thing doing it. What IS tested is
 * everything around it — the module gate, which methods a client offers, the
 * invitation lookup, revocation, and password hashing — because that is where
 * an access decision gets made wrong quietly.
 *
 *   node verification/google-auth/test-google-auth.js
 *
 * Removes every row it creates, including on failure.
 */
const AGENT = 'aspect';
const INVITED = 'invited-check@example.com';
const WITH_PASSWORD = 'password-check@example.com';
const STRANGER = 'stranger-check@example.com';
const SECRET = 'correct-horse-battery';

let passed = 0;
const ok = name => { passed++; console.log('   ok  ' + name); };
let restoreModule = null;

async function run() {
  await db.initialize();
  const drizzle = db.getDrizzle();

  // --- the descriptor ---------------------------------------------------------
  const d = registry.get('google-auth');
  assert.strictEqual(d.kind, 'app');
  assert.strictEqual(d.scope, 'client');
  assert.ok(!d.hooks, 'an app module must declare no data hooks');
  ok('google-auth is a client-scoped app module');

  // --- off by default ---------------------------------------------------------
  const before = await moduleService.getForDataset(AGENT, 'google-auth');
  restoreModule = async () => {
    await moduleService.setEnabled(AGENT, 'google-auth', Boolean(before?.enabled), 'verification');
    if (before?.settings) {
      await moduleService.saveSettings(AGENT, 'google-auth', before.settings, 'verification');
    }
  };

  assert.strictEqual(await signin.isLiveFor(AGENT), false);
  ok('not live until it is switched on');

  for (const [name, call] of [
    ['google', () => signin.signInWithGoogle('any-token', AGENT)],
    ['password', () => signin.signInWithPassword(INVITED, SECRET, AGENT)],
  ]) {
    await assert.rejects(
      call,
      e => e.name === 'AuthError' && e.code === 403 && /not enabled/.test(e.message),
      `${name} sign-in must be refused before anything else while the module is off`,
    );
  }
  ok('both ways in are refused while the module is off, before any credential is read');

  // --- switched on ------------------------------------------------------------
  const live = await moduleService.setEnabled(AGENT, 'google-auth', true, 'verification');
  assert.strictEqual(live.live, true);
  ok('enabling makes it live with no init run');

  // --- invitations ------------------------------------------------------------
  await drizzle.insert(allowedEmails)
    .values({ email: INVITED, tenant: AGENT, role: 'admin', invitedBy: 'verification' });

  const invited = await signin.grantFor(INVITED, AGENT);
  assert.strictEqual(invited.role, 'admin');
  ok('an invited address is found, with the role it was invited as');

  assert.strictEqual(await signin.grantFor(INVITED, 'zolstock'), null);
  ok('the same invitation does not carry to another agent');

  assert.strictEqual(await signin.grantFor(STRANGER, AGENT), null);
  ok('an address nobody invited is not found');

  // --- password sign-in --------------------------------------------------------
  await drizzle.insert(allowedEmails).values({
    email: WITH_PASSWORD,
    tenant: AGENT,
    role: 'user',
    invitedBy: 'verification',
    passwordHash: await passwords.hash(SECRET),
    passwordSetAt: new Date(),
  });

  const signedIn = await signin.signInWithPassword(WITH_PASSWORD, SECRET, AGENT);
  assert.strictEqual(signedIn.via, 'password');
  assert.strictEqual(signedIn.user.email, WITH_PASSWORD);
  assert.strictEqual(signedIn.user.externalId, `email_${WITH_PASSWORD}`);
  ok('the right password signs in and creates the user');

  const again = await signin.signInWithPassword(WITH_PASSWORD, SECRET, AGENT);
  assert.strictEqual(again.user.id, signedIn.user.id);
  ok('signing in twice reuses the same user rather than making a second');

  // Every failure answers identically, so the form cannot be used to work out
  // which addresses exist.
  const denials = [];
  for (const [name, args] of [
    ['wrong password', [WITH_PASSWORD, 'not-the-password', AGENT]],
    ['unknown address', [STRANGER, SECRET, AGENT]],
    ['invited but no password set', [INVITED, SECRET, AGENT]],
  ]) {
    await assert.rejects(
      () => signin.signInWithPassword(...args),
      e => { denials.push(e.message); return e.name === 'AuthError' && e.code === 403; },
      name,
    );
  }
  assert.strictEqual(new Set(denials).size, 1, `refusals differ: ${denials.join(' | ')}`);
  ok('a wrong password, an unknown address and a passwordless invite all refuse identically');

  // --- which methods this client offers ----------------------------------------
  await moduleService.saveSettings(AGENT, 'google-auth', { methods: 'google' }, 'verification');
  await assert.rejects(
    () => signin.signInWithPassword(WITH_PASSWORD, SECRET, AGENT),
    e => e.name === 'AuthError' && e.code === 403 && /Google/.test(e.message),
    'password sign-in must be refused when the client is Google only',
  );
  ok('password sign-in is refused where the client is set to Google only');

  await moduleService.saveSettings(AGENT, 'google-auth', { methods: 'password' }, 'verification');
  await assert.rejects(
    () => signin.signInWithGoogle('any-token', AGENT),
    e => e.name === 'AuthError' && e.code === 403 && /email and password/.test(e.message),
    'google sign-in must be refused when the client is password only',
  );
  ok('google sign-in is refused where the client is set to password only');

  await moduleService.saveSettings(AGENT, 'google-auth', { methods: 'both' }, 'verification');
  assert.strictEqual((await signin.signInWithPassword(WITH_PASSWORD, SECRET, AGENT)).via, 'password');
  ok('both works again once the setting allows it');

  // --- revoking ---------------------------------------------------------------
  await drizzle.update(allowedEmails)
    .set({ revokedAt: new Date() })
    .where(eq(allowedEmails.email, WITH_PASSWORD));
  await assert.rejects(
    () => signin.signInWithPassword(WITH_PASSWORD, SECRET, AGENT),
    e => e.name === 'AuthError' && e.code === 403,
    'a revoked invitation must stop working even with the right password',
  );
  ok('revoking stops a password that is still correct');

  // --- global grants ----------------------------------------------------------
  await drizzle.insert(allowedEmails)
    .values({ email: STRANGER, tenant: null, role: 'user', invitedBy: 'verification' });
  for (const agent of [AGENT, 'zolstock', 'hypertoy']) {
    assert.ok(await signin.grantFor(STRANGER, agent), `global grant should work on ${agent}`);
  }
  ok('a grant with no tenant works on every agent');

  // --- the hashing itself -------------------------------------------------------
  const h = await passwords.hash(SECRET);
  assert.ok(h.startsWith('scrypt$'));
  assert.notStrictEqual(h, await passwords.hash(SECRET));
  ok('the same password hashes differently every time, so the salt is real');

  assert.strictEqual(await passwords.verify(SECRET, h), true);
  assert.strictEqual(await passwords.verify(SECRET + 'x', h), false);
  assert.strictEqual(await passwords.verify(SECRET, 'not-a-hash'), false);
  ok('verify accepts the right password, rejects the wrong one and survives a corrupt hash');

  await assert.rejects(() => passwords.hash('short'), e => e.name === 'ValidationError');
  ok('a password under the minimum length is refused');

  console.log(`\n   ${passed} checks passed`);
}

async function cleanup() {
  try {
    const drizzle = db.getDrizzle();
    if (drizzle) {
      await drizzle.execute(
        `DELETE FROM allowed_emails WHERE invited_by = 'verification'`);
      await drizzle.execute(
        `DELETE FROM users WHERE external_id LIKE 'email_%-check@example.com'`);
      const left = await drizzle.execute('SELECT count(*)::int AS n FROM allowed_emails');
      console.log(`   cleaned up — ${(left.rows || left)[0].n} invitation(s) remain`);
    }
    if (restoreModule) await restoreModule();
  } catch (err) {
    console.error('cleanup failed:', err.message);
  }
}

run()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async err => {
    console.error('\nFAILED:', err.message);
    await cleanup();
    process.exit(1);
  });
