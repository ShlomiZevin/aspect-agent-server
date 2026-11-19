/**
 * The management center for non-technical users (task #985) — its API.
 * Client: `/lybi/manage/<slug>` and `/lybi/manage/all` (aspect-react-client/src/manage/;
 * the old `/manage/...` links redirect there).
 *
 * Signing in (open):
 *   GET  /api/manage/auth/config        { clientId } — the Google OAuth web client
 *   POST /api/manage/auth/google        { idToken } → { token, expiresAt, me }
 *        403 { code: 'no_access', email } when that address has no grant
 *
 * Everything else needs `Authorization: Bearer <token>` (401 code
 * 'signed_out' without a valid one) AND a grant in `manage_access` (403
 * code 'no_access'), re-read on every request:
 *   GET /api/manage/me
 *       { email, name, picture, all, agents: [{ slug, name, archived }] }
 *   GET /api/manage/agents/:slug/customer-problems?range=today|week
 *       one agent's customer-chat problems (403 'no_agent_access' if not theirs)
 *   GET /api/manage/agents/:slug/conversations/:id
 *       one customer conversation's basic facts + last messages (the "צפייה" window)
 *   GET /api/manage/customer-problems?range=today|week[&agent=<slug>]
 *       every agent — only for an every-agent grant (403 'not_all' otherwise)
 *   GET    /api/manage/agents/:slug/users               the agent's customer-chat users (real / test)
 *   GET    /api/manage/agents/:slug/users/:id           one user + their customer conversations
 *   POST   /api/manage/agents/:slug/users/:id/suspend        { suspended: bool }
 *   POST   /api/manage/agents/:slug/users/:id/real-customer  { real: bool }
 *   DELETE /api/manage/agents/:slug/users/:id
 *       (404 'no_user' if not a user of that agent; 409 'user_shared' when
 *       the person belongs to other agents too — the actions act on the person)
 *   GET    /api/manage/users[?agent=<slug>]             every agent's users (every-agent grant only)
 *
 * Who is who: builder/services/manageSession.js (the token — identity only)
 * and builder/services/manageAccess.js (the grants). The problem words come
 * from builder/services/customerProblems.js — the MCP prints the same ones.
 */

const express = require('express');
const customerProblems = require('../services/customerProblems');
const manageAccess = require('../services/manageAccess');
const manageSession = require('../services/manageSession');
const manageConversation = require('../services/manageConversation');
const manageUsers = require('../services/manageUsers');

// Loaded on first use: it pulls the Aspect sign-in stack (modules,
// conversations, insights) that nothing else here needs. We use only its
// Google-token check (audience = our OAuth client, verified email).
const googleAuth = () => require('../../services/google-auth.service');

const router = express.Router();

function fail(res, err, what) {
  console.error(`[manage] ${what} failed:`, err);
  res.status(500).json({ error: err.message });
}

// ─── Signing in ────────────────────────────────────────────────────

router.get('/auth/config', (_req, res) => {
  const g = googleAuth();
  res.json({ clientId: g.isConfigured() ? g.CLIENT_ID : '' });
});

router.post('/auth/google', async (req, res) => {
  let identity;
  try {
    identity = await googleAuth().verify(req.body && req.body.idToken);
  } catch (err) {
    if (err.name === 'AuthError') return res.status(err.code || 401).json({ error: err.message, code: 'google_failed' });
    return fail(res, err, 'Google sign-in');
  }
  try {
    const grants = await manageAccess.grantsFor(identity.email);
    if (!grants) {
      // Say which address it was, so a wrong Google account is obvious.
      return res.status(403).json({ error: 'No access for this address', code: 'no_access', email: identity.email });
    }
    const { token, expiresAt } = await manageSession.issue(identity);
    res.json({ token, expiresAt, me: await meOf({ ...identity, ...grants }) });
  } catch (err) {
    fail(res, err, 'sign-in');
  }
});

// ─── The door: who, and may they ───────────────────────────────────

async function requireManageUser(req, res, next) {
  try {
    const who = await manageSession.verify(manageSession.fromRequest(req));
    if (!who) return res.status(401).json({ error: 'Sign in first', code: 'signed_out' });
    const grants = await manageAccess.grantsFor(who.email);
    if (!grants) return res.status(403).json({ error: 'No access for this address', code: 'no_access', email: who.email });
    req.manageUser = { ...who, ...grants };
    next();
  } catch (err) {
    fail(res, err, 'checking the session');
  }
}

async function requireAgentAccess(req, res, next) {
  try {
    const { exists, allowed } = await manageAccess.canOpen(req.manageUser, req.params.slug);
    // An every-agent person may learn that a slug does not exist; anyone
    // else gets the same answer for "not yours" and "no such agent".
    if (!exists && req.manageUser.all) return res.status(404).json({ error: `No agent "${req.params.slug}".`, code: 'no_agent' });
    if (!allowed) return res.status(403).json({ error: 'No access to this agent', code: 'no_agent_access' });
    next();
  } catch (err) {
    fail(res, err, 'checking agent access');
  }
}

