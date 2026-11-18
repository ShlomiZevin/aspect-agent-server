/**
 * Who may use the management center (task #985), and on which agents.
 *
 * The grants live in `manage_access` (migration 070): one row per grant,
 * `agent_id` NULL = every agent (the Lybi team), otherwise one Builder
 * agent. Nothing here caches: the routes ask on every request, so a deleted
 * grant closes the door at once, whatever session token the browser holds.
 *
 * Read by builder/routes/manageRoute.js (the door) and the Builder MCP
 * (`/access`, `/agents/<slug>/access` — read only; granting is done in the
 * database for now, by decision).
 */

const db = require('../../services/db.pg');

/** Lowercased, trimmed — the shape the table's CHECK enforces. */
function cleanEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * One person's grants.
 * @returns {Promise<{ email: string, all: boolean, agentIds: string[] } | null>}
 *   null = no grant at all (not allowed in).
 */
async function grantsFor(email) {
  const clean = cleanEmail(email);
  if (!clean) return null;
  const { rows } = await db.query(
    `SELECT agent_id FROM manage_access WHERE email = $1`,
    [clean],
  );
  if (!rows.length) return null;
  return {
    email: clean,
    all: rows.some(r => r.agent_id === null),
    agentIds: rows.filter(r => r.agent_id !== null).map(r => r.agent_id),
  };
}

/** Builder agents with their display name (active version), all or some ids. */
async function agentsById(ids) {
  const { rows } = await db.query(
    `SELECT a.id, a.slug, COALESCE(NULLIF(v.body->>'name', ''), a.slug) AS name, a.archived_at
       FROM builder_agents a
       LEFT JOIN builder_agent_versions v ON v.id = a.active_version_id
      WHERE ($1::text[] IS NULL OR a.id = ANY($1::text[]))
      ORDER BY lower(COALESCE(NULLIF(v.body->>'name', ''), a.slug))`,
    [ids || null],
  );
  return rows.map(r => ({ id: r.id, slug: r.slug, name: r.name, archived: !!r.archived_at }));
}

/**
 * What a person sees: every agent (all) or their own.
 * @param {{ all: boolean, agentIds: string[] }} grants
 * @returns {Promise<Array<{ id, slug, name, archived }>>}
 */
async function agentsFor(grants) {
  if (!grants) return [];
  if (grants.all) return agentsById(null);
  if (!grants.agentIds.length) return [];
  return agentsById(grants.agentIds);
}

/**
 * May this person open the agent with this slug?
 * Slugs are unique per project only, so a slug can name more than one
 * agent: any of them granted is enough.
 * @returns {Promise<{ exists: boolean, allowed: boolean }>}
 */
async function canOpen(grants, slug) {
  const { rows } = await db.query(
    `SELECT id FROM builder_agents WHERE slug = $1`,
    [String(slug)],
  );
  const exists = rows.length > 0;
  if (!grants || !exists) return { exists, allowed: false };
  if (grants.all) return { exists, allowed: true };
  return { exists, allowed: rows.some(r => grants.agentIds.includes(r.id)) };
}

/**
 * Every grant, for the MCP — the person's email, and the agent (or null =
 * every agent).
 * @returns {Promise<Array<{ email, agent: { id, slug, name } | null, note, grantedBy, createdAt }>>}
 */
async function listGrants({ slug = null } = {}) {
  const { rows } = await db.query(
    `SELECT m.email, m.agent_id, m.note, m.granted_by, m.created_at,
            a.slug, COALESCE(NULLIF(v.body->>'name', ''), a.slug) AS name
       FROM manage_access m
       LEFT JOIN builder_agents a ON a.id = m.agent_id
       LEFT JOIN builder_agent_versions v ON v.id = a.active_version_id
      WHERE ($1::text IS NULL OR m.agent_id IS NULL OR a.slug = $1)
      ORDER BY (m.agent_id IS NOT NULL), m.email, a.slug`,
    [slug || null],
  );
  return rows.map(r => ({
    email: r.email,
    agent: r.agent_id ? { id: r.agent_id, slug: r.slug, name: r.name } : null,
    note: r.note || null,
    grantedBy: r.granted_by || null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
}

module.exports = { cleanEmail, grantsFor, agentsFor, canOpen, listGrants };
