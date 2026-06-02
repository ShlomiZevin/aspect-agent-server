/**
 * Builder V2 — Projects service.
 *
 * Pure DB layer over the five builder_* tables. Exposes:
 *   - hydrateProject(agentSlug, ownerUserId)     → full nested doc
 *   - createProject({ ownerUserId, slug, ... })  → bootstrap a project
 *
 * And surgical version actions used by the REST routes:
 *   - saveAgentVersion(versionId, body)
 *   - saveAgentVersionAs(agentId, versionId, body, description?)
 *   - setAgentActive(agentId, versionId)
 *   - setAgentViewing(agentId, versionId)
 *   - saveCrewVersion / saveCrewVersionAs / setCrewActive / setCrewViewing
 *   - createCrew({ agentId, crewId, versionId, body })
 *   - deleteCrew(crewId)
 *
 * Server doesn't validate inside the version `body` jsonb — the
 * shape comes from the client's TypeScript types (AgentBody /
 * CrewBody). The server accepts what it's sent.
 */

const db = require('../../services/db.pg');
const { eq, and, desc } = require('drizzle-orm');
const {
  builderProjects,
  builderAgents,
  builderAgentVersions,
  builderCrews,
  builderCrewVersions,
} = require('../../db/schema');

function drizzle() {
  return db.getDrizzle();
}

// ─── Hydration (denormalised "ProjectDoc" matching the client shape) ──

/**
 * Load everything the client needs to render the builder for an
 * (ownerUserId, agentSlug) pair as one nested ProjectDoc.
 * Returns null if the project doesn't exist yet.
 */
async function hydrateProject({ agentSlug, ownerUserId: _ownerUserId }) {
  const d = drizzle();

  // Find the agent by slug. Shared workspace: every owner sees every
  // agent during build phase, so we don't filter by owner here.
  // `_ownerUserId` is accepted for backward compat with callers that
  // still pass it; it's intentionally ignored.
  const agentRow = await d.select()
    .from(builderAgents)
    .innerJoin(builderProjects, eq(builderAgents.projectId, builderProjects.id))
    .where(eq(builderAgents.slug, agentSlug))
    .limit(1);

  if (agentRow.length === 0) return null;

  const agent = agentRow[0].builder_agents;
  const project = agentRow[0].builder_projects;

  // All agent versions for this agent.
  const agentVersions = await d.select()
    .from(builderAgentVersions)
    .where(eq(builderAgentVersions.agentId, agent.id))
    .orderBy(desc(builderAgentVersions.number));

  // Build the working-copy agent fields from the viewing version's body.
  const viewing = agentVersions.find(v => v.id === agent.viewingVersionId);
  const agentBody = viewing ? viewing.body : {};

  // All crews of this agent.
  const crewRows = await d.select()
    .from(builderCrews)
    .where(eq(builderCrews.agentId, agent.id));

  const crews = [];
  for (const c of crewRows) {
    const crewVersions = await d.select()
      .from(builderCrewVersions)
      .where(eq(builderCrewVersions.crewId, c.id))
      .orderBy(desc(builderCrewVersions.number));
    const crewViewing = crewVersions.find(v => v.id === c.viewingVersionId);
    const crewBody = crewViewing ? crewViewing.body : {};
    // Phase B: migrate the addon shapes on read so the client always
    // sees the new template-owns-placement form. Source data may still
    // be in the old structured-context shape; the migration is
    // idempotent and a no-op for already-migrated instances.
    const { migrateAddonInstance } = require('../runtime/migrateAddonContext');
    const rawAddons = Array.isArray(crewBody.addons) ? crewBody.addons : [];
    const migratedAddons = rawAddons.map(migrateAddonInstance);

    crews.push({
      id: c.id,
      // Working-copy fields come from the viewing version body.
      name:         crewBody.name        || '',
      description:  crewBody.description  || '',
      spec:         crewBody.spec         || '',
      persona:      crewBody.persona,
      addons:       migratedAddons,
      fields:       Array.isArray(crewBody.fields) ? crewBody.fields : [],
      // Version metadata (client format).
      versions: crewVersions.map(v => ({
        id:           v.id,
        number:       v.number,
        description:  v.description || undefined,
        createdAt:    v.createdAt.toISOString(),
        body:         v.body,
      })),
      activeVersionId:  c.activeVersionId,
      viewingVersionId: c.viewingVersionId,
    });
  }

  // Build the full nested ProjectDoc the client expects.
  return {
    id:   project.id,
    name: project.name,
    spec: project.spec,
    agents: [{
      id:      agent.id,
      slug:    agent.slug,
      // Working-copy fields from viewing.
      name:           agentBody.name           || agent.slug,
      spec:           agentBody.spec           || '',
      persona:        agentBody.persona        || '',
      defaultCrewId:  agentBody.defaultCrewId,
      fields:         Array.isArray(agentBody.fields)     ? agentBody.fields     : [],
      domains:        Array.isArray(agentBody.domains)    ? agentBody.domains    : [],
      parameters:     Array.isArray(agentBody.parameters) ? agentBody.parameters : [],
      crews,
      versions: agentVersions.map(v => ({
        id:           v.id,
        number:       v.number,
        description:  v.description || undefined,
        createdAt:    v.createdAt.toISOString(),
        body:         v.body,
      })),
      activeVersionId:  agent.activeVersionId,
      viewingVersionId: agent.viewingVersionId,
    }],
  };
}

