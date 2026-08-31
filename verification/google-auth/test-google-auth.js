require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const assert = require('assert');
const db = require('../../services/db.pg');
const { allowedEmails } = require('../../db/schema');
const { eq } = require('drizzle-orm');
const googleAuth = require('../../services/google-auth.service');
const moduleService = require('../../modules/services/module.service');
const registry = require('../../modules/registry');

/**
 * Checks the Google sign-in gate against the real platform DB.
 *
 * What is NOT tested here is token verification: that would need a real Google
 * credential, and google-auth-library is the thing doing it. What IS tested is
 * everything we wrote around it — the module gate, the invitation lookup, the
 * domain rule, and the order between them — because that is where an access
 * decision can be got wrong quietly.
 *
 *   node verification/google-auth/test-google-auth.js
 *
 * Removes every row it creates, including on failure.
 */
const AGENT = 'aspect';
const INVITED = 'invited-check@example.com';
const DOMAIN_USER = 'someone@check-domain.example';
const STRANGER = 'stranger-check@example.com';

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
    if (before?.settings?.allowedDomain !== undefined) {
      await moduleService.saveSettings(AGENT, 'google-auth', before.settings, 'verification');
    }
  };

  assert.strictEqual(await googleAuth.isLiveFor(AGENT), false);
  ok('not live until it is switched on');

  await assert.rejects(
    () => googleAuth.signIn('any-token', AGENT),
    e => e.name === 'AuthError' && e.code === 403 && /not enabled/.test(e.message),
    'signing in against a disabled module must be refused before anything else',
  );
  ok('sign-in is refused while the module is off — before the token is even read');

  // --- switched on ------------------------------------------------------------
  const live = await moduleService.setEnabled(AGENT, 'google-auth', true, 'verification');
  assert.strictEqual(live.live, true);
  ok('enabling makes it live with no init run');

  // --- invitations ------------------------------------------------------------
  await drizzle.insert(allowedEmails)
    .values({ email: INVITED, tenant: AGENT, role: 'admin', invitedBy: 'verification' });

  const invited = await googleAuth.authorize(INVITED, AGENT);
  assert.deepStrictEqual(invited, { allowed: true, role: 'admin', via: 'invitation' });
  ok('an invited address is allowed, with the role it was invited as');

  const elsewhere = await googleAuth.authorize(INVITED, 'zolstock');
  assert.strictEqual(elsewhere.allowed, false);
  ok('the same invitation does not carry to another agent');

  const stranger = await googleAuth.authorize(STRANGER, AGENT);
  assert.strictEqual(stranger.allowed, false);
  ok('an address nobody invited is refused');

  // --- domain auto-approval ---------------------------------------------------
  let domain = await googleAuth.authorize(DOMAIN_USER, AGENT);
  assert.strictEqual(domain.allowed, false);
  ok('the domain rule does nothing until a domain is configured');

  await moduleService.saveSettings(AGENT, 'google-auth', { allowedDomain: 'check-domain.example' }, 'verification');
  domain = await googleAuth.authorize(DOMAIN_USER, AGENT);
  assert.deepStrictEqual(domain, { allowed: true, role: 'user', via: 'domain' });
  ok('a matching domain is allowed, as a plain user');

  const nearMiss = await googleAuth.authorize('evil@notcheck-domain.example', AGENT);
  assert.strictEqual(nearMiss.allowed, false);
  ok('a domain that merely ends similarly is refused');

  // The order matters: a domain match only ever grants 'user', so checking it
  // first would silently demote someone invited as an admin.
  await drizzle.insert(allowedEmails)
    .values({ email: `admin@check-domain.example`, tenant: AGENT, role: 'admin', invitedBy: 'verification' });
  const both = await googleAuth.authorize('admin@check-domain.example', AGENT);
  assert.deepStrictEqual(both, { allowed: true, role: 'admin', via: 'invitation' });
  ok('an invitation wins over the domain rule, so an admin is not demoted');

  // --- revoking ---------------------------------------------------------------
  await drizzle.update(allowedEmails)
    .set({ revokedAt: new Date() })
    .where(eq(allowedEmails.email, INVITED));
  const revoked = await googleAuth.authorize(INVITED, AGENT);
  assert.strictEqual(revoked.allowed, false);
  ok('a revoked invitation stops working');

  // --- global grants ----------------------------------------------------------
  await drizzle.insert(allowedEmails)
    .values({ email: STRANGER, tenant: null, role: 'user', invitedBy: 'verification' });
  for (const agent of [AGENT, 'zolstock', 'hypertoy']) {
    const g = await googleAuth.authorize(STRANGER, agent);
    assert.strictEqual(g.allowed, true, `global grant should work on ${agent}`);
  }
  ok('a grant with no tenant works on every agent');

  console.log(`\n   ${passed} checks passed`);
}

async function cleanup() {
  try {
    const drizzle = db.getDrizzle();
    if (drizzle) {
      await drizzle.execute(
        `DELETE FROM allowed_emails WHERE invited_by = 'verification'`);
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
