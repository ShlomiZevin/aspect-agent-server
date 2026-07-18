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
const { eq, and, desc, sql } = require('drizzle-orm');
const {
  builderProjects,
  builderAgents,
  builderAgentVersions,
  builderCrews,
  builderCrewVersions,
  kbLinks,
} = require('../../db/schema');

function drizzle() {
  return db.getDrizzle();
}

/** Generate a server-side id with the same shape the client's uid() uses. */
function genId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Normalize an agent body's personas on READ. If `personas` is already
 * an array (incl. an explicit empty one) it's respected. If absent
 * (legacy single-persona agents), seed one general persona named
 * "main" carrying the legacy `persona` string and applied to ALL
 * addons (`'*'`). This surfaces the old persona as a first-class,
 * editable persona instead of leaving it invisible — and is idempotent
 * (once saved, `personas` exists so this is a no-op). The legacy
 * `persona` string is left untouched as a runtime fallback.
 */
function withPersonas(body) {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body.personas)) return body;
  const legacy = typeof body.persona === 'string' ? body.persona : '';
  return {
    ...body,
    personas: [{ id: 'persona_main', name: 'main', content: legacy, appliesTo: ['*'] }],
  };
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

  // Build the working-copy agent fields from the ACTIVE version — the
  // editable line. Reopening the builder restores your active work, not
  // whatever you last previewed. (Working copy == active is the
  // invariant the client relies on for reload→active.) Falls back to
  // viewing if the active pointer is somehow unset.
  const activeAgentVersion = agentVersions.find(v => v.id === agent.activeVersionId)
    || agentVersions.find(v => v.id === agent.viewingVersionId);
  const agentBody = withPersonas(activeAgentVersion ? activeAgentVersion.body : {});

  // All crews of this agent — ordered by creation time so the
  // sidebar is deterministic across users. Without ORDER BY the
  // result depends on Postgres heap layout, which shifts after
  // updates / vacuum and made two browsers show different crew
  // orderings for the same agent.
  const crewRows = await d.select()
    .from(builderCrews)
    .where(eq(builderCrews.agentId, agent.id))
    // Author-controlled order first (drag-reorder writes `position`),
    // then createdAt so un-positioned crews keep a stable order.
    .orderBy(sql`${builderCrews.position} ASC NULLS LAST`, builderCrews.createdAt);

  const crews = [];
  for (const c of crewRows) {
    const crewVersions = await d.select()
      .from(builderCrewVersions)
      .where(eq(builderCrewVersions.crewId, c.id))
      .orderBy(desc(builderCrewVersions.number));
    // Working copy from the crew's ACTIVE version (see the agent block).
    const crewActive = crewVersions.find(v => v.id === c.activeVersionId)
      || crewVersions.find(v => v.id === c.viewingVersionId);
    const crewBody = crewActive ? crewActive.body : {};
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
      // Version metadata (client format). The dirty calc compares the
      // working-copy fields above (name / description / spec / persona
      // / addons / fields) against `versions.find(viewing).body`. If
      // EITHER side normalises differently from the other, the calc
      // shows a phantom "Save +N crews" the moment the page loads
      // without the user touching anything. So we apply the SAME
      // normalisations + addon migration here that the working-copy
      // block above applies. Symmetric in, symmetric out → no phantom
      // dirty.
      versions: crewVersions.map(v => {
        const vb = v.body || {};
        const vbAddons = Array.isArray(vb.addons) ? vb.addons.map(migrateAddonInstance) : [];
        return {
          id:           v.id,
          number:       v.number,
          description:  v.description || undefined,
          createdAt:    v.createdAt.toISOString(),
          body: {
            ...vb,
            name:        vb.name        || '',
            description: vb.description || '',
            spec:        vb.spec        || '',
            persona:     vb.persona,
            addons:      vbAddons,
            fields:      Array.isArray(vb.fields) ? vb.fields : [],
          },
        };
      }),
      activeVersionId:    c.activeVersionId,
      // Working copy loads from active, so viewing tracks active on
      // load (the invariant: viewing == active unless mid-preview,
      // which is transient client-only state).
      viewingVersionId:   c.activeVersionId ?? c.viewingVersionId,
      publishedVersionId: c.publishedVersionId ?? null,
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
      name:            agentBody.name           || agent.slug,
      spec:            agentBody.spec           || '',
      persona:         agentBody.persona        || '',
      personas:        Array.isArray(agentBody.personas) ? agentBody.personas : [],
      defaultCrewId:   agentBody.defaultCrewId,
      fields:          Array.isArray(agentBody.fields)          ? agentBody.fields          : [],
      domains:         Array.isArray(agentBody.domains)         ? agentBody.domains         : [],
      tags:            Array.isArray(agentBody.tags)            ? agentBody.tags            : [],
      parameters:      Array.isArray(agentBody.parameters)      ? agentBody.parameters      : [],
      enums:           Array.isArray(agentBody.enums)           ? agentBody.enums           : [],
      snippets:        Array.isArray(agentBody.snippets)        ? agentBody.snippets        : [],
      cortex:          Array.isArray(agentBody.cortex)          ? agentBody.cortex          : [],
      // Live Brain config — carried through so saved panels survive a
      // reload. Absent = the agent never used it (working copy treats it
      // as no panels).
      liveBrain:       agentBody.liveBrain,
      crews,
      versions: agentVersions.map(v => ({
        id:           v.id,
        number:       v.number,
        description:  v.description || undefined,
        createdAt:    v.createdAt.toISOString(),
        // Seed personas symmetrically with the working copy so a legacy
        // agent doesn't read as "dirty" the moment it loads.
        body:         withPersonas(v.body),
      })),
      activeVersionId:    agent.activeVersionId,
      viewingVersionId:   agent.activeVersionId ?? agent.viewingVersionId,
      publishedVersionId: agent.publishedVersionId ?? null,
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
    workspaceId: builderAgents.workspaceId,
    archivedAt:  builderAgents.archivedAt,
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
    agentId:     r.agentId,
    agentSlug:   r.agentSlug,
    // null = top level. The home page groups by this.
    workspaceId: r.workspaceId || null,
    // null = live; ISO string = archived. The home page splits the
    // Live / Archived tabs on this.
    archivedAt:  r.archivedAt ? r.archivedAt.toISOString() : null,
    // Active version body holds the canonical agent name. Fall back
    // to the slug when the agent has no versions yet (shouldn't happen
    // in practice — bootstrap creates v1 — but cheap defensive default).
    agentName:   (r.agentBody && r.agentBody.name) || r.agentSlug,
    updatedAt:   r.updatedAt.toISOString(),
  }));
}

