/**
 * The users of an agent's customer chat (tasks #999, #982, #991) — the
 * management center's "Users" page and the Builder MCP's
 * `/agents/<slug>/users`. Read here; the actions (add user, suspend, real
 * customer, turn auto-suspend off, delete) reuse services/admin.service.js — the same operations Admin →
 * Users runs — after the checks below. No table or column of its own: it
 * reads `users` and `conversations` as they are.
 *
 * ── Who is a user of an agent ──────────────────────────────────────
 *
 *  A person who talked to it in the CUSTOMER chat (`conversations.kind =
 *  'user'`, `metadata.kind = 'live'`), or who was created for it (Admin →
 *  Users → Add user writes `users.tenant = <slug>`), so a new user shows
 *  before their first conversation. Builder test-chat owners and
 *  simulations are not users of the customer chat and are left out, and so
 *  are synthetic personas (`metadata.synthetic`, hidden in Admin too).
 *
 * ── Real or test ───────────────────────────────────────────────────
 *
 *  `users.metadata.realCustomer === true` (#968, the "Real customer" tick)
 *  = a real customer; anything else = a test user. Same rule as
 *  builder/runtime/conversationAudience.js `isRealCustomer`.
 *
 * ── Shared users ───────────────────────────────────────────────────
 *
 *  `users` is one table for every agent, and the actions are per person:
 *  suspending stops them on every agent, deleting removes ALL their
 *  conversations. So an action from one agent's page is allowed only on a
 *  person who belongs to that agent alone — no conversation on any other
 *  agent and no other agent's tenant. Anyone else is `shared` and the
 *  actions refuse (409 `user_shared`); the Lybi team handles them in Admin.
 */

const db = require('../../services/db.pg');
const manageAccess = require('./manageAccess');
const { suspensionOf, AUTO_SUSPEND_HOURS } = require('../runtime/userSuspension');

const MAX_USERS = 1000;
const MAX_CONVERSATIONS = 50;
const iso = v => (v ? new Date(v).toISOString() : null);

// One row per (user, agent): a person on two agents is two rows in "all".
// $1 = builder agent slugs (lowercased), $2 = one slug or NULL, $3 = one user id or NULL.
const MEMBERS = `
  WITH live AS (
    SELECT c.user_id, lower(a.url_slug) AS slug, COUNT(*)::int AS conversations,
           MAX(c.last_user_message_at) AS last_customer_at
      FROM conversations c
      JOIN agents a ON a.id = c.agent_id
     WHERE c.kind = 'user' AND c.metadata->>'kind' = 'live' AND c.status <> 'deleted'
       AND c.user_id IS NOT NULL
       AND lower(a.url_slug) = ANY($1::text[])
       AND ($2::text IS NULL OR lower(a.url_slug) = $2)
       AND ($3::int IS NULL OR c.user_id = $3)
     GROUP BY c.user_id, lower(a.url_slug)
  ), member AS (
    SELECT user_id, slug FROM live
    UNION
    SELECT u.id, lower(u.tenant) FROM users u
     WHERE lower(u.tenant) = ANY($1::text[])
       AND ($2::text IS NULL OR lower(u.tenant) = $2)
       AND ($3::int IS NULL OR u.id = $3)
  )
  SELECT u.id, NULLIF(u.name, '') AS name, NULLIF(u.phone, '') AS phone, NULLIF(u.email, '') AS email,
         u.external_id, u.created_at, u.last_active_at,
         (u.metadata->>'realCustomer') = 'true' AS real_customer,
         u.metadata->>'suspendedAt' AS suspended_at,
         u.metadata->>'autoSuspendAt' AS auto_suspend_at,
         m.slug, COALESCE(l.conversations, 0) AS conversations,
         GREATEST(u.last_active_at, l.last_customer_at) AS last_seen,
         (EXISTS (SELECT 1 FROM conversations c2 LEFT JOIN agents a2 ON a2.id = c2.agent_id
                   WHERE c2.user_id = u.id AND lower(COALESCE(a2.url_slug, '')) <> m.slug)
           OR (COALESCE(u.tenant, '') <> '' AND lower(u.tenant) <> m.slug)) AS shared
    FROM member m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN live l ON l.user_id = m.user_id AND l.slug = m.slug
   WHERE (u.metadata->>'synthetic' IS NULL OR u.metadata->>'synthetic' = 'false')
   ORDER BY GREATEST(u.last_active_at, l.last_customer_at) DESC NULLS LAST, u.created_at DESC, u.id DESC
   LIMIT ${MAX_USERS + 1}`;

