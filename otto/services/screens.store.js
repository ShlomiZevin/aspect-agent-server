/**
 * Custom screens — CRUD over the `custom_modules` table (platform DB).
 *
 * Replaces v1's provider_config blob. Every read and write is scoped by
 * dataset_id — "visible only inside its client" is enforced here, at the
 * data layer, not left to the route.
 *
 * Status flow: draft → ready (built, reviewable) → active (published).
 * Publishing freezes editing (D4); a draft is hard-deleted, a published
 * screen is removable by super-admin only (task §12 Q4).
 */

const crypto = require('crypto');
const db = require('../../services/db.pg');
const { customModules } = require('../../db/schema');
const { eq, and, or, asc, desc, ne, isNull, inArray } = require('drizzle-orm');

const MAX_CONVERSATION = 60; // turns kept on a draft — enough to reopen mid-thought

function newId() {
  return `cm-${crypto.randomBytes(8).toString('hex')}`;
}

/** Summaries for the shelf and lists — never the conversation or the spec. */
function toSummary(row) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary || null,
    icon: row.icon || 'grid',
    status: row.status,
    createdBy: row.createdBy || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasSpec: Boolean(row.screenSpec),
  };
}

/** Everyone can see a published (or once-published/archived) screen; a
 *  draft/ready screen is visible only to whoever created it. A screen with
 *  no createdBy predates this scoping (task #92) and stays visible to all,
 *  so nothing existing becomes unreachable. */
function canView(row, viewerId) {
  if (row.status !== 'draft' && row.status !== 'ready') return true;
  return !row.createdBy || row.createdBy === viewerId;
}

/** Only the creator may edit — chat, plan, build, rename, publish, unpublish,
 *  revert or delete — regardless of the screen's current status. Same
 *  no-createdBy carve-out as canView, for the same reason. */
function canEdit(row, viewerId) {
  return !row.createdBy || row.createdBy === viewerId;
}

async function list(datasetId, { includeArchived = false, viewerId = null } = {}) {
  const drizzle = db.getDrizzle();
  const conditions = [eq(customModules.datasetId, datasetId)];
  if (!includeArchived) conditions.push(ne(customModules.status, 'archived'));
  // Draft/ready screens are private to their creator (task #92) — everyone
  // still sees published apps and legacy ownerless rows.
  conditions.push(or(
    inArray(customModules.status, ['active', 'archived']),
    isNull(customModules.createdBy),
    ...(viewerId ? [eq(customModules.createdBy, viewerId)] : []),
  ));
  const rows = await drizzle
    .select().from(customModules)
    .where(and(...conditions))
    // OLDEST first, so the newest app ends up adjacent to the "+ New app"
    // tile that follows the list on the shelf (task #81). Newest-first put
    // it at the far end instead, which reads backwards in both directions
    // but was noticed in Hebrew, where the shelf starts on the right.
    .orderBy(asc(customModules.updatedAt));
  return rows.map(toSummary);
}

async function get(datasetId, screenId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle
    .select().from(customModules)
    .where(and(eq(customModules.datasetId, datasetId), eq(customModules.id, screenId)))
    .limit(1);
  return row || null;
}

async function create(datasetId, { title, plan, conversation, createdBy }) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.insert(customModules).values({
    id: newId(),
    datasetId,
    title: title || { en: 'New app', he: 'אפליקציה חדשה' },
    plan: plan || {},
    conversation: (conversation || []).slice(-MAX_CONVERSATION),
    status: 'draft',
    createdBy: createdBy || null,
  }).returning();
  return row;
}

/**
 * Patch a screen. Only whitelisted fields — a PATCH body can never touch
 * dataset_id, created_by or the spec (the build pipeline owns the spec).
 */
async function update(datasetId, screenId, patch) {
  const allowed = {};
  if (patch.title !== undefined) allowed.title = patch.title;
  if (patch.summary !== undefined) allowed.summary = patch.summary;
  if (patch.icon !== undefined) allowed.icon = patch.icon;
  if (patch.plan !== undefined) allowed.plan = patch.plan;
  if (patch.conversation !== undefined) {
    allowed.conversation = patch.conversation.slice(-MAX_CONVERSATION);
  }
  if (patch.status !== undefined) allowed.status = patch.status;
  if (Object.keys(allowed).length === 0) return get(datasetId, screenId);

  const drizzle = db.getDrizzle();
  const [row] = await drizzle.update(customModules)
    .set({ ...allowed, updatedAt: new Date() })
    .where(and(eq(customModules.datasetId, datasetId), eq(customModules.id, screenId)))
    .returning();
  return row || null;
}

/** The build pipeline's write: the verified spec, and draft → ready. */
async function storeSpec(datasetId, screenId, screenSpec) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.update(customModules)
    .set({ screenSpec, status: 'ready', updatedAt: new Date() })
    .where(and(
      eq(customModules.datasetId, datasetId),
      eq(customModules.id, screenId),
      // A published screen is frozen — a stray build job must not overwrite it.
      ne(customModules.status, 'active'),
    ))
    .returning();
  return row || null;
}

/** What "Cancel changes" restores — captured at every publish. */
function snapshotOf(row) {
  return {
    title: row.title,
    summary: row.summary,
    icon: row.icon,
    plan: row.plan,
    screenSpec: row.screenSpec,
    conversation: row.conversation,
  };
}

async function publish(datasetId, screenId) {
  const current = await get(datasetId, screenId);
  if (!current || current.status !== 'ready') return null;
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.update(customModules)
    .set({
      status: 'active',
      // Every publish refreshes the snapshot — this is the state Cancel
      // changes returns to during the NEXT edit session.
      publishedState: snapshotOf(current),
      updatedAt: new Date(),
    })
    .where(and(
      eq(customModules.datasetId, datasetId),
      eq(customModules.id, screenId),
      eq(customModules.status, 'ready'),   // only a built, reviewable app publishes
    ))
    .returning();
  return row || null;
}

/** Edit a published app: back to 'ready' (editable), snapshot untouched. */
async function unpublish(datasetId, screenId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.update(customModules)
    .set({ status: 'ready', updatedAt: new Date() })
    .where(and(
      eq(customModules.datasetId, datasetId),
      eq(customModules.id, screenId),
      eq(customModules.status, 'active'),
    ))
    .returning();
  return row || null;
}

/** Cancel changes: restore the last published state and go live again. */
async function revert(datasetId, screenId) {
  const current = await get(datasetId, screenId);
  if (!current?.publishedState || current.status === 'active') return null;
  const s = current.publishedState;
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.update(customModules)
    .set({
      title: s.title,
      summary: s.summary ?? null,
      icon: s.icon ?? null,
      plan: s.plan,
      screenSpec: s.screenSpec ?? null,
      conversation: s.conversation ?? [],
      status: 'active',
      updatedAt: new Date(),
    })
    .where(and(eq(customModules.datasetId, datasetId), eq(customModules.id, screenId)))
    .returning();
  return row || null;
}

/** Hard delete — never-published drafts only. An app that has EVER been
 *  published keeps Cancel changes as its escape hatch; deleting it is
 *  super-admin territory. */
async function removeDraft(datasetId, screenId) {
  const drizzle = db.getDrizzle();
  const rows = await drizzle.delete(customModules)
    .where(and(
      eq(customModules.datasetId, datasetId),
      eq(customModules.id, screenId),
      ne(customModules.status, 'active'),
      isNull(customModules.publishedState),
    ))
    .returning({ id: customModules.id });
  return rows.length > 0;
}

module.exports = { list, get, create, update, storeSpec, publish, unpublish, revert, removeDraft, toSummary, canView, canEdit };
