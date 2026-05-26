/**
 * Alfred — chat CRUD + streaming + apply + manual log endpoints.
 *
 * Mounted at /api/builder/alfred.
 *
 * Chat (P5.1):
 *   POST   /chats
 *   GET    /chats?agentSlug&ownerUserId
 *   PATCH  /chats/:chatId
 *   DELETE /chats/:chatId
 *   GET    /chats/:chatId/messages
 *   POST   /chats/:chatId/messages                      (SSE)
 *
 * Apply (P5.2):
 *   POST   /chats/:chatId/apply/preview                 consolidator only
 *   POST   /chats/:chatId/apply/generate                patch + validate, returns
 *                                                       new bodies; does NOT save
 *                                                       or log — the client puts
 *                                                       them in the working copy
 *                                                       and writes the log row
 *                                                       on Save.
 *
 * Manual log + Validate & Log (P5.2):
 *   POST   /agents/:agentId/log/validate                LLM diff-vs-claim check
 *   POST   /agents/:agentId/log                         write a manual log entry
 *   POST   /agents/:agentId/log/apply                   write an Alfred-attributed
 *                                                       log row (one per target,
 *                                                       sharing apply_group_id)
 *   GET    /agents/:agentId/log                         list log rows
 */

const express = require('express');
const { eq, and } = require('drizzle-orm');
const db = require('../../services/db.pg');
const {
  builderAgents,
  builderAgentVersions,
  builderCrews,
  builderCrewVersions,
} = require('../../db/schema');
const alfredChats = require('../services/alfredChats');
const alfredRunner = require('../services/alfredRunner');
const applyConsolidator = require('../services/applyConsolidator');
const patchGenerator   = require('../services/patchGenerator');
const bodyValidator    = require('../services/bodyValidator');
const changeValidator  = require('../services/changeValidator');
const changeLog        = require('../services/changeLog');
const router = express.Router();

function drizzle() {
  return db.getDrizzle();
}

// ─── Helpers: read viewing-version body for an entity ───────────────

async function loadAgentViewingBody(agentId) {
  const d = drizzle();
  const [agent] = await d.select().from(builderAgents)
    .where(eq(builderAgents.id, agentId)).limit(1);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  const [version] = await d.select().from(builderAgentVersions)
    .where(and(
      eq(builderAgentVersions.id, agent.viewingVersionId),
      eq(builderAgentVersions.agentId, agentId),
    )).limit(1);
  if (!version) throw new Error(`Agent ${agentId} has no viewing version`);
  return { agent, version, body: version.body };
}

async function loadCrewViewingBody(crewId) {
  const d = drizzle();
  const [crew] = await d.select().from(builderCrews)
    .where(eq(builderCrews.id, crewId)).limit(1);
  if (!crew) throw new Error(`Crew ${crewId} not found`);
  const [version] = await d.select().from(builderCrewVersions)
    .where(and(
      eq(builderCrewVersions.id, crew.viewingVersionId),
      eq(builderCrewVersions.crewId, crewId),
    )).limit(1);
  if (!version) throw new Error(`Crew ${crewId} has no viewing version`);
  return { crew, version, body: version.body };
}

/**
 * Resolve the parent agent id for a target so logs can be keyed on
 * the agent (crew rows don't have agent_id in their primary key).
 */
async function agentIdForTarget(target) {
  if (target.entity === 'agent') return target.entityId;
  const [crew] = await drizzle().select().from(builderCrews)
    .where(eq(builderCrews.id, target.entityId)).limit(1);
  if (!crew) throw new Error(`Crew ${target.entityId} not found`);
  return crew.agentId;
}

// ─── Chat CRUD ────────────────────────────────────────────────────