/**
 * List all projects owned by a user. Returns a flat array sorted by
 * recency (most-recently-touched agent first). Each row carries the
 * human-readable agent name (from the active version body), the slug
 * (used by the URL), and the project name.
 *
 * Used by the BuilderHomePage to render the "Your agents" list.
 */
async function listProjects({ ownerUserId: _ownerUserId } = {}) {
  // Shared workspace during build phase — every agent is visible to
  // every browser. `_ownerUserId` is accepted for backward compat with
  // existing callers; intentionally ignored. Order: most-recently-edited
  // first so active work surfaces at the top of the list.
  const d = drizzle();
  const rows = await d.select({
    projectId:   builderProjects.id,
    projectName: builderProjects.name,
    agentId:     builderAgents.id,
    agentSlug:   builderAgents.slug,
    agentBody:   builderAgentVersions.body,
    updatedAt:   builderAgents.updatedAt,
  })
    .from(builderProjects)
    .innerJoin(builderAgents, eq(builderAgents.projectId, builderProjects.id))
    .leftJoin(
      builderAgentVersions,
      eq(builderAgentVersions.id, builderAgents.activeVersionId),
    )
    .orderBy(desc(builderAgents.updatedAt));

  return rows.map(r => ({
    projectId:   r.projectId,
    projectName: r.projectName,
    agentSlug:   r.agentSlug,
    // Active version body holds the canonical agent name. Fall back
    // to the slug when the agent has no versions yet (shouldn't happen
    // in practice — bootstrap creates v1 — but cheap defensive default).
    agentName:   (r.agentBody && r.agentBody.name) || r.agentSlug,
    updatedAt:   r.updatedAt.toISOString(),
  }));
}

// ─── Bootstrap a new project ──────────────────────────────────────

async function createProject({
  ownerUserId,
  projectId,
  projectName,
  agentId,
  agentSlug,
  agentVersionId,
  agentBody,           // { name, slug, spec, persona, defaultCrewId? }
  crewId,
  crewVersionId,
  crewBody,            // { name, description?, spec, persona?, addons: [...] }
}) {
  const d = drizzle();

  await d.transaction(async tx => {
    await tx.insert(builderProjects).values({
      id: projectId,
      ownerUserId,
      name: projectName || agentSlug,
      spec: '',
    });

    await tx.insert(builderAgents).values({
      id:               agentId,
      projectId,
      slug:             agentSlug,
      activeVersionId:  agentVersionId,
      viewingVersionId: agentVersionId,
    });

    await tx.insert(builderAgentVersions).values({
      id:          agentVersionId,
      agentId,
      number:      1,
      description: 'Initial',
      body:        agentBody,
    });

    await tx.insert(builderCrews).values({
      id:               crewId,
      agentId,
      activeVersionId:  crewVersionId,
      viewingVersionId: crewVersionId,
    });

    await tx.insert(builderCrewVersions).values({
      id:          crewVersionId,
      crewId,
      number:      1,
      description: 'Initial',
      body:        crewBody,
    });
  });
}

// ─── Agent version actions ────────────────────────────────────────

async function saveAgentVersion({ agentId, versionId, body }) {
  await drizzle()
    .update(builderAgentVersions)
    .set({ body, updatedAt: new Date() })
    .where(and(
      eq(builderAgentVersions.id, versionId),
      eq(builderAgentVersions.agentId, agentId),
    ));
}