function requireAll(req, res, next) {
  if (!req.manageUser.all) return res.status(403).json({ error: 'Every-agent view is for an every-agent grant', code: 'not_all' });
  next();
}

async function meOf(user) {
  const agents = await manageAccess.agentsFor(user);
  return {
    email: user.email,
    name: user.name || user.email,
    picture: user.picture || null,
    all: !!user.all,
    agents: agents.map(a => ({ slug: a.slug, name: a.name, archived: a.archived })),
  };
}

router.use(requireManageUser);

router.get('/me', async (req, res) => {
  try {
    res.json(await meOf(req.manageUser));
  } catch (err) {
    fail(res, err, 'me');
  }
});

// ─── Pages ─────────────────────────────────────────────────────────

router.get('/agents/:slug/customer-problems', requireAgentAccess, async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const data = await customerProblems.listProblems({ slug, range: req.query.range });
    res.json({ scope: 'agent', agent: data.agents.find(a => a.slug === slug) || { slug, name: slug }, ...data });
  } catch (err) {
    fail(res, err, 'customer problems');
  }
});

router.get('/agents/:slug/conversations/:id', requireAgentAccess, async (req, res) => {
  try {
    const conv = await manageConversation.getConversation({ slug: req.params.slug, conversationId: req.params.id });
    if (!conv) return res.status(404).json({ error: 'No such customer conversation on this agent', code: 'no_conversation' });
    res.json(conv);
  } catch (err) {
    fail(res, err, 'conversation');
  }
});

// ─── Users (tasks #999, #982, #991) ────────────────────────────────
// builder/services/manageUsers.js: the agent's customer-chat users, real /
// test by the "Real customer" mark (#968). The actions reuse Admin's own
// operations (services/admin.service.js) and refuse a person who belongs
// to other agents too (409 user_shared) — suspend / delete act on the person.

function userFail(res, err, what) {
  if (err instanceof manageUsers.UserActionError) return res.status(err.status).json({ error: err.message, code: err.code });
  return fail(res, err, what);
}

router.get('/agents/:slug/users', requireAgentAccess, async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const data = await manageUsers.listUsers({ slug });
    res.json({ scope: 'agent', agentSlug: slug, ...data });
  } catch (err) {
    fail(res, err, 'users');
  }
});

router.get('/agents/:slug/users/:userId', requireAgentAccess, async (req, res) => {
  try {
    const user = await manageUsers.getUser({ slug: req.params.slug, userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'No such user on this agent', code: 'no_user' });
    const conversations = await manageUsers.listConversations({ slug: req.params.slug, userId: user.id });
    res.json({ user, conversations, shownConversations: manageUsers.MAX_CONVERSATIONS });
  } catch (err) {
    fail(res, err, 'user');
  }
});

router.post('/agents/:slug/users/:userId/suspend', requireAgentAccess, async (req, res) => {
  try {
    const user = await manageUsers.setSuspended({ slug: req.params.slug, userId: req.params.userId, suspended: req.body?.suspended !== false });
    res.json({ user });
  } catch (err) {
    userFail(res, err, 'suspend user');
  }
});

router.post('/agents/:slug/users/:userId/real-customer', requireAgentAccess, async (req, res) => {
  try {
    const user = await manageUsers.setRealCustomer({ slug: req.params.slug, userId: req.params.userId, real: req.body?.real === true });
    res.json({ user });
  } catch (err) {
    userFail(res, err, 'mark real customer');
  }
});

router.delete('/agents/:slug/users/:userId', requireAgentAccess, async (req, res) => {
  try {
    res.json(await manageUsers.deleteUser({ slug: req.params.slug, userId: req.params.userId }));
  } catch (err) {
    userFail(res, err, 'delete user');
  }
});

router.get('/users', requireAll, async (req, res) => {
  try {
    const agent = req.query.agent ? String(req.query.agent) : null;
    const data = await manageUsers.listUsers({ slug: agent });
    res.json({ scope: 'all', agentSlug: null, filter: agent, ...data });
  } catch (err) {
    fail(res, err, 'all users');
  }
});

router.get('/customer-problems', requireAll, async (req, res) => {
  try {
    const agent = req.query.agent ? String(req.query.agent) : null;
    const [everyone, data] = await Promise.all([
      customerProblems.listProblems({ slug: null, range: req.query.range }),
      agent ? customerProblems.listProblems({ slug: agent, range: req.query.range }) : null,
    ]);
    const view = data || everyone;
    res.json({ scope: 'all', agent: null, filter: agent, ...view, agents: everyone.agents });
  } catch (err) {
    fail(res, err, 'all customer problems');
  }
});

module.exports = router;
