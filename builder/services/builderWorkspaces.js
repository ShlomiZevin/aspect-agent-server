/**
 * Builder V2 — Workspaces service.
 *
 * Workspaces are named folders that group agents on the builder home
 * page. Global/shared during the no-auth build phase: `ownerUserId` is
 * stored on creation but never used to filter reads (same rule as
 * builder_projects / listProjects). Agent ↔ workspace membership lives
 * on `builder_agents.workspace_id` (null = top level).
 *
 * Deleting a workspace offers two outcomes:
 *   - cascade='orphan' (default): move the agents under it back to top
 *     level (workspace_id → null), then drop the folder.
 *   - cascade='agents': tear down every agent under it (full project
 *     teardown via deleteProject), then drop the folder.
 */

const db = require('../../services/db.pg');
const { eq, asc } = require('drizzle-orm');
const { builderWorkspaces, builderAgents } = require('../../db/schema');
const { deleteProject } = require('./builderProjects');

function drizzle() {
  return db.getDrizzle();
}

/** All workspaces, oldest first (stable order for the sidebar). */
async function listWorkspaces() {
  const rows = await drizzle().select()
    .from(builderWorkspaces)
    .orderBy(asc(builderWorkspaces.createdAt));
  return rows.map(r => ({
    id:        r.id,
    name:      r.name,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function createWorkspace({ id, ownerUserId, name }) {
  const [row] = await drizzle().insert(builderWorkspaces).values({
    id,
    ownerUserId: ownerUserId || null,
    name: (name || '').trim() || 'Untitled workspace',
  }).returning();
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
}

async function renameWorkspace({ id, name }) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    const e = new Error('Workspace name cannot be empty');
    e.code = 'bad_input';
    throw e;
  }
  await drizzle().update(builderWorkspaces)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(builderWorkspaces.id, id));
}

/**
 * Delete a workspace. `cascade`:
 *   - 'orphan' (default): agents under it move to top level.
 *   - 'agents': agents under it are deleted (whole project tree each).
 */
async function deleteWorkspace({ id, cascade = 'orphan' }) {
  const d = drizzle();

  if (cascade === 'agents') {
    // Collect the projects of agents in this workspace, then tear each
    // down with the existing project-teardown (handles versions/crews).
    const agentRows = await d.select({ projectId: builderAgents.projectId })
      .from(builderAgents)
      .where(eq(builderAgents.workspaceId, id));
    const projectIds = [...new Set(agentRows.map(r => r.projectId))];
    for (const projectId of projectIds) {
      await deleteProject({ projectId });
    }
  } else {
    // Orphan: detach agents back to top level.
    await d.update(builderAgents)
      .set({ workspaceId: null, updatedAt: new Date() })
      .where(eq(builderAgents.workspaceId, id));
  }

  await d.delete(builderWorkspaces).where(eq(builderWorkspaces.id, id));
}

module.exports = {
  listWorkspaces,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
};