async function saveAgentVersionAs({ agentId, versionId, body, description }) {
  const d = drizzle();
  await d.transaction(async tx => {
    // Compute next version number atomically by counting existing.
    const existing = await tx.select({ number: builderAgentVersions.number })
      .from(builderAgentVersions)
      .where(eq(builderAgentVersions.agentId, agentId))
      .orderBy(desc(builderAgentVersions.number))
      .limit(1);
    const nextNumber = (existing[0]?.number || 0) + 1;
    await tx.insert(builderAgentVersions).values({
      id:          versionId,
      agentId,
      number:      nextNumber,
      description: description || null,
      body,
    });
    await tx.update(builderAgents)
      .set({ viewingVersionId: versionId, updatedAt: new Date() })
      .where(eq(builderAgents.id, agentId));
  });
}

async function setAgentActive({ agentId, versionId }) {
  await drizzle()
    .update(builderAgents)
    .set({ activeVersionId: versionId, updatedAt: new Date() })
    .where(eq(builderAgents.id, agentId));
}

async function setAgentViewing({ agentId, versionId }) {
  await drizzle()
    .update(builderAgents)
    .set({ viewingVersionId: versionId, updatedAt: new Date() })
    .where(eq(builderAgents.id, agentId));
}

/**
 * Delete a single agent version. Refuses to delete:
 *   - the last remaining version (every entity must have ≥1)
 *   - the version currently flagged as active
 *   - the version currently flagged as viewing
 * The caller (UI) should force the user to switch viewing/active
 * first, then retry. Throws a labelled Error so the route can surface
 * the reason. Returns true on success.
 */
async function deleteAgentVersion({ agentId, versionId }) {
  const d = drizzle();
  await d.transaction(async tx => {
    const agentRows = await tx.select()
      .from(builderAgents)
      .where(eq(builderAgents.id, agentId))
      .limit(1);
    if (agentRows.length === 0) {
      const e = new Error('Agent not found');
      e.code = 'not_found';
      throw e;
    }
    const agent = agentRows[0];

    if (agent.activeVersionId === versionId) {
      const e = new Error('Cannot delete the active version. Set another version as active first.');
      e.code = 'is_active';
      throw e;
    }
    if (agent.viewingVersionId === versionId) {
      const e = new Error('Cannot delete the version you are viewing. Switch to another version first.');
      e.code = 'is_viewing';
      throw e;
    }

    const remaining = await tx.select({ id: builderAgentVersions.id })
      .from(builderAgentVersions)
      .where(eq(builderAgentVersions.agentId, agentId));
    if (remaining.length <= 1) {
      const e = new Error('Cannot delete the last remaining version.');
      e.code = 'last_version';
      throw e;
    }
    if (!remaining.some(r => r.id === versionId)) {
      const e = new Error('Version not found for this agent');
      e.code = 'not_found';
      throw e;
    }

    await tx.delete(builderAgentVersions)
      .where(and(
        eq(builderAgentVersions.id, versionId),
        eq(builderAgentVersions.agentId, agentId),
      ));
    await tx.update(builderAgents)
      .set({ updatedAt: new Date() })
      .where(eq(builderAgents.id, agentId));
  });
  return true;
}

// ─── Crew version actions ─────────────────────────────────────────

async function saveCrewVersion({ crewId, versionId, body }) {
  await drizzle()
    .update(builderCrewVersions)
    .set({ body, updatedAt: new Date() })
    .where(and(
      eq(builderCrewVersions.id, versionId),
      eq(builderCrewVersions.crewId, crewId),
    ));
}

async function saveCrewVersionAs({ crewId, versionId, body, description }) {
  const d = drizzle();
  await d.transaction(async tx => {
    const existing = await tx.select({ number: builderCrewVersions.number })
      .from(builderCrewVersions)
      .where(eq(builderCrewVersions.crewId, crewId))
      .orderBy(desc(builderCrewVersions.number))
      .limit(1);
    const nextNumber = (existing[0]?.number || 0) + 1;
    await tx.insert(builderCrewVersions).values({
      id:          versionId,
      crewId,
      number:      nextNumber,
      description: description || null,
      body,
    });
    await tx.update(builderCrews)
      .set({ viewingVersionId: versionId, updatedAt: new Date() })
      .where(eq(builderCrews.id, crewId));
  });
}

async function setCrewActive({ crewId, versionId }) {
  await drizzle()
    .update(builderCrews)
    .set({ activeVersionId: versionId, updatedAt: new Date() })
    .where(eq(builderCrews.id, crewId));
}

async function setCrewViewing({ crewId, versionId }) {
  await drizzle()
    .update(builderCrews)
    .set({ viewingVersionId: versionId, updatedAt: new Date() })
    .where(eq(builderCrews.id, crewId));
}

