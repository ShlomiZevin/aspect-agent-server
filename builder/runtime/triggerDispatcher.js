/**
 * triggerDispatcher — run one agent's triggers: find who's due, decide
 * whether it's appropriate, launch the crew, record what happened.
 *
 * See docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * ── Three functions, and picking the wrong one is the hazard ───────
 *
 *   findDue       (in triggerEvaluator) — WHO matches. Read-only; acts
 *                 on nobody. Reach for this to inspect a rule.
 *   fireOne       — act on ONE named conversation. It can only ever
 *                 touch the id you hand it.
 *   sweepTrigger  — findDue, then fireOne for every match. Agent-wide
 *                 BY DEFINITION: that is what a trigger is.
 *
 * Only the clock, "Step once" and "Run now" should call `sweepTrigger`.
 * Anything that means "just this one conversation" — a test harness, a
 * future per-conversation Fire now — calls `fireOne`, which cannot
 * reach anything else by construction. An earlier version of this file
 * grew an `onlyConversationIds` filter on `sweepTrigger` so a test could
 * use it safely; that was a patch over a caller reaching for the wrong
 * primitive, and it has been removed.
 *
 * ── The three gates, in cost order ─────────────────────────────────
 *
 *   1. The trigger's CLAUSES — one indexed query across the agent's
 *      conversations, no memory loaded. Thousands → a handful.
 *   2. QUIET HOURS — a wall-clock check on the handful.
 *   3. The FILTER — the author's memory conditions. This is the first
 *      moment a conversation's brain is read, which is exactly why it
 *      can't be part of gate 1.
 *
 * Everything that reaches gate 1 gets an event row, whatever happens
 * next. A conversation that matched and was then filtered out, or
 * silenced by quiet hours, or answered with deliberate silence, leaves
 * the same trail as one that spoke — because "it fired 40 times last
 * night and said nothing every time" is a bug you can only see if the
 * quiet outcomes are recorded too.
 */

const db = require('../../services/db.pg');
const builderMemory = require('./builderMemory');
const triggerEvaluator = require('./triggerEvaluator');
const triggerEventsStore = require('./triggerEventsStore');
const { evaluateConditions } = require('./conditionMatcher');
const { runProactive } = require('./BuilderRunner');
const { resolveAgentBody } = require('../services/builderProjects');

/**
 * How many conversations one trigger may act on in a single sweep.
 *
 * A backlog must not be able to spend the whole LLM budget in one
 * minute — the overflow simply matches again next tick, so nothing is
 * lost, it is only spread out. Generous enough that normal traffic
 * never notices it.
 */
const MAX_FIRES_PER_SWEEP = 25;

/**
 * Turn a sweep's outcome into the one line the trigger card shows.
 *
 * The point is the ZERO case. "Nobody was quiet enough" was being said
 * for every empty sweep, including when conversations WERE quiet and had
 * simply used up their attempts — two situations that need completely
 * different responses from the author, reported identically.
 *
 * Clause names come from the trigger type, so this stays honest for
 * types that don't exist yet.
 */
