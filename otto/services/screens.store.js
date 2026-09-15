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
const { eq, and, desc, ne } = require('drizzle-orm');

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

async function list(datasetId, { includeArchived = false } = {}) {
  const drizzle = db.getDrizzle();
  const rows = await drizzle
    .select().from(customModules)
    .where(includeArchived
      ? eq(customModules.datasetId, datasetId)
      : and(eq(customModules.datasetId, datasetId), ne(customModules.status, 'archived')))
    .orderBy(desc(customModules.updatedAt));
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
    title: title || { en: 'New screen', he: 'מסך חדש' },
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

async function publish(datasetId, screenId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.update(customModules)
    .set({ status: 'active', updatedAt: new Date() })
    .where(and(
      eq(customModules.datasetId, datasetId),
      eq(customModules.id, screenId),
      eq(customModules.status, 'ready'),   // only a built, reviewable screen publishes
    ))
    .returning();
  return row || null;
}

/** Hard delete — drafts only. Published screens refuse (super-admin removal
 *  goes through a different path when it exists). */
async function removeDraft(datasetId, screenId) {
  const drizzle = db.getDrizzle();
  const rows = await drizzle.delete(customModules)
    .where(and(
      eq(customModules.datasetId, datasetId),
      eq(customModules.id, screenId),
      ne(customModules.status, 'active'),
    ))
    .returning({ id: customModules.id });
  return rows.length > 0;
}

module.exports = { list, get, create, update, storeSpec, publish, removeDraft, toSummary };
