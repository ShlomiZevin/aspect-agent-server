/**
 * Builder V2 — Workspaces service (nested folders).
 *
 * Workspaces are named folders that group agents on the builder home
 * page. Global/shared during the no-auth build phase: `ownerUserId` is
 * stored on creation but never used to filter reads. Folders nest via
 * `builder_workspaces.parent_id` (null = top level, unlimited depth).
 * Agent ↔ workspace membership lives on `builder_agents.workspace_id`
 * (null = top level).
 *
 * Deleting a workspace:
 *   - cascade='orphan' (default): move its DIRECT contents (agents +
 *     sub-folders) UP ONE LEVEL to the deleted folder's parent, then
 *     drop the folder. (For an empty folder this is just the drop.)
 *   - cascade='hard': recursively delete the folder, every sub-folder
 *     under it, and every agent in any of them.
 */

const db = require('../../services/db.pg');
const { eq, asc } = require('drizzle-orm');
const { builderWorkspaces, builderAgents } = require('../../db/schema');
const { deleteProject } = require('./builderProjects');

function drizzle() {
  return db.getDrizzle();
}

/** Load every workspace (id + parentId) — cheap; used to walk the tree. */
async function allWorkspaceRows() {
  return drizzle().select({ id: builderWorkspaces.id, parentId: builderWorkspaces.parentId })
    .from(builderWorkspaces);
}

/** All descendant workspace ids of `rootId` (NOT including rootId). */
function descendantsOf(rootId, rows) {
  const childrenOf = new Map();
  for (const r of rows) {
    const p = r.parentId || null;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(r.id);
  }
  const out = [];
  const stack = [...(childrenOf.get(rootId) || [])];
  while (stack.length) {
    const id = stack.pop();
    out.push(id);
    for (const c of (childrenOf.get(id) || [])) stack.push(c);
  }
  return out;
}

/** All workspaces (oldest first). Includes `parentId` + `kind` so the
 *  client builds the typed folder tree. Legacy null kind → 'domain'. */
async function listWorkspaces() {
  const rows = await drizzle().select()
    .from(builderWorkspaces)
    .orderBy(asc(builderWorkspaces.createdAt));
  return rows.map(r => ({
    id:        r.id,
    name:      r.name,
    parentId:  r.parentId || null,
    kind:      r.kind || 'domain',
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Fetch a folder's kind, or null if missing. */
async function kindOf(id) {
  if (!id) return null;
  const [r] = await drizzle().select({ kind: builderWorkspaces.kind })
    .from(builderWorkspaces).where(eq(builderWorkspaces.id, id)).limit(1);
  return r ? (r.kind || 'domain') : null;
}

/**
 * Where each folder kind may live (`parentKind` = null means top level):
 *   - Domain  → top level only.
 *   - Project → inside a Domain.
 *   - Folder  → inside a Project or another Folder (free-form below a project).
 * Grandfathered rows are never re-checked; this only gates NEW create/move.
 */
function canBeParent(childKind, parentKind) {
  if (childKind === 'domain')  return parentKind === null;
  if (childKind === 'project') return parentKind === 'domain';
  if (childKind === 'folder')  return parentKind === 'project' || parentKind === 'folder';
  return false;
}

function badParentMessage(childKind) {
  if (childKind === 'domain')  return 'A domain lives at the top level';
  if (childKind === 'project') return 'A project must live inside a domain';
  return 'A folder can only live inside a project or another folder';
}

async function createWorkspace({ id, ownerUserId, name, parentId, kind }) {
  const k = (kind === 'project' || kind === 'folder') ? kind : 'domain';
  const parent = parentId || null;
  const parentKind = parent ? await kindOf(parent) : null;
  if (parent && parentKind === null) {
    const e = new Error('Parent folder not found'); e.code = 'not_found'; throw e;
  }
  if (!canBeParent(k, parentKind)) {
    const e = new Error(badParentMessage(k)); e.code = 'bad_input'; throw e;
  }

  const [row] = await drizzle().insert(builderWorkspaces).values({
    id,
    ownerUserId: ownerUserId || null,
    name: (name || '').trim() || 'Untitled folder',
    parentId: parent,
    kind: k,
  }).returning();
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId || null,
    kind: row.kind || 'domain',
    createdAt: row.createdAt.toISOString(),
  };
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
 * Move a workspace under `parentId` (null = top level). Rejects moving a
 * folder into itself or into one of its own descendants (would orphan a
 * cycle).
 */
async function moveWorkspace({ id, parentId }) {
  const target = parentId || null;
  if (target === id) {
    const e = new Error('A folder can’t be moved into itself'); e.code = 'bad_input'; throw e;
  }
  if (target !== null) {
    const rows = await allWorkspaceRows();
    const bad = new Set([id, ...descendantsOf(id, rows)]);
    if (bad.has(target)) {
      const e = new Error('A folder can’t be moved into one of its own sub-folders');
      e.code = 'bad_input';
      throw e;
    }
  }
  // Enforce the same placement rules on move as on create.
  const movedKind  = await kindOf(id);
  const targetKind = target ? await kindOf(target) : null;
  if (target && targetKind === null) {
    const e = new Error('Destination folder not found'); e.code = 'not_found'; throw e;
  }
  if (!canBeParent(movedKind, targetKind)) {
    const e = new Error(
      movedKind === 'domain'  ? 'A domain can only sit at the top level'
      : movedKind === 'project' ? 'A project can only move into a domain'
      : 'This folder can only move into a project or another folder',
    );
    e.code = 'bad_input';
    throw e;
  }
  await drizzle().update(builderWorkspaces)
    .set({ parentId: target, updatedAt: new Date() })
    .where(eq(builderWorkspaces.id, id));
}

/**
 * Delete a workspace. `cascade`:
 *   - 'orphan' (default): direct agents + sub-folders move up one level
 *     to the deleted folder's parent; then the folder is dropped.
 *   - 'hard': the folder, all sub-folders under it, and all their agents
 *     are deleted.
 */
async function deleteWorkspace({ id, cascade = 'orphan' }) {
  const d = drizzle();

  const [ws] = await d.select().from(builderWorkspaces)
    .where(eq(builderWorkspaces.id, id)).limit(1);
  if (!ws) return; // already gone

  if (cascade === 'hard') {
    const rows = await allWorkspaceRows();
    const toDelete = [id, ...descendantsOf(id, rows)];
    // Tear down every agent (project) in any of these folders.
    for (const wsId of toDelete) {
      const agentRows = await d.select({ projectId: builderAgents.projectId })
        .from(builderAgents)
        .where(eq(builderAgents.workspaceId, wsId));
      const projectIds = [...new Set(agentRows.map(r => r.projectId))];
      for (const projectId of projectIds) await deleteProject({ projectId });
    }
    // Then drop the folder rows (deepest-first isn't required — no FK).
    for (const wsId of toDelete) {
      await d.delete(builderWorkspaces).where(eq(builderWorkspaces.id, wsId));
    }
    return;
  }

  // orphan: reparent DIRECT contents up one level, then drop the folder.
  const up = ws.parentId || null;
  await d.update(builderAgents)
    .set({ workspaceId: up, updatedAt: new Date() })
    .where(eq(builderAgents.workspaceId, id));
  await d.update(builderWorkspaces)
    .set({ parentId: up, updatedAt: new Date() })
    .where(eq(builderWorkspaces.parentId, id));
  await d.delete(builderWorkspaces).where(eq(builderWorkspaces.id, id));
}

module.exports = {
  listWorkspaces,
  createWorkspace,
  renameWorkspace,
  moveWorkspace,
  deleteWorkspace,
};