/**
 * Delete a single crew version. Same guard rules as the agent-side:
 * refuses the last remaining version, the active version, or the
 * version currently being viewed. Force the user to switch first.
 */
async function deleteCrewVersion({ crewId, versionId }) {
  const d = drizzle();
  await d.transaction(async tx => {
    const crewRows = await tx.select()
      .from(builderCrews)
      .where(eq(builderCrews.id, crewId))
      .limit(1);
    if (crewRows.length === 0) {
      const e = new Error('Crew not found');
      e.code = 'not_found';
      throw e;
    }
    const crew = crewRows[0];

    if (crew.activeVersionId === versionId) {
      const e = new Error('Cannot delete the active version. Set another version as active first.');
      e.code = 'is_active';
      throw e;
    }
    if (crew.viewingVersionId === versionId) {
      const e = new Error('Cannot delete the version you are viewing. Switch to another version first.');
      e.code = 'is_viewing';
      throw e;
    }

    const remaining = await tx.select({ id: builderCrewVersions.id })
      .from(builderCrewVersions)
      .where(eq(builderCrewVersions.crewId, crewId));
    if (remaining.length <= 1) {
      const e = new Error('Cannot delete the last remaining version.');
      e.code = 'last_version';
      throw e;
    }
    if (!remaining.some(r => r.id === versionId)) {
      const e = new Error('Version not found for this crew');
      e.code = 'not_found';
      throw e;
    }

    await tx.delete(builderCrewVersions)
      .where(and(
        eq(builderCrewVersions.id, versionId),
        eq(builderCrewVersions.crewId, crewId),
      ));
    await tx.update(builderCrews)
      .set({ updatedAt: new Date() })
      .where(eq(builderCrews.id, crewId));
  });
  return true;
}

async function createCrew({ agentId, crewId, versionId, body }) {
  const d = drizzle();
  await d.transaction(async tx => {
    await tx.insert(builderCrews).values({
      id:               crewId,
      agentId,
      activeVersionId:  versionId,
      viewingVersionId: versionId,
    });
    await tx.insert(builderCrewVersions).values({
      id:          versionId,
      crewId,
      number:      1,
      description: 'Initial',
      body,
    });
  });
}

async function deleteCrew({ crewId }) {
  const d = drizzle();
  await d.transaction(async tx => {
    // Versions are cascade-deletable via FK in a future migration;
    // until that's wired, delete manually.
    await tx.delete(builderCrewVersions).where(eq(builderCrewVersions.crewId, crewId));
    await tx.delete(builderCrews).where(eq(builderCrews.id, crewId));
  });
}

/**
 * Delete an entire project tree: every agent under it, each agent's
 * versions, each agent's crews, and each crew's versions. Wrapped in
 * one transaction so a mid-cascade failure leaves nothing half-deleted.
 *
 * Conversations, messages and addon_runs live under the legacy `agents`
 * table (not `builder_agents`) — those are left in place. Re-creating
 * the same slug later will reuse the legacy row and any old
 * conversation history reappears. Acceptable for the build phase; we
 * can cascade-clean later if it becomes noisy.
 */
async function deleteProject({ projectId }) {
  const d = drizzle();
  await d.transaction(async tx => {
    const agentRows = await tx.select({ id: builderAgents.id })
      .from(builderAgents)
      .where(eq(builderAgents.projectId, projectId));
    for (const a of agentRows) {
      const crewRows = await tx.select({ id: builderCrews.id })
        .from(builderCrews)
        .where(eq(builderCrews.agentId, a.id));
      for (const c of crewRows) {
        await tx.delete(builderCrewVersions).where(eq(builderCrewVersions.crewId, c.id));
      }
      await tx.delete(builderCrews).where(eq(builderCrews.agentId, a.id));
      await tx.delete(builderAgentVersions).where(eq(builderAgentVersions.agentId, a.id));
    }
    await tx.delete(builderAgents).where(eq(builderAgents.projectId, projectId));
    await tx.delete(builderProjects).where(eq(builderProjects.id, projectId));
  });
}

// ─── Resolve the runtime's "what to run" given an agent slug ──────

/**
 * Given an agentSlug + ownerUserId + version mode ('viewing' or
 * 'active'), return the addons to execute and metadata needed for
 * logging. Used by BuilderRunner.
 */