/** Every Builder agent, slug → name (the active version's name). */
async function agentNames() {
  const all = await manageAccess.agentsFor({ all: true, agentIds: [] });
  const map = new Map();
  for (const a of all) if (!map.has(a.slug.toLowerCase())) map.set(a.slug.toLowerCase(), a);
  return map;
}

function shape(r, names) {
  const agent = names.get(r.slug);
  // Suspended by an admin, or by the auto-suspend time passing (#1002) —
  // decided as of now, the same helper the runtime enforces with.
  const s = suspensionOf({ suspendedAt: r.suspended_at, autoSuspendAt: r.auto_suspend_at });
  return {
    id: r.id,
    name: r.name || null,
    phone: r.phone || null,
    email: r.email || null,
    externalId: r.external_id || null,
    audience: r.real_customer ? 'real' : 'test',
    suspended: s.suspended,
    suspendedAt: s.suspendedAt,
    autoSuspendAt: s.autoSuspendAt,
    autoSuspended: s.auto,
    agentSlug: agent ? agent.slug : r.slug,
    agentName: agent ? agent.name : r.slug,
    conversations: Number(r.conversations) || 0,
    createdAt: iso(r.created_at),
    lastActiveAt: iso(r.last_seen),
    shared: !!r.shared,
  };
}

/**
 * The users of one agent (slug) or of every Builder agent (slug = null).
 * @returns {Promise<{ users: object[], real: number, test: number, truncated: boolean, limit: number, checkedAt: string }>}
 */
async function listUsers({ slug = null } = {}) {
  const names = await agentNames();
  const one = slug ? String(slug).toLowerCase() : null;
  if (one && !names.has(one)) return { users: [], real: 0, test: 0, truncated: false, limit: MAX_USERS, checkedAt: new Date().toISOString() };
  const { rows } = await db.query(MEMBERS, [[...names.keys()], one, null]);
  const users = rows.slice(0, MAX_USERS).map(r => shape(r, names));
  return {
    users,
    real: users.filter(u => u.audience === 'real').length,
    test: users.filter(u => u.audience === 'test').length,
    truncated: rows.length > MAX_USERS,
    limit: MAX_USERS,
    checkedAt: new Date().toISOString(),
  };
}

/** One user of one agent, or null when they are not a user of it. */
async function getUser({ slug, userId }) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const names = await agentNames();
  const one = String(slug).toLowerCase();
  if (!names.has(one)) return null;
  const { rows } = await db.query(MEMBERS, [[...names.keys()], one, id]);
  return rows[0] ? shape(rows[0], names) : null;
}

/** One user's customer-chat conversations on one agent, newest first (the user window). */
async function listConversations({ slug, userId }) {
  const { rows } = await db.query(
    `SELECT c.id, c.created_at, c.last_message_at, c.metadata->>'audience' AS audience,
            (SELECT COALESCE(NULLIF(cv.body->>'name', ''), cr.id)
               FROM builder_crews cr LEFT JOIN builder_crew_versions cv ON cv.id = cr.active_version_id
              WHERE cr.id = c.metadata->>'currentCrewId') AS phase,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant') AND m.content <> '') AS message_count
       FROM conversations c
       JOIN agents a ON a.id = c.agent_id
      WHERE c.user_id = $1 AND lower(a.url_slug) = $2
        AND c.kind = 'user' AND c.metadata->>'kind' = 'live' AND c.status <> 'deleted'
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
      LIMIT ${MAX_CONVERSATIONS}`,
    [Number(userId), String(slug).toLowerCase()],
  );
  return rows.map(c => ({
    id: c.id,
    startedAt: iso(c.created_at),
    lastActivityAt: iso(c.last_message_at),
    audience: c.audience === 'real' ? 'real' : 'test',
    phase: c.phase || null,
    messageCount: Number(c.message_count) || 0,
  }));
}

