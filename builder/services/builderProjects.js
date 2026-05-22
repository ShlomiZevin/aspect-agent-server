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
async function hydrateProject({ agentSlug, ownerUserId }) {
  const d = drizzle();

  // Find the agent by (owner, slug). One agent per owner per slug.
  const agentRow = await d.select()
    .from(builderAgents)
    .innerJoin(builderProjects, eq(builderAgents.projectId, builderProjects.id))
    .where(and(
      eq(builderAgents.slug, agentSlug),
      eq(builderProjects.ownerUserId, ownerUserId),
    ))
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
    crews.push({
      id: c.id,
      // Working-copy fields come from the viewing version body.
      name:         crewBody.name        || '',
      description:  crewBody.description  || '',
      spec:         crewBody.spec         || '',
      persona:      crewBody.persona,
      addons:       Array.isArray(crewBody.addons) ? crewBody.addons : [],
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
      fields:         Array.isArray(agentBody.fields) ? agentBody.fields : [],
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

// ─── Resolve the runtime's "what to run" given an agent slug ──────

/**
 * Given an agentSlug + ownerUserId + version mode ('viewing' or
 * 'active'), return the addons to execute and metadata needed for
 * logging. Used by BuilderRunner.
 */
async function resolveRunnable({ agentSlug, ownerUserId, mode = 'viewing', overrideCrewId = null }) {
  const d = drizzle();

  const agentRow = await d.select()
    .from(builderAgents)
    .innerJoin(builderProjects, eq(builderAgents.projectId, builderProjects.id))
    .where(and(
      eq(builderAgents.slug, agentSlug),
      eq(builderProjects.ownerUserId, ownerUserId),
    ))
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

  const agentBody = agentVersion.body;
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

  return {
    agent: {
      id:              agent.id,
      slug:            agent.slug,
      versionId:       agentVersion.id,
      body:            agentBody,           // { name, slug, spec, persona, defaultCrewId }
    },
    crew: {
      id:              crew.id,
      versionId:       crewVersion.id,
      body:            crewVersion.body,    // { name, description?, spec, persona?, addons[] }
    },
  };
}

module.exports = {
  hydrateProject,
  createProject,
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
  resolveRunnable,
};