// ─── Agent shell mutations (rename / move / archive) ──────────────

/**
 * Rename an agent. Changes both the display name and the slug (the
 * URL). The name + slug live inside the versioned AgentBody, so we
 * update the active AND viewing version bodies (so the home list and
 * the open builder agree) plus the slug column on the shell.
 *
 * Slugs must be globally unique — hydrateProject / resolveRunnable
 * look an agent up by slug alone. Refuses a slug already taken by
 * another agent (throws a labelled error → 409).
 */
async function renameAgent({ agentId, name, slug }) {
  const d = drizzle();
  const trimmedName = (name || '').trim();
  const trimmedSlug = (slug || '').trim();
  if (!trimmedName) {
    const e = new Error('Agent name cannot be empty'); e.code = 'bad_input'; throw e;
  }
  if (!trimmedSlug) {
    const e = new Error('Agent slug cannot be empty'); e.code = 'bad_input'; throw e;
  }

  await d.transaction(async tx => {
    const agentRows = await tx.select().from(builderAgents)
      .where(eq(builderAgents.id, agentId)).limit(1);
    if (agentRows.length === 0) {
      const e = new Error('Agent not found'); e.code = 'not_found'; throw e;
    }
    const agent = agentRows[0];

    // Global slug uniqueness — another agent already on this slug blocks it.
    if (trimmedSlug !== agent.slug) {
      const clash = await tx.select({ id: builderAgents.id }).from(builderAgents)
        .where(eq(builderAgents.slug, trimmedSlug)).limit(1);
      if (clash.length > 0 && clash[0].id !== agentId) {
        const e = new Error(`The URL "/${trimmedSlug}" is already used by another agent.`);
        e.code = 'slug_taken';
        throw e;
      }
    }

    // Update name + slug inside the active and viewing version bodies.
    const versionIds = [...new Set(
      [agent.activeVersionId, agent.viewingVersionId].filter(Boolean),
    )];
    for (const vid of versionIds) {
      const verRows = await tx.select().from(builderAgentVersions)
        .where(eq(builderAgentVersions.id, vid)).limit(1);
      if (verRows.length === 0) continue;
      const body = { ...(verRows[0].body || {}), name: trimmedName, slug: trimmedSlug };
      await tx.update(builderAgentVersions)
        .set({ body, updatedAt: new Date() })
        .where(eq(builderAgentVersions.id, vid));
    }

    // Slug column on the shell + project name (kept in sync for the list).
    await tx.update(builderAgents)
      .set({ slug: trimmedSlug, updatedAt: new Date() })
      .where(eq(builderAgents.id, agentId));
    await tx.update(builderProjects)
      .set({ name: trimmedName, updatedAt: new Date() })
      .where(eq(builderProjects.id, agent.projectId));
  });

  return { slug: trimmedSlug, name: trimmedName };
}