router.post('/chats', async (req, res) => {
  try {
    const { agentSlug, ownerUserId } = req.body || {};
    if (!agentSlug)   return res.status(400).json({ error: 'Missing agentSlug' });
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const created = await alfredChats.createChat({ agentSlug, ownerUserId });
    res.json({ chatId: created.id });
  } catch (err) {
    console.error('[alfred] POST /chats failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/chats', async (req, res) => {
  try {
    const { agentSlug, ownerUserId } = req.query;
    if (!agentSlug)   return res.status(400).json({ error: 'Missing agentSlug' });
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const chats = await alfredChats.listChats({
      agentSlug:   String(agentSlug),
      ownerUserId: String(ownerUserId),
    });
    res.json({ chats });
  } catch (err) {
    console.error('[alfred] GET /chats failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/chats/:chatId', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (typeof name !== 'string') return res.status(400).json({ error: 'Missing name' });
    const updated = await alfredChats.renameChat(req.params.chatId, name);
    if (updated === null) return res.status(404).json({ error: 'Chat not found' });
    res.json({ ok: true, name: updated });
  } catch (err) {
    console.error('[alfred] PATCH /chats/:id failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/chats/:chatId', async (req, res) => {
  try {
    await alfredChats.deleteChat(req.params.chatId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[alfred] DELETE /chats/:id failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Messages ─────────────────────────────────────────────────────

router.get('/chats/:chatId/messages', async (req, res) => {
  try {
    const chat = await alfredChats.getChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const messages = await alfredChats.listMessages(req.params.chatId);
    res.json({ messages });
  } catch (err) {
    console.error('[alfred] GET messages failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/chats/:chatId/messages', async (req, res) => {
  const { chatId } = req.params;
  const { ownerUserId, userMessage, agentSlug } = req.body || {};

  if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
  if (!userMessage) return res.status(400).json({ error: 'Missing userMessage' });
  if (!agentSlug)   return res.status(400).json({ error: 'Missing agentSlug' });

  // SSE headers — same shape the runtime route uses.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write(':ok\n\n');
  if (res.flush) res.flush();

  const emit = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    const chat = await alfredChats.getChat(chatId);
    if (!chat) {
      emit('alfred.error', { error: { code: 'chat_not_found', message: 'Chat not found' } });
      return res.end();
    }

    // Persist the user's turn first so we have an id to emit and so
    // the runner sees it when it loads history.
    const userMsg = await alfredChats.appendMessage({
      chatId,
      role:    'user',
      content: userMessage,
    });

    // Auto-name the chat on its first user message — reads better in
    // the history list than "Chat #N". Mirrors the user-chat behaviour.
    await alfredChats.setChatNameIfBlank(chatId, userMessage);

    emit('conversation', { chatId: Number(chatId), messageId: userMsg.id });

    // Signal the client to open an empty assistant bubble. The real
    // server-side id arrives in `alfred.message` after the run.
    emit('alfred.start', {});

    // Run the brainstorm turn. The runner reads history from the DB —
    // the last row is the user message we just inserted, exactly what
    // it wants.
    const { assistantText } = await alfredRunner.runBrainstormTurn({
      chatId:         Number(chatId),
      agentSlug,
      ownerUserId,
      emit,
    });

    // Persist the assistant message only when there's content. Empty
    // replies (network drop, refusal, etc.) leave nothing behind — no
    // ghost rows to clean up.
    if (assistantText && assistantText.trim().length > 0) {
      const asstMsg = await alfredChats.appendMessage({
        chatId,
        role:    'assistant',
        content: assistantText,
      });
      emit('alfred.message', { messageId: asstMsg.id, text: assistantText });
    }

    emit('done', { totalMs: 0 });
    res.end();
  } catch (err) {
    console.error('[alfred] POST messages failed:', err);
    emit('alfred.error', { error: { code: 'runtime_failed', message: err.message } });
    res.end();
  }
});

// ─── Apply flow ────────────────────────────────────────────────────

/**
 * POST /chats/:chatId/apply/preview
 *   Body: { agentSlug, ownerUserId }
 *   Runs the consolidator. Returns the plan; does NOT apply anything.
 */
router.post('/chats/:chatId/apply/preview', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { agentSlug, ownerUserId } = req.body || {};
    if (!agentSlug)   return res.status(400).json({ error: 'Missing agentSlug' });
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });

    const plan = await applyConsolidator.consolidate({
      chatId: Number(chatId),
      agentSlug,
      ownerUserId,
    });

    res.json({
      summary:     plan.summary,
      description: plan.description,
      targets:     plan.targets,
    });
  } catch (err) {
    console.error('[alfred] apply/preview failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /chats/:chatId/apply/generate
 *   Body: {
 *     agentSlug, ownerUserId,
 *     targets: [{ entity, entityId, entityName, what_to_do }, ...]
 *   }
 *
 *   Phase-1 only: for each target, load the viewing-version body,
 *   patch-generate a new body, validate it. Returns all generated
 *   bodies as a draft for the client to drop into the working copy.
 *   Does NOT save and does NOT write log rows — that happens later,
 *   on the user's Save (handled via /log/apply, called by the client
 *   right after Save).
 */
router.post('/chats/:chatId/apply/generate', async (req, res) => {
  const { chatId } = req.params;
  const { agentSlug, ownerUserId, description, reason, targets } = req.body || {};

  if (!agentSlug)             return res.status(400).json({ error: 'Missing agentSlug' });
  if (!ownerUserId)           return res.status(400).json({ error: 'Missing ownerUserId' });
  if (!Array.isArray(targets) || targets.length === 0)
    return res.status(400).json({ error: 'No targets to apply' });

  try {
    // Sort targets so agent runs before its crews. Crew patch generators
    // need the (possibly just-patched) agent body for cross-entity field
    // lookups — if we process a crew first, references to a freshly-added
    // agent field can't be resolved.
    const orderedTargets = [...targets].sort((a, b) => {
      if (a.entity === b.entity) return 0;
      return a.entity === 'agent' ? -1 : 1;
    });

    // Phase 1 — generate + validate every body. Collect successes;
    // bail on first failure so the user sees a focused error.
    // `latestAgentBody` is updated as we go so any subsequent crew
    // target sees the post-patch agent body (with newly added fields).
    const prepared = [];
    let latestAgentBody = null;

    for (const target of orderedTargets) {
      if (!target || !target.entity || !target.entityId)
        return res.status(400).json({ error: 'Malformed target' });

      let currentBody;
      let viewingVersionId;
      let entityNameSnap;

      if (target.entity === 'agent') {
        const { agent, version, body } = await loadAgentViewingBody(target.entityId);
        currentBody       = body;
        viewingVersionId  = version.id;
        entityNameSnap    = body.name || agent.slug;
        if (!latestAgentBody) latestAgentBody = body;
      } else if (target.entity === 'crew') {
        const { version, body } = await loadCrewViewingBody(target.entityId);
        currentBody       = body;
        viewingVersionId  = version.id;
        entityNameSnap    = body.name || target.entityName || target.entityId;
      } else {
        return res.status(400).json({ error: `Unknown target entity "${target.entity}"` });
      }

      // For crew targets: pass the latest agent body as cross-reference.
      // Falls back to a fresh load when there was no agent target earlier
      // in the queue.
      let agentBodyContext = null;
      if (target.entity === 'crew') {
        if (latestAgentBody) {
          agentBodyContext = latestAgentBody;
        } else {
          const parentAgentId = await agentIdForTarget(target);
          const parent = await loadAgentViewingBody(parentAgentId);
          agentBodyContext = parent.body;
          latestAgentBody = parent.body; // cache for siblings
        }
      }

      // Generate new body.
      let newBody;
      try {
        const out = await patchGenerator.generatePatch({
          entity:       target.entity,
          entityId:     target.entityId,
          entityName:   entityNameSnap,
          currentBody,
          whatToDo:     target.what_to_do || '',
          agentBodyContext,
          agentSlug,
          ownerUserId,
          conversationId: Number(chatId),
        });
        newBody = out.newBody;
      } catch (err) {
        return res.status(422).json({
          error: `Patch generator failed for ${target.entity} "${entityNameSnap}": ${err.message}`,
          target,
        });
      }

      // Validate. For crew bodies we use the latest agent body's fields
      // so cross-entity field-id refs validate correctly.
      let validation;
      if (target.entity === 'agent') {
        validation = bodyValidator.validateAgentBody(newBody);
      } else {
        const agentFieldIds = Array.isArray(agentBodyContext?.fields)
          ? agentBodyContext.fields.map(f => f.id).filter(Boolean)
          : [];
        validation = bodyValidator.validateCrewBody(newBody, agentFieldIds);
      }

      if (!validation.ok) {
        return res.status(422).json({
          error: `Generated ${target.entity} body for "${entityNameSnap}" failed validation`,
          errors: validation.errors,
          target,
        });
      }

      // If this was the agent target, propagate its post-patch body
      // forward so the crews after it see the new state.
      if (target.entity === 'agent') latestAgentBody = newBody;

      prepared.push({
        target,
        currentBody,
        newBody,
        entityNameSnap,
      });
    }

    // No save and no log here. Bodies travel back to the client so
    // they land in the working copy; the user saves manually via the
    // existing Save / Save As buttons. The client follows up with
    // /log/apply on Save to write the log row(s).
    const applyGroupId = changeLog.newApplyGroupId();
    res.json({
      ok: true,
      applyGroupId,
      generated: prepared.map(p => ({
        entity:      p.target.entity,
        entityId:    p.target.entityId,
        entityName:  p.entityNameSnap,
        what_to_do:  p.target.what_to_do || '',
        bodyBefore:  p.currentBody,
        newBody:     p.newBody,
      })),
    });
  } catch (err) {
    console.error('[alfred] apply/generate failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /agents/:agentId/log/apply
 *   Body: {
 *     entity, entityId, entityName,
 *     applyGroupId,            // shared across rows from one Apply
 *     description, reason,     // user-editable apply metadata
 *     whatChanged,             // this target's what_to_do
 *     bodyBefore, bodyAfter,   // for the audit JSONB columns
 *     sourceChatId,            // optional — the originating Alfred chat
 *     actor,                   // 'alfred' | 'manual'; default 'alfred'
 *                              //   When the user took an Alfred apply
 *                              //   and substantially rewrote it, they
 *                              //   can attribute it as their own.
 *     ownerUserId,
 *   }
 *
 *   Writes one log row tied to a draft-then-saved body. Called by the
 *   client after each Save that commits a body the user prepared via
 *   Alfred Apply. Multiple targets from a single Apply share the same
 *   applyGroupId so the History modal groups them into one card.
 */
router.post('/agents/:agentId/log/apply', async (req, res) => {
  try {
    const { agentId } = req.params;
    const {
      entity, entityId, entityName,
      applyGroupId,
      description, reason,
      whatChanged,
      bodyBefore, bodyAfter,
      sourceChatId,
      actor,
      ownerUserId,
    } = req.body || {};

    if (!entity || !entityId)   return res.status(400).json({ error: 'Missing entity or entityId' });
    if (!bodyBefore || !bodyAfter) return res.status(400).json({ error: 'Missing body snapshots' });
    if (!ownerUserId)           return res.status(400).json({ error: 'Missing ownerUserId' });

    const safeActor = actor === 'manual' ? 'manual' : 'alfred';

    const parent = await loadAgentViewingBody(agentId);
    const agentNameSnap = parent.body.name || parent.agent.slug;

    const row = await changeLog.insert({
      agentId,
      agentName:    agentNameSnap,
      actor:        safeActor,
      reason:       (reason || '').trim() || description || '',
      whatChanged:  (whatChanged || '').trim(),
      bodyBefore,
      bodyAfter,
      entity,
      entityId,
      entityName:   (entityName || '').trim(),
      sourceChatId: sourceChatId != null ? Number(sourceChatId) : null,
      sourceMsgId:  null,
      applyGroupId: applyGroupId || null,
      appliedBy:    ownerUserId,
    });

    res.json({ ok: true, logId: row.id });
  } catch (err) {
    console.error('[alfred] log/apply failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual change log + Validate & Log ────────────────────────────

/**
 * POST /agents/:agentId/log/validate
 *   Body: { entity, entityId, claim, ownerUserId }
 *   Runs the LLM change validator. Returns { matches, note, bodyBefore,
 *   bodyAfter, entityName } so the client can show the result and let
 *   the user confirm-and-log without a second body fetch.
 *
 *   bodyBefore = most recent agent_log row's body_after for this entity,
 *                else the first-version body (initial state).
 *   bodyAfter  = current viewing version body.
 */
router.post('/agents/:agentId/log/validate', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { entity, entityId, claim, ownerUserId, agentSlug } = req.body || {};
    if (!entity || !entityId) return res.status(400).json({ error: 'Missing entity or entityId' });
    if (!claim || typeof claim !== 'string' || claim.trim().length === 0)
      return res.status(400).json({ error: 'Missing claim' });
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });

    // Resolve current body.
    let currentBody;
    let entityName;
    if (entity === 'agent') {
      const { agent, body } = await loadAgentViewingBody(entityId);
      currentBody = body;
      entityName  = body.name || agent.slug;
    } else if (entity === 'crew') {
      const { body } = await loadCrewViewingBody(entityId);
      currentBody = body;
      entityName  = body.name || `(crew ${entityId})`;
    } else {
      return res.status(400).json({ error: `Unknown entity "${entity}"` });
    }

    // Resolve previous-state body: last logged body_after for this
    // entity, else fall back to v1 body.
    const prior = await loadPriorBody({ entity, entityId });

    const v = await changeValidator.validateClaim({
      bodyBefore: prior.body,
      bodyAfter:  currentBody,
      claim,
      entity,
      agentSlug:  agentSlug || agentId,
      ownerUserId,
    });

    res.json({
      matches:    v.matches,
      note:       v.note,
      entityName,
      bodyBefore: prior.body,
      bodyAfter:  currentBody,
      priorSource: prior.source,  // 'last-log' | 'v1' | 'empty'
    });
  } catch (err) {
    console.error('[alfred] log/validate failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Load the "before" body for a Validate & Log operation.
 * Returns { body, source } where source is informational.
 */
async function loadPriorBody({ entity, entityId }) {
  // Most recent log entry's body_after, if any.
  const { agentLog } = require('../../db/schema');
  const { desc } = require('drizzle-orm');
  const recent = await drizzle().select().from(agentLog)
    .where(eq(agentLog.entityId, entityId))
    .orderBy(desc(agentLog.appliedAt))
    .limit(1);
  if (recent.length > 0) return { body: recent[0].bodyAfter, source: 'last-log' };

  // Fall back to v1 body.
  const d = drizzle();
  if (entity === 'agent') {
    const versions = await d.select().from(builderAgentVersions)
      .where(and(eq(builderAgentVersions.agentId, entityId), eq(builderAgentVersions.number, 1)))
      .limit(1);
    if (versions.length > 0) return { body: versions[0].body, source: 'v1' };
  } else {
    const versions = await d.select().from(builderCrewVersions)
      .where(and(eq(builderCrewVersions.crewId, entityId), eq(builderCrewVersions.number, 1)))
      .limit(1);
    if (versions.length > 0) return { body: versions[0].body, source: 'v1' };
  }
  return { body: {}, source: 'empty' };
}

/**
 * POST /agents/:agentId/log
 *   Body: { entity, entityId, entityName, reason, whatChanged,
 *           bodyBefore, bodyAfter, ownerUserId }
 *   Writes a manual log row. Caller is responsible for calling
 *   /log/validate first and only proceeding when the user confirms
 *   (matches === 'yes' or 'partial').
 */
router.post('/agents/:agentId/log', async (req, res) => {
  try {
    const { agentId } = req.params;
    const {
      entity, entityId, entityName, reason, whatChanged,
      bodyBefore, bodyAfter, ownerUserId,
    } = req.body || {};

    if (!entity || !entityId) return res.status(400).json({ error: 'Missing entity or entityId' });
    if (!bodyBefore || !bodyAfter) return res.status(400).json({ error: 'Missing body snapshots' });
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });

    // Snapshot the agent's display name.
    const parent = await loadAgentViewingBody(agentId);
    const agentNameSnap = parent.body.name || parent.agent.slug;

    const row = await changeLog.insert({
      agentId,
      agentName:    agentNameSnap,
      actor:        'manual',
      reason:       (reason || '').trim(),
      whatChanged:  (whatChanged || '').trim(),
      bodyBefore,
      bodyAfter,
      entity,
      entityId,
      entityName:   (entityName || '').trim(),
      appliedBy:    ownerUserId,
    });

    res.json({ ok: true, logId: row.id });
  } catch (err) {
    console.error('[alfred] manual log insert failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /agents/:agentId/log
 *   List log rows for the agent, newest first.
 *   Used by the ChangeLog panel (slice 4 UI).
 */
router.get('/agents/:agentId/log', async (req, res) => {
  try {
    const rows = await changeLog.listForAgent(req.params.agentId, 100);
    res.json({ entries: rows });
  } catch (err) {
    console.error('[alfred] log list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