async function resolveRunnable({
  agentSlug,
  ownerUserId: _ownerUserId,
  mode = 'viewing',
  overrideCrewId    = null,
  overrideAgentBody = null,
  overrideCrewBody  = null,
}) {
  const d = drizzle();

  // Shared workspace — look up by slug only. `_ownerUserId` accepted
  // for backward compat; ignored. Same rule as hydrateProject /
  // listProjects so all three lookups agree on what's visible.
  const agentRow = await d.select()
    .from(builderAgents)
    .innerJoin(builderProjects, eq(builderAgents.projectId, builderProjects.id))
    .where(eq(builderAgents.slug, agentSlug))
    .limit(1);

  if (agentRow.length === 0) {
    throw new Error(`No builder project for agent slug "${agentSlug}"`);
  }

  const agent = agentRow[0].builder_agents;
  const agentVersionId = mode === 'active' ? agent.activeVersionId : agent.viewingVersionId;
  if (!agentVersionId) throw new Error('Agent has no version pointer');

  const [agentVersion] = await d.select()
    .from(builderAgentVersions)
    .where(eq(builderAgentVersions.id, agentVersionId))
    .limit(1);
  if (!agentVersion) throw new Error('Agent version row missing');

  // Builder preview path: the client may have sent the working-copy
  // body so the chat reflects unsaved edits. Prefer it when present;
  // fall back to the saved version otherwise.
  const agentBody = overrideAgentBody && typeof overrideAgentBody === 'object'
    ? overrideAgentBody
    : agentVersion.body;

  const defaultCrewId = agentBody?.defaultCrewId;
  if (!defaultCrewId && !overrideCrewId) {
    throw new Error('Agent has no defaultCrewId; nothing to run');
  }

  // `overrideCrewId` is set when a prior Transition Router fired and
  // wrote to `conversation.metadata.currentCrewId`. Prefer it; fall
  // back to `defaultCrewId` if it points at a crew that's been
  // deleted (logs a warning so the misconfiguration is visible).
  const preferredCrewId = overrideCrewId || defaultCrewId;
  let [crew] = await d.select()
    .from(builderCrews)
    .where(and(
      eq(builderCrews.id, preferredCrewId),
      eq(builderCrews.agentId, agent.id),
    ))
    .limit(1);
  if (!crew && overrideCrewId && defaultCrewId && defaultCrewId !== overrideCrewId) {
    console.warn(`[builder] currentCrewId "${overrideCrewId}" not found; falling back to defaultCrewId "${defaultCrewId}"`);
    [crew] = await d.select()
      .from(builderCrews)
      .where(and(
        eq(builderCrews.id, defaultCrewId),
        eq(builderCrews.agentId, agent.id),
      ))
      .limit(1);
  }
  if (!crew) throw new Error(`Crew ${preferredCrewId} not found`);

  const crewVersionId = mode === 'active' ? crew.activeVersionId : crew.viewingVersionId;
  if (!crewVersionId) throw new Error('Crew has no version pointer');

  const [crewVersion] = await d.select()
    .from(builderCrewVersions)
    .where(eq(builderCrewVersions.id, crewVersionId))
    .limit(1);
  if (!crewVersion) throw new Error('Crew version row missing');

  // Builder preview path: the client may have sent the working-copy
  // crew body. We still load the version row (for `versionId` in logs
  // and to confirm the crew is wired up) but run against the override
  // when present. The body is scoped to the routed crew already —
  // the client computes the same `targetCrewId` we resolve here.
  const baseCrewBody = overrideCrewBody && typeof overrideCrewBody === 'object'
    ? overrideCrewBody
    : crewVersion.body;

  // Phase B: migrate the runtime crew body so the assembler sees
  // template-owns-placement form. Idempotent.
  const { migrateCrewBody } = require('../runtime/migrateAddonContext');
  const migratedCrewBody = migrateCrewBody(baseCrewBody);

  return {
    agent: {
      id:              agent.id,
      slug:            agent.slug,
      versionId:       agentVersion.id,
      body:            agentBody,           // { name, slug, spec, persona, defaultCrewId, ... }
    },
    crew: {
      id:              crew.id,
      versionId:       crewVersion.id,
      body:            migratedCrewBody,    // { name, description?, spec, persona?, addons[] }
    },
  };
}

module.exports = {
  hydrateProject,
  listProjects,
  createProject,
  deleteAgentVersion,
  deleteCrewVersion,
  saveAgentVersion,
  saveAgentVersionAs,
  setAgentActive,
  setAgentViewing,
  saveCrewVersion,
  saveCrewVersionAs,
  setCrewActive,
  setCrewViewing,
  createCrew,
  deleteCrew,
  deleteProject,
  resolveRunnable,
};