/** A refused action — the route turns it into its HTTP answer. */
class UserActionError extends Error {
  constructor(message, status, code) { super(message); this.name = 'UserActionError'; this.status = status; this.code = code; }
}

// Loaded on first action only: it pulls drizzle and the schema.
const admin = () => require('../../services/admin.service');

async function actionable({ slug, userId }) {
  const user = await getUser({ slug, userId });
  if (!user) throw new UserActionError('No such user on this agent', 404, 'no_user');
  if (user.shared) throw new UserActionError('This user also belongs to other agents', 409, 'user_shared');
  return user;
}

/** Suspend / reactivate — admin.service `setSuspended` (#909). Returns the user as the page shows it. */
async function setSuspended({ slug, userId, suspended }) {
  const user = await actionable({ slug, userId });
  await admin().setSuspended(user.id, !!suspended);
  return getUser({ slug, userId: user.id });
}

/** Real customer or test — admin.service `setRealCustomer` (#968). */
async function setRealCustomer({ slug, userId, real }) {
  const user = await actionable({ slug, userId });
  await admin().setRealCustomer(user.id, !!real);
  return getUser({ slug, userId: user.id });
}

/**
 * Add a user for one agent (#1002 phase 2) — admin.service `createUser`,
 * the operation Admin → Users → Add user runs for a Builder agent: tenant =
 * the agent's slug (so they are its user before their first conversation),
 * demo / user, a test user until marked real. `autoSuspendHours` 24 / 48 /
 * null — suspended by itself that long after creation.
 */
async function createUser({ slug, name, phone, autoSuspendHours = null }) {
  const names = await agentNames();
  const agent = names.get(String(slug).toLowerCase());
  if (!agent) throw new UserActionError('No such agent', 404, 'no_agent');
  const n = String(name || '').trim();
  const ph = String(phone || '').trim();
  if (!n || !ph) throw new UserActionError('Name and phone are required', 400, 'bad_user');
  const hours = autoSuspendHours == null || autoSuspendHours === '' ? null : Number(autoSuspendHours);
  if (hours !== null && !AUTO_SUSPEND_HOURS.includes(hours)) {
    throw new UserActionError(`Auto-suspend must be ${AUTO_SUSPEND_HOURS.join(' or ')} hours, or off`, 400, 'bad_user');
  }
  let made;
  try {
    made = await admin().createUser({ name: n, phone: ph, tenant: agent.slug, subscription: 'demo', role: 'user', autoSuspendHours: hours });
  } catch (err) {
    if (/already exists/.test(err.message)) throw new UserActionError('This agent already has a user with this name and phone', 409, 'user_exists');
    throw err;
  }
  return getUser({ slug: agent.slug, userId: made.id });
}

/** Turn the user's auto-suspend off — admin.service `clearAutoSuspend` (#1002). */
async function clearAutoSuspend({ slug, userId }) {
  const user = await actionable({ slug, userId });
  if (user.suspended) throw new UserActionError('Already suspended — reactivate instead', 409, 'already_suspended');
  await admin().clearAutoSuspend(user.id);
  return getUser({ slug, userId: user.id });
}

/** Delete the user and their conversations — admin.service `deleteUser`. */
async function deleteUser({ slug, userId }) {
  const user = await actionable({ slug, userId });
  const r = await admin().deleteUser(user.id);
  return { deleted: true, userId: user.id, conversations: r.deletedConversations || 0 };
}

module.exports = {
  listUsers, getUser, listConversations, setSuspended, setRealCustomer, deleteUser, createUser, clearAutoSuspend,
  UserActionError, MAX_USERS, MAX_CONVERSATIONS,
};
