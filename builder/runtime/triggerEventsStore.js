/**
 * triggerEventsStore — the log AND the state for Builder V2 Triggers.
 *
 * See docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * A row is created the moment a conversation MATCHES a trigger's
 * clauses, and updated with an outcome once we know how far it got. The
 * five outcomes:
 *
 *   filtered     matched, but the author's Filter conditions rejected it
 *   quiet_hours  matched and passed the Filter, but outside the window
 *   spoke        the crew ran and produced a message
 *   silent       the crew ran and deliberately said nothing
 *   error        the crew threw
 *
 * Every one of them is an ATTEMPT and every one counts toward the cap.
 * That is what makes the cap a real bound: if only `spoke` counted, a
 * crew that stays silent would never advance the counter and the trigger
 * would retry forever.
 *
 * These rows are also the state. `attemptsSinceLastUserMessage` — the
 * number the nudge cap is checked against — is COUNTED from here rather
 * than stored anywhere, because it is history, not configuration.
 * Storing it separately would create a second copy that can disagree
 * with the log, and the log is the thing an author reads when something
 * looks wrong.
 */

const db = require('../../services/db.pg');
const { triggerEvents, triggerStatus } = require('../../db/schema');
const { eq, and, sql } = require('drizzle-orm');

function drizzle() {
  return db.getDrizzle();
}

function uid() {
  return `tev_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/**
 * Open an event — a conversation matched, we are about to act on it.
 * Written BEFORE the Filter and before the crew runs, so a crash
 * mid-chain still leaves evidence that we got this far.
 *
 * @returns {Promise<string>} the event id
 */
async function open({ agentId, triggerId, triggerType, conversationId, matchReason, launchedCrewId }) {
  const id = uid();
  const now = new Date();
  await drizzle().insert(triggerEvents).values({
    id,
    agentId:        String(agentId),
    triggerId:      String(triggerId),
    triggerType:    String(triggerType),
    conversationId: Number(conversationId),
    matchedAt:      now,
    status:         'running',
    matchReason:    matchReason || null,
    launchedCrewId: launchedCrewId || null,
    startedAt:      now,
  });
  return id;
}

/** Close an event with its outcome. */
async function close(eventId, { outcome, filterResult, briefUsed, messageId, error, startedAt }) {
  const endedAt = new Date();
  await drizzle().update(triggerEvents)
    .set({
      status:  'done',
      outcome,
      ...(filterResult !== undefined ? { filterResult } : {}),
      ...(briefUsed    !== undefined ? { briefUsed }    : {}),
      ...(messageId    !== undefined ? { messageId: messageId ? Number(messageId) : null } : {}),
      ...(error        !== undefined ? { error } : {}),
      endedAt,
      durationMs: startedAt ? endedAt.getTime() - new Date(startedAt).getTime() : null,
    })
    .where(eq(triggerEvents.id, eventId));
}

/**
 * Update the never-growing status row for one trigger.
 *
 * `consecutiveEmpty` is why this exists rather than deriving everything
 * from the event log: "checked 2 minutes ago, 47 quiet checks in a row"
 * tells an author the trigger is alive and nobody qualifies, which from
 * the outside looks exactly the same as broken.
 */
async function recordEvaluation({ agentId, triggerId, matched, error, reason }) {
  const now = new Date();
  const lastResult = error ? 'error' : (matched > 0 ? 'matched' : 'nothing');
  await drizzle().insert(triggerStatus)
    .values({
      triggerId:        String(triggerId),
      agentId:          String(agentId),
      lastEvaluatedAt:  now,
      lastResult,
      lastMatched:      matched || 0,
      consecutiveEmpty: matched > 0 ? 0 : 1,
      lastFiredAt:      matched > 0 ? now : null,
      lastError:        error || null,
      lastReason:       reason || null,
      updatedAt:        now,
    })
    .onConflictDoUpdate({
      target: triggerStatus.triggerId,
      set: {
        agentId:         String(agentId),
        lastEvaluatedAt: now,
        lastResult,
        lastMatched:     matched || 0,
        // Reset on a match, otherwise increment — done in SQL so two
        // ticks racing can't both read-then-write the same old value.
        consecutiveEmpty: matched > 0
          ? sql`0`
          : sql`${triggerStatus.consecutiveEmpty} + 1`,
        lastFiredAt: matched > 0 ? now : sql`${triggerStatus.lastFiredAt}`,
        lastError:   error || null,
        lastReason:  reason || null,
        updatedAt:   now,
      },
    });
}

/** Status rows for an agent's triggers, keyed by trigger id. */
async function statusForAgent(agentId) {
  const rows = await drizzle().select().from(triggerStatus)
    .where(eq(triggerStatus.agentId, String(agentId)));
  return Object.fromEntries(rows.map(r => [r.triggerId, r]));
}

/** Recent events for one trigger — the card's feed. */
async function recentForTrigger(triggerId, limit = 50) {
  return drizzle().select().from(triggerEvents)
    .where(eq(triggerEvents.triggerId, String(triggerId)))
    .orderBy(sql`${triggerEvents.matchedAt} DESC`)
    .limit(limit);
}

/**
 * Every trigger's events for one agent, newest first — the admin feed.
 *
 * The per-trigger feed answers "what did THIS rule do". This one answers
 * the question an operator actually opens the page with: "what has this
 * agent been saying to people on its own?" — which spans every trigger
 * and is the only view where you'd notice one rule firing far more than
 * you expected.
 */
async function recentForAgent(agentId, limit = 100) {
  return drizzle().select().from(triggerEvents)
    .where(eq(triggerEvents.agentId, String(agentId)))
    .orderBy(sql`${triggerEvents.matchedAt} DESC`)
    .limit(limit);
}

/** Every event on one conversation — "why did this customer hear from us?" */
async function forConversation(conversationId, limit = 100) {
  return drizzle().select().from(triggerEvents)
    .where(eq(triggerEvents.conversationId, Number(conversationId)))
    .orderBy(sql`${triggerEvents.matchedAt} DESC`)
    .limit(limit);
}

module.exports = {
  open,
  close,
  recordEvaluation,
  statusForAgent,
  recentForTrigger,
  recentForAgent,
  forConversation,
};