function describeZero(matched, blocked) {
  if (matched > 0) return `${matched} matched`;
  const entries = Object.entries(blocked || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'nobody was quiet enough';
  const [name, n] = entries[0];
  const conv = `${n} conversation${n === 1 ? '' : 's'}`;
  if (name === 'under the cap')      return `${conv} quiet, but already at the nudge limit`;
  if (name === 'spacing')            return `${conv} quiet, but nudged too recently`;
  if (name === 'after switch-on')    return `${conv} quiet, but they went quiet before this trigger was switched on`;
  if (name === 'quiet long enough')  return 'nobody was quiet enough';
  return `${conv} blocked by "${name}"`;
}

/** `conversations.agent_id` is the LEGACY agents row for this slug. */
async function resolveLegacyAgentId(agentSlug) {
  const { rows } = await db.query('SELECT id FROM agents WHERE url_slug = $1 LIMIT 1', [agentSlug]);
  return rows.length ? rows[0].id : null;
}

/** The conversation's owning user — needed to load its memory blob. */
async function resolveConversationUser(conversationId) {
  const { rows } = await db.query(
    'SELECT user_id, metadata FROM conversations WHERE id = $1 LIMIT 1', [conversationId]);
  return rows.length ? rows[0] : null;
}

/**
 * Which agent version a proactive turn should run for a conversation.
 *
 * Not a setting — it is derivable, and deriving it is what keeps the
 * builder honest: a real customer conversation must run what customers
 * see (`published`), and a builder-preview conversation runs what the
 * author is editing (`viewing`). Mixing them would mean either testing
 * against a stale published version or nudging live customers with a
 * half-finished draft.
 *
 * Note this is about the CONVERSATION, and is separate from the clock's
 * own `mode`, which decides where a trigger's *definition* is read from.
 * A trigger discovered in the published body can still run a preview
 * conversation against the viewing body — that is correct: the trigger
 * said "act on this conversation", and this decides what the
 * conversation should be answered with.
 */
function versionForConversation(convMeta) {
  return convMeta && convMeta.kind === 'live' ? 'published' : 'viewing';
}

/**
 * Act on ONE conversation for one trigger. Opens an event, walks the
 * remaining gates, launches the crew, closes the event.
 *
 * The narrow primitive — it touches the conversation you name and
 * nothing else.
 *
 * Never throws: one bad conversation must not abort a sweep for the
 * others. Failures are recorded as `error` events.
 */
async function fireOne({ agentSlug, agentId, trigger, conversationId, matchReason, now = new Date() }) {
  const startedAt = new Date();
  let eventId = null;
  try {
    eventId = await triggerEventsStore.open({
      agentId,
      triggerId:      trigger.id,
      triggerType:    trigger.typeId,
      conversationId,
      matchReason,
      launchedCrewId: trigger.run?.crewId || null,
    });

    // ── Gate 2: quiet hours ──
    const quiet = triggerEvaluator.checkQuietHours(trigger.quietHours, now);
    if (quiet.suppressed) {
      await triggerEventsStore.close(eventId, {
        outcome: 'quiet_hours', startedAt, error: null, briefUsed: null,
        filterResult: [{ type: 'quiet-hours', ok: false, why: quiet.why }],
      });
      console.log(`[triggers]     #${conversationId} -> held back: ${quiet.why}`);
      return { outcome: 'quiet_hours', why: quiet.why, eventId };
    }

    const conv = await resolveConversationUser(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} vanished mid-sweep`);

    // ── Gate 3: the author's Filter. First read of this brain. ──
    let filterResult;
    const conditions = trigger.filter?.conditions;
    if (Array.isArray(conditions) && conditions.length > 0) {
      const blob = await builderMemory.loadMemory(conv.user_id, conversationId);
      const evalResult = evaluateConditions(blob, conditions, { instanceId: trigger.id });
      const mode = trigger.filter.mode === 'exclude' ? 'exclude' : 'include';
      const passes = mode === 'include' ? evalResult.ok : !evalResult.ok;
      filterResult = evalResult.evaluations;
      if (!passes) {
        await triggerEventsStore.close(eventId, {
          outcome: 'filtered', filterResult, startedAt, briefUsed: null,
        });
        const failed = evalResult.evaluations.find(e => !e.ok);
        console.log(`[triggers]     #${conversationId} -> filtered: ${failed ? failed.why : 'conditions not met'}`);
        return { outcome: 'filtered', why: failed ? failed.why : 'filter rejected', eventId };
      }
    }

    // ── Launch. Whether it speaks is the crew's decision, not ours. ──
    const result = await runProactive({
      agentSlug,
      ownerUserId: null,             // resolved conversations don't need it
      userId:      conv.user_id,
      conversationId,
      crewId:      trigger.run?.crewId,
      brief:       trigger.run?.brief || '',
      version:     versionForConversation(conv.metadata),
      reason:      matchReason,
    });

    await triggerEventsStore.close(eventId, {
      outcome:      result.outcome,          // 'spoke' | 'silent'
      filterResult,
      briefUsed:    result.briefUsed,
      messageId:    result.assistantMessageId,
      startedAt,
    });
    console.log(`[triggers]     #${conversationId} -> ${result.outcome}` +
      (result.assistantMessageId ? ` (message ${result.assistantMessageId})` : ''));
    return { outcome: result.outcome, eventId, messageId: result.assistantMessageId };
  } catch (err) {
    console.error(`[triggerDispatcher] ${trigger.id} on conversation ${conversationId}:`, err.message);
    if (eventId) {
      await triggerEventsStore.close(eventId, {
        outcome: 'error', error: err.message, startedAt,
      }).catch(() => {});
    }
    return { outcome: 'error', why: err.message, eventId };
  }
}

/**
 * Sweep ONE trigger: find its due conversations and act on EVERY one.
 *
 * Agent-wide, deliberately. If you mean one conversation, call
 * `fireOne` — see the header.
 *
 * @param {object}  args
 * @param {string}  args.agentSlug
 * @param {string}  args.agentId    builder agent id (stamped on event rows)
 * @param {object}  args.trigger
 * @param {Date}    [args.now]
 * @param {boolean} [args.dryRun]   evaluate and report; launch nothing
 */