/** Move an agent into a workspace (or to top level when workspaceId is null). */
async function moveAgent({ agentId, workspaceId }) {
  await drizzle().update(builderAgents)
    .set({ workspaceId: workspaceId || null, updatedAt: new Date() })
    .where(eq(builderAgents.id, agentId));
}

/** Archive (archived=true) or restore (archived=false) an agent. */
async function setAgentArchived({ agentId, archived }) {
  await drizzle().update(builderAgents)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(builderAgents.id, agentId));
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

/**
 * Move the agent's customer-facing `publishedVersionId`. Pass
 * `versionId: null` to unpublish (falls the runtime back to
 * active→viewing). Decoupled from active on purpose — publishing is
 * the deliberate "ship to live users" step.
 */
async function setAgentPublished({ agentId, versionId }) {
  await drizzle()
    .update(builderAgents)
    .set({ publishedVersionId: versionId ?? null, updatedAt: new Date() })
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
    if (agent.publishedVersionId === versionId) {
      const e = new Error('Cannot delete the published version. Publish another version (or unpublish) first.');
      e.code = 'is_published';
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

/** Crew counterpart of `setAgentPublished`. `versionId: null` unpublishes. */
async function setCrewPublished({ crewId, versionId }) {
  await drizzle()
    .update(builderCrews)
    .set({ publishedVersionId: versionId ?? null, updatedAt: new Date() })
    .where(eq(builderCrews.id, crewId));
}

/**
 * Persist the author-chosen crew order. `crewIds` is the full ordered
 * list for the agent; each crew's `position` is set to its index. Only
 * crews belonging to `agentId` are touched. Purely visual ordering.
 */
async function reorderCrews({ agentId, crewIds }) {
  if (!Array.isArray(crewIds) || crewIds.length === 0) return;
  const d = drizzle();
  await d.transaction(async tx => {
    for (let i = 0; i < crewIds.length; i++) {
      await tx.update(builderCrews)
        .set({ position: i, updatedAt: new Date() })
        .where(and(
          eq(builderCrews.id, crewIds[i]),
          eq(builderCrews.agentId, agentId),
        ));
    }
  });
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
    if (crew.publishedVersionId === versionId) {
      const e = new Error('Cannot delete the published version. Publish another version (or unpublish) first.');
      e.code = 'is_published';
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
 * Pick which version pointer to load for a runtime mode, for an agent
 * or crew shell row (both carry the same three pointers).
 *
 *   'viewing'   → the editor working copy (builder preview / test).
 *   'active'    → the builder/admin marker (no fallback — set explicitly).
 *   'published' → the CUSTOMER-facing pointer, falling back to
 *                 active → viewing when nothing has been published yet,
 *                 so live users never hit an empty agent before the
 *                 first Publish. This is the v1 `getPublishedPrompt`
 *                 fallback, mirrored per-entity.
 */
function pickVersionId(mode, row) {
  if (mode === 'published') {
    return row.publishedVersionId || row.activeVersionId || row.viewingVersionId;
  }
  if (mode === 'active') return row.activeVersionId;
  return row.viewingVersionId;
}

/**
 * Given an agentSlug + ownerUserId + version mode ('viewing',
 * 'active', or 'published'), return the addons to execute and metadata
 * needed for logging. Used by BuilderRunner.
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

  // Archived agents are blocked from running (the home page hides them
  // and they can't be talked to until restored). Labelled so the route
  // can surface a clean reason.
  if (agent.archivedAt) {
    const e = new Error('This agent is archived. Restore it from the builder home page to use it.');
    e.code = 'archived';
    throw e;
  }

  const agentVersionId = pickVersionId(mode, agent);
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

  const crewVersionId = pickVersionId(mode, crew);
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

/**
 * Duplicate a project (its single agent + all crews) into a fresh copy
 * with new ids and a new slug. Copies ONLY the ACTIVE version of the
 * agent and of each crew, each becoming the new entity's v1 (active +
 * viewing). The new agent lands in `workspaceId` (defaults to the
 * source's) and is live (not archived).
 *
 * Crews are new DB rows, so every crew-id reference inside the copied
 * JSON is remapped to the new crew ids:
 *   - agentBody.defaultCrewId
 *   - Transition Router addon `config.target` (crew id)
 *
 * Field / enum / snippet ids and addon instanceIds are kept as-is —
 * they're internal JSON keys, consistent within the copy. KB namespace
 * references (`addon.config.kbNamespaces`) ride along in the JSON, so
 * the clone points at the same knowledge.
 */
async function duplicateProject({ projectId, newSlug, newName, workspaceId }) {
  const d = drizzle();
  const slug = (newSlug || '').trim();
  const name = (newName || '').trim();
  if (!slug) { const e = new Error('New slug is required'); e.code = 'bad_input'; throw e; }
  if (!name) { const e = new Error('New name is required'); e.code = 'bad_input'; throw e; }

  // Global slug uniqueness — same rule as rename (lookup is by slug alone).
  const clash = await d.select({ id: builderAgents.id }).from(builderAgents)
    .where(eq(builderAgents.slug, slug)).limit(1);
  if (clash.length > 0) {
    const e = new Error(`The URL "/${slug}" is already used by another agent.`);
    e.code = 'slug_taken';
    throw e;
  }

  // ── Load the source (project + its agent + active bodies + crews) ──
  const [srcProject] = await d.select().from(builderProjects)
    .where(eq(builderProjects.id, projectId)).limit(1);
  if (!srcProject) { const e = new Error('Project not found'); e.code = 'not_found'; throw e; }

  const [srcAgent] = await d.select().from(builderAgents)
    .where(eq(builderAgents.projectId, projectId)).limit(1);
  if (!srcAgent) { const e = new Error('Agent not found'); e.code = 'not_found'; throw e; }

  const [srcAgentVer] = await d.select().from(builderAgentVersions)
    .where(eq(builderAgentVersions.id, srcAgent.activeVersionId)).limit(1);
  if (!srcAgentVer) { const e = new Error('Agent has no active version'); e.code = 'not_found'; throw e; }

  const srcCrews = await d.select().from(builderCrews)
    .where(eq(builderCrews.agentId, srcAgent.id));

  // Build crew-id remap + grab each crew's active body up front.
  const crewIdMap = {};       // oldCrewId -> newCrewId
  const crewActiveBody = {};  // oldCrewId -> active version body
  for (const c of srcCrews) {
    crewIdMap[c.id] = genId('crew');
    const [cv] = await d.select().from(builderCrewVersions)
      .where(eq(builderCrewVersions.id, c.activeVersionId)).limit(1);
    crewActiveBody[c.id] = cv ? cv.body : {};
  }

  // Remap any crew-id references inside an addon list (Transition Router target).
  const remapAddons = (addons) => {
    if (!Array.isArray(addons)) return addons;
    return addons.map(a => {
      if (a && a.pluginId === 'transition-router' && a.config && crewIdMap[a.config.target]) {
        return { ...a, config: { ...a.config, target: crewIdMap[a.config.target] } };
      }
      return a;
    });
  };

  // ── New ids ──
  const newProjectId  = genId('project');
  const newAgentId    = genId('agent');
  const newAgentVerId = genId('ver');

  // New agent body: clone, then override name/slug + remap crew refs.
  const agentBody = JSON.parse(JSON.stringify(srcAgentVer.body || {}));
  agentBody.name = name;
  agentBody.slug = slug;
  if (agentBody.defaultCrewId && crewIdMap[agentBody.defaultCrewId]) {
    agentBody.defaultCrewId = crewIdMap[agentBody.defaultCrewId];
  }
  if (Array.isArray(agentBody.cortex)) agentBody.cortex = remapAddons(agentBody.cortex);

  const resolvedWorkspaceId = workspaceId !== undefined
    ? (workspaceId || null)
    : (srcAgent.workspaceId || null);

  await d.transaction(async tx => {
    await tx.insert(builderProjects).values({
      id: newProjectId,
      ownerUserId: srcProject.ownerUserId,
      name,
      spec: srcProject.spec || '',
    });
    await tx.insert(builderAgents).values({
      id:               newAgentId,
      projectId:        newProjectId,
      slug,
      workspaceId:      resolvedWorkspaceId,
      archivedAt:       null,
      activeVersionId:  newAgentVerId,
      viewingVersionId: newAgentVerId,
    });
    await tx.insert(builderAgentVersions).values({
      id: newAgentVerId,
      agentId: newAgentId,
      number: 1,
      description: 'Duplicated',
      body: agentBody,
    });

    for (const c of srcCrews) {
      const newCrewId    = crewIdMap[c.id];
      const newCrewVerId = genId('ver');
      const crewBody = JSON.parse(JSON.stringify(crewActiveBody[c.id] || {}));
      if (Array.isArray(crewBody.addons)) crewBody.addons = remapAddons(crewBody.addons);
      await tx.insert(builderCrews).values({
        id:               newCrewId,
        agentId:          newAgentId,
        activeVersionId:  newCrewVerId,
        viewingVersionId: newCrewVerId,
      });
      await tx.insert(builderCrewVersions).values({
        id: newCrewVerId,
        crewId: newCrewId,
        number: 1,
        description: 'Duplicated',
        body: crewBody,
      });
    }

    // ── KB links ────────────────────────────────────────────────────
    // Copy the SOURCE agent's KB↔agent visibility links to the NEW agent
    // so the clone sees the same KBs (Pinecone namespaces) with zero
    // vector copying — links are by name. Same index_name/namespace,
    // new agent_id. Best-effort: a fresh agent simply has no links.
    const srcLinks = await tx.select({ indexName: kbLinks.indexName, namespace: kbLinks.namespace })
      .from(kbLinks).where(eq(kbLinks.agentId, srcAgent.id));
    if (srcLinks.length > 0) {
      await tx.insert(kbLinks)
        .values(srcLinks.map(l => ({ indexName: l.indexName, namespace: l.namespace, agentId: newAgentId })))
        .onConflictDoNothing();
    }
  });

  return { projectId: newProjectId, agentId: newAgentId, slug, name };
}

module.exports = {
  hydrateProject,
  listProjects,
  createProject,
  duplicateProject,
  renameAgent,
  moveAgent,
  setAgentArchived,
  deleteAgentVersion,
  deleteCrewVersion,
  saveAgentVersion,
  saveAgentVersionAs,
  setAgentActive,
  setAgentPublished,
  setAgentViewing,
  saveCrewVersion,
  saveCrewVersionAs,
  setCrewActive,
  setCrewPublished,
  setCrewViewing,
  reorderCrews,
  createCrew,
  deleteCrew,
  deleteProject,
  resolveRunnable,
};