async function sweepTrigger({ agentSlug, agentId, trigger, now = new Date(), dryRun = false, conversationKinds = null }) {
  const legacyAgentId = await resolveLegacyAgentId(agentSlug);
  if (!legacyAgentId) {
    return { triggerId: trigger.id, matched: 0, fired: [], note: 'agent has no conversations yet' };
  }

  let due = [];
  let blocked = {};
  let error = null;
  try {
    ({ due, blocked } = await triggerEvaluator.findDue({ legacyAgentId, trigger, now, limit: MAX_FIRES_PER_SWEEP * 4, conversationKinds }));
  } catch (err) {
    error = err.message;
    console.error(`[triggerDispatcher] findDue failed for ${trigger.id}:`, err.message);
  }

  // Status is recorded even on a dry run — "we looked" is true either
  // way, and it is what keeps the card's heartbeat honest.
  await triggerEventsStore.recordEvaluation({
    agentId, triggerId: trigger.id, matched: due.length, error,
    reason: describeZero(due.length, blocked),
  }).catch(e => console.error('[triggerDispatcher] status write failed:', e.message));

  if (error) return { triggerId: trigger.id, matched: 0, fired: [], error };

  // Every trigger line names its agent. An agent can hold many triggers,
  // so a bare trigger name is ambiguous the moment two agents both have
  // one called "Silence". The wording of the zero case comes from the
  // same helper the card uses — the log and the UI disagreeing about why
  // nothing fired is its own kind of bug.
  console.log(`[triggers]   ${agentSlug} · ${trigger.name || trigger.id} — ` + (due.length
    ? `${due.length} due: ${due.map(d => '#' + d.facts.conversationId).join(', ')}`
    : describeZero(0, blocked)));

  const capped = due.slice(0, MAX_FIRES_PER_SWEEP);
  if (capped.length < due.length) {
    // Never truncate silently: the overflow is not lost (it matches
    // again next tick), but an author looking at "25 fires" deserves to
    // know it was a cap and not the true number.
    console.log(`[triggerDispatcher] ${trigger.id}: ${due.length} due, capped at ${MAX_FIRES_PER_SWEEP} this sweep — the rest match again next tick`);
  }

  if (dryRun) {
    return {
      triggerId: trigger.id,
      matched:   due.length,
      dryRun:    true,
      wouldFire: capped.map(d => ({
        conversationId: d.facts.conversationId,
        reason:         d.evaluation.reason,
        clauses:        d.evaluation.clauses,
      })),
      cappedAt: capped.length < due.length ? MAX_FIRES_PER_SWEEP : null,
    };
  }

  const fired = [];
  for (const d of capped) {
    fired.push({
      conversationId: d.facts.conversationId,
      ...(await fireOne({
        agentSlug, agentId, trigger,
        conversationId: d.facts.conversationId,
        matchReason:    d.evaluation.reason,
        now,
      })),
    });
  }

  return {
    triggerId: trigger.id,
    matched:   due.length,
    fired,
    cappedAt:  capped.length < due.length ? MAX_FIRES_PER_SWEEP : null,
  };
}

/**
 * Sweep every enabled trigger on one agent.
 *
 * Triggers are read from the PUBLISHED agent body by default — the
 * clock must run what was deliberately published, never a draft
 * somebody is mid-edit on. The builder's own Step-once passes
 * `mode: 'viewing'` when an author wants to sweep what they're editing.
 */
async function sweepAgent({ agentSlug, mode = 'published', now = new Date(), dryRun = false, conversationKinds = null }) {
  const agent = await resolveAgentBody({ agentSlug, mode });
  if (agent.archived) return { agentSlug, skipped: 'archived', results: [] };

  const def = agent.body?.triggers;
  const all = Array.isArray(def?.triggers) ? def.triggers : [];
  // `enabled` is absent-means-on, so agents saved before triggers
  // existed behave exactly as they did.
  if (def && def.enabled === false) {
    console.log(`[triggers]   ${agentSlug} — skipped: the agent's Triggers master switch is off`);
    return { agentSlug, skipped: 'triggers disabled for this agent', results: [] };
  }
  const active = all.filter(t => t && t.enabled !== false && t.typeId && t.run?.crewId);
  if (all.length > 0 && active.length === 0) {
    // A trigger that exists but is skipped is worth a line — 'off' and
    // 'no crew picked' look identical from the outside otherwise.
    const why = all.map(t => `${t.name || t.id}: ${t.enabled === false ? 'switched off' : !t.run?.crewId ? 'no crew picked' : 'no type'}`);
    console.log(`[triggers]   ${agentSlug} — ${all.length} trigger(s), none runnable: ${why.join('; ')}`);
  }

  const results = [];
  for (const trigger of active) {
    results.push(await sweepTrigger({
      agentSlug, agentId: agent.agentId, trigger, now, dryRun, conversationKinds,
    }));
  }
  return { agentSlug, agentId: agent.agentId, triggerCount: active.length, results };
}

module.exports = {
  sweepAgent,
  sweepTrigger,
  fireOne,
  versionForConversation,
  MAX_FIRES_PER_SWEEP,
};
