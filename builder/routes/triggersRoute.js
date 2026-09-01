/**
 * Builder V2 — Triggers routes (proactive).
 *
 * Mounted on `/api/agents/:slug/triggers` (plus one conversation-scoped
 * read under `/api/agents/:slug/conversations/:convId/trigger-events`).
 * See docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * ── Working copies ─────────────────────────────────────────────────
 *
 * Every endpoint that needs a trigger definition accepts an optional
 * `trigger` object in the body, and only falls back to the saved agent
 * body when it isn't given. That is not a convenience — it is the whole
 * reason Check and Explain are usable. An author tuning "nudge after 30
 * minutes" is, by definition, looking at a number they haven't saved
 * yet; making them save first to find out whether it would fire would
 * turn every experiment into a version.
 *
 * The clock never does this. It reads the published body, always.
 */

const express = require('express');
const triggerRegistry = require('../triggers');
const triggerEvaluator = require('../runtime/triggerEvaluator');
const triggerEventsStore = require('../runtime/triggerEventsStore');
const triggerDispatcher = require('../runtime/triggerDispatcher');
const { resolveAgentBody } = require('../services/builderProjects');
const triggerClock = require('../../services/trigger-clock.service');

const router = express.Router({ mergeParams: true });

/**
 * Resolve the trigger to act on: the caller's working copy if they sent
 * one, otherwise the saved definition.
 */
async function resolveTrigger({ slug, triggerId, bodyTrigger, mode = 'viewing' }) {
  if (bodyTrigger && typeof bodyTrigger === 'object' && bodyTrigger.typeId) {
    return { trigger: { ...bodyTrigger, id: bodyTrigger.id || triggerId }, source: 'working-copy' };
  }
  const agent = await resolveAgentBody({ agentSlug: slug, mode });
  const list = Array.isArray(agent.body?.triggers?.triggers) ? agent.body.triggers.triggers : [];
  const found = list.find(t => t.id === triggerId);
  if (!found) throw new Error(`No saved trigger "${triggerId}" on this agent — save it first, or send the working copy.`);
  return { trigger: found, source: 'saved', agentId: agent.agentId };
}

/**
 * GET /api/agents/:slug/triggers/types
 *   The registered trigger types, for the Add Trigger picker.
 */
router.get('/:slug/triggers/types', (_req, res) => {
  res.json({ types: triggerRegistry.listTriggerDescriptors() });
});

/**
 * GET /api/agents/:slug/triggers/status
 *   One status row per trigger — what each card's heartbeat line shows.
 *   Absent = never evaluated (a brand-new trigger, or the clock has
 *   never run), which the client renders differently from "found
 *   nothing".
 */
router.get('/:slug/triggers/status', async (req, res) => {
  try {
    const agent = await resolveAgentBody({ agentSlug: req.params.slug, mode: 'viewing' });
    const status = await triggerEventsStore.statusForAgent(agent.agentId);
    res.json({ agentId: agent.agentId, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/triggers/events?limit=
 *   Every trigger's events for this agent, newest first — the admin
 *   feed. Distinct from the per-trigger feed below: this is the view
 *   where you'd notice one rule firing far more than you expected,
 *   because it puts them side by side.
 *
 *   Declared BEFORE `/:triggerId/events` so the literal path wins —
 *   otherwise Express matches "events" as a triggerId and this endpoint
 *   silently returns nothing.
 */
router.get('/:slug/triggers/events', async (req, res) => {
  try {
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const agent = await resolveAgentBody({ agentSlug: req.params.slug, mode: 'viewing' });
    const events = await triggerEventsStore.recentForAgent(agent.agentId, limit);
    res.json({ agentId: agent.agentId, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/triggers/:triggerId/events?limit=
 *   The card's feed. Includes the outcomes that produced no message —
 *   filtered, quiet_hours, silent — which are the ones worth reading.
 */
router.get('/:slug/triggers/:triggerId/events', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const events = await triggerEventsStore.recentForTrigger(req.params.triggerId, limit);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:slug/triggers/:triggerId/check
 *   Body: { conversationId, trigger? }
 *
 *   "Would this fire on this conversation right now, and if not, which
 *   clause stopped it?" Evaluates and explains. Sends nothing, launches
 *   nothing, writes nothing.
 */
router.post('/:slug/triggers/:triggerId/check', async (req, res) => {
  try {
    const { conversationId, trigger: bodyTrigger } = req.body || {};
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });

    const { trigger, source } = await resolveTrigger({
      slug: req.params.slug, triggerId: req.params.triggerId, bodyTrigger,
    });
    const result = await triggerEvaluator.checkOne({ trigger, conversationId });
    const quiet = triggerEvaluator.checkQuietHours(trigger.quietHours, result.at);

    res.json({
      source,
      at:         result.at,
      wouldFire:  result.evaluation.ok && !quiet.suppressed,
      reason:     result.evaluation.reason,
      clauses:    result.evaluation.clauses,
      quietHours: quiet,
      facts:      result.facts,
      // The Filter is NOT evaluated here on purpose: it reads the
      // conversation's memory, and Check is meant to be an instant,
      // side-effect-free answer about the trigger's own rule. A Test
      // fire is where the Filter actually runs.
      note: 'Clauses only — the Filter runs at fire time, against the conversation memory.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:slug/triggers/:triggerId/explain
 *   Body: { conversationId, at, trigger? }
 *
 *   "Why did this conversation get nothing at 15:00?" Recomputes the
 *   decision from immutable facts (message timestamps, this trigger's
 *   own event rows) rather than reading a log — so it shows the
 *   arithmetic, not just a verdict. That is why there is no
 *   per-evaluation log table anywhere in this feature.
 */
router.post('/:slug/triggers/:triggerId/explain', async (req, res) => {
  try {
    const { conversationId, at, trigger: bodyTrigger } = req.body || {};
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    if (!at)             return res.status(400).json({ error: 'Missing `at` — explain answers about a moment' });

    const { trigger, source } = await resolveTrigger({
      slug: req.params.slug, triggerId: req.params.triggerId, bodyTrigger,
    });
    const result = await triggerEvaluator.explainAt({ trigger, conversationId, at });

    res.json({
      source,
      at:            result.at,
      wouldHaveFired: result.evaluation.ok,
      reason:        result.evaluation.reason,
      clauses:       result.evaluation.clauses,
      facts:         result.facts,
      configCaveat:  result.configCaveat,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:slug/triggers/:triggerId/sweep
 *   Body: { dryRun?, mode? }
 *
 *   Run ONE trigger's sweep on demand — the per-card "Run now". With
 *   `dryRun: true` it reports who WOULD be acted on and why, and
 *   launches nothing: the safe way to point a new trigger at a live
 *   agent and see the blast radius before arming it.
 */
router.post('/:slug/triggers/:triggerId/sweep', async (req, res) => {
  try {
    const { dryRun = false, mode = 'viewing', trigger: bodyTrigger } = req.body || {};
    const agent = await resolveAgentBody({ agentSlug: req.params.slug, mode });
    const { trigger } = await resolveTrigger({
      slug: req.params.slug, triggerId: req.params.triggerId, bodyTrigger, mode,
    });
    if (!trigger.run?.crewId) {
      return res.status(400).json({ error: 'This trigger has no crew to run — pick one first.' });
    }
    const result = await triggerDispatcher.sweepTrigger({
      agentSlug: req.params.slug,
      agentId:   agent.agentId,
      trigger,
      dryRun:    !!dryRun,
      // These two routes call the dispatcher directly, going around the
      // clock — so they have to apply the same environment wall the
      // clock does, or a laptop could message real customers over HTTP.
      conversationKinds: triggerClock.environmentKinds(),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:slug/triggers/sweep
 *   Body: { dryRun?, mode? }
 *
 *   Sweep every enabled trigger on this agent — the admin "Step once".
 *   Defaults to `viewing` because a human pressing this button is
 *   testing; the clock passes `published`.
 */
router.post('/:slug/triggers/sweep', async (req, res) => {
  try {
    const { dryRun = false, mode = 'viewing' } = req.body || {};
    const result = await triggerDispatcher.sweepAgent({
      agentSlug: req.params.slug, mode, dryRun: !!dryRun,
      conversationKinds: triggerClock.environmentKinds(),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/conversations/:convId/trigger-events
 *   Every trigger event on one conversation — "why did this customer
 *   hear from us?", and equally "what did we consider and decide
 *   against?". Feeds the slim timestamped cards in the builder chat for
 *   the outcomes that produced no message.
 */
router.get('/:slug/conversations/:convId/trigger-events', async (req, res) => {
  try {
    const events = await triggerEventsStore.forConversation(req.params.convId);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ─── The clock ─────────────────────────────────────────────────────
 *
 * Mounted under the agent prefix so it sits next to everything else a
 * Triggers screen needs, but it is SYSTEM level: every agent reads and
 * controls the same one clock. The slug in the path is ignored on
 * purpose — a per-agent clock would only let each agent configure how
 * late its own fires may be, which is nobody's idea of a feature.
 */

/**
 * GET /api/agents/:slug/triggers/clock
 *   Health for the admin line: on/off, whether a tick is in flight,
 *   which agents have triggers at all, and the precision caveat.
 */
router.get('/:slug/triggers/clock', async (_req, res) => {
  try {
    res.json(await triggerClock.health());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/agents/:slug/triggers/clock
 *   Body: { enabled? }
 *
 *   The pause switch. Deliberately one click away from wherever the
 *   events are being read: the moment you notice a bad prompt nudging
 *   customers at 2am, stopping it must not require finding a different
 *   screen.
 */
router.patch('/:slug/triggers/clock', async (req, res) => {
  try {
    const { enabled, intervalSeconds, mode } = req.body || {};
    const patch = {};
    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (intervalSeconds !== undefined) patch.intervalSeconds = intervalSeconds;
    if (mode !== undefined) patch.mode = mode;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to change — send enabled, intervalSeconds or mode' });
    }
    await triggerClock.setSettings(patch);
    res.json(await triggerClock.health());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:slug/triggers/clock/step
 *   Body: { dryRun?, mode? }
 *
 *   "Step once" — run a tick by hand, even while the clock is paused.
 *   This is how you watch the thing work without waiting a minute, and
 *   with `dryRun` it is how you see the blast radius before ever
 *   switching the clock on.
 */
router.post('/:slug/triggers/clock/step', async (req, res) => {
  try {
    const { dryRun = false, mode = 'published' } = req.body || {};
    const result = await triggerClock.runTick({
      force: true, dryRun: !!dryRun, mode, holder: 'admin-step',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:slug/triggers/:triggerId/fire
 *   Body: { conversationId, trigger? }
 *
 *   Run this trigger against ONE named conversation, right now.
 *
 *   ── Why this is the safe shape ───────────────────────────────────
 *
 *   It calls `fireOne` — the same function the clock's sweep calls once
 *   per matched conversation. Not a copy of it, not a test-only path:
 *   the identical gates, the identical proactive turn, the identical
 *   event row. What you see here is what the clock will do, which is
 *   the only reason a manual run is worth anything.
 *
 *   `fireOne` can only ever touch the id it is handed, so the blast
 *   radius is one conversation by construction rather than by a filter
 *   somebody has to remember to pass. (`sweepTrigger` is the agent-wide
 *   one, and an earlier version of this feature grew a filter on it so
 *   a test could use it safely — that was a patch over a caller
 *   reaching for the wrong primitive, and it was removed.)
 *
 *   ── What it skips, and what it does not ──────────────────────────
 *
 *   The type's TIMING clauses are not required to pass: pressing the
 *   button means "pretend this one is due", which is the entire point
 *   of testing without waiting a day. Everything after that is real —
 *   quiet hours, the Filter, the crew, and the event row. So a manual
 *   run counts against the nudge cap and shows up in Admin like any
 *   other, because it IS one.
 *
 *   The clause evaluation still runs, and is returned as `wouldFire`,
 *   so the answer to "would the clock have picked this one on its own?"
 *   comes back alongside the result instead of being guessed at.
 *
 *   ── It runs what you are looking at ──────────────────────────────
 *
 *   `trigger`, `overrideAgentBody` and `overrideCrewBody` are the
 *   builder's working copies, unsaved edits included — the same three
 *   the builder CHAT already sends on a user turn. So "send a message
 *   and see" and "fire the trigger and see" run identical bodies, which
 *   is the only way the two can be compared. Omit them (as the clock
 *   does) and it falls back to the saved version, unchanged.
 */
router.post('/:slug/triggers/:triggerId/fire', async (req, res) => {
  try {
    const {
      conversationId, trigger: bodyTrigger,
      overrideAgentBody = null, overrideCrewBody = null,
    } = req.body || {};
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });

    const agent = await resolveAgentBody({ agentSlug: req.params.slug, mode: 'viewing' });
    const { trigger, source } = await resolveTrigger({
      slug: req.params.slug, triggerId: req.params.triggerId, bodyTrigger,
    });
    if (!trigger.run?.crewId) {
      return res.status(400).json({ error: 'This trigger has no crew to run — pick one first.' });
    }

    // ── The conversation must belong to THIS agent ──
    // Without this the endpoint would take any integer and act on it,
    // which would make "one conversation" a much weaker guarantee than
    // it sounds: the wrong id, or a guessed one, would reach a stranger.
    const conv = await triggerDispatcher.describeConversation(req.params.slug, Number(conversationId));
    if (!conv) {
      return res.status(404).json({ error: `Conversation ${conversationId} is not on this agent.` });
    }

    // ── The same environment wall the clock lives behind ──
    // A laptop shares production's database, so a real conversation
    // deep-linked into the builder (`?c=<id>`) is genuinely reachable
    // here. Refuse rather than rely on the author noticing.
    const allowed = triggerClock.environmentKinds();
    if (allowed && !allowed.includes(conv.kind)) {
      return res.status(400).json({
        error: 'Running outside production can only act on builder-preview conversations. '
          + `This one is "${conv.kind || 'live'}", so nothing was sent.`,
      });
    }

    // Informational: would the clock have chosen this one by itself?
    let wouldFire = null;
    let clauses = [];
    try {
      const check = await triggerEvaluator.checkOne({ trigger, conversationId: Number(conversationId) });
      wouldFire = check.evaluation.ok;
      clauses = check.evaluation.clauses;
    } catch { /* never block the run on the explainer */ }

    const result = await triggerDispatcher.fireOne({
      agentSlug:      req.params.slug,
      agentId:        agent.agentId,
      trigger,
      conversationId: Number(conversationId),
      matchReason:    'run by hand from the builder',
      overrideAgentBody,
      overrideCrewBody,
    });

    res.json({ ...result, source, conversationId: Number(conversationId), wouldFire, clauses });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:slug/triggers/round
 *   Body: { conversationId, triggers?, overrideAgentBody?, overrideCrewBodies? }
 *
 *   Every trigger on ONE agent, against ONE conversation. Two modes:
 *
 *     simulate  Ask each trigger the question the clock asks — "is this
 *               conversation due for you right now?" — and report the
 *               answer with its arithmetic. Runs NOTHING. This is the
 *               tick simulation: it tells you what the clock would do
 *               without doing it.
 *     force     Run every enabled trigger on this conversation whether
 *               or not it is due. For seeing what the crews actually
 *               produce, without waiting a day for "due" to arrive.
 *
 *   Neither is agent-wide and neither is system-wide: the conversation
 *   is named by the caller, so the blast radius is one thread either
 *   way. The system-wide round is the clock's own job, and the clock is
 *   the only thing that does it.
 *
 *   `/fire` is the same as `force`, narrowed further to one trigger.
 *
 *   ── Why it is not just the clock with a filter ───────────────────
 *
 *   Because a clock tick's job is to FIND conversations, and this one
 *   is handed its conversation. Running the real tick with a
 *   one-conversation filter would mean widening `sweepTrigger` with an
 *   `onlyConversationIds` argument — which this feature already tried
 *   once and removed, because a caller who wants one conversation
 *   should reach for the primitive that can only touch one. The rule
 *   itself is not duplicated: the clause evaluation is `checkOne` and
 *   the run is `fireOne`, the same two the sweep uses.
 */
router.post('/:slug/triggers/round', async (req, res) => {
  try {
    const {
      conversationId,
      triggers: bodyTriggers,
      overrideAgentBody = null,
      overrideCrewBodies = null,
      mode = 'simulate',
    } = req.body || {};
    if (mode !== 'simulate' && mode !== 'force') {
      return res.status(400).json({ error: `Unknown mode "${mode}" — expected "simulate" or "force".` });
    }
    // Simulate runs nothing, so it needs no environment wall and no
    // crew: it is a read. Force is the one that has to be guarded.
    const simulate = mode === 'simulate';
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });

    const agent = await resolveAgentBody({ agentSlug: req.params.slug, mode: 'viewing' });

    const conv = await triggerDispatcher.describeConversation(req.params.slug, Number(conversationId));
    if (!conv) return res.status(404).json({ error: `Conversation ${conversationId} is not on this agent.` });

    const allowed = triggerClock.environmentKinds();
    if (!simulate && allowed && !allowed.includes(conv.kind)) {
      return res.status(400).json({
        error: 'Running outside production can only act on builder-preview conversations. '
          + `This one is "${conv.kind || 'live'}", so nothing was sent.`,
      });
    }

    // Working copies when the builder sent them, saved definitions
    // otherwise — same rule as every other endpoint here.
    const defined = Array.isArray(bodyTriggers)
      ? bodyTriggers
      : (Array.isArray(agent.body?.triggers?.triggers) ? agent.body.triggers.triggers : []);

    const masterOff = agent.body?.triggers?.enabled === false;
    const runnable = defined.filter(t => t && t.enabled !== false && t.typeId && t.run?.crewId);

    const results = [];

    // Say WHY a trigger took no part, rather than quietly leaving it out
    // of the list. "It isn't in the results" and "it is switched off"
    // look identical otherwise, and the second is the answer to the
    // question people actually arrive with.
    for (const t of defined) {
      if (!t || runnable.includes(t)) continue;
      results.push({
        triggerId: t.id,
        name:      t.name,
        outcome:   'skipped',
        why:       t.enabled === false ? 'switched off'
                 : !t.run?.crewId      ? 'no crew picked'
                 : 'no type',
      });
    }
    for (const trigger of runnable) {
      // Ask the clock's question, with the clock's own evaluator.
      let evaluation = null;
      try {
        const check = await triggerEvaluator.checkOne({ trigger, conversationId: Number(conversationId) });
        evaluation = check.evaluation;
      } catch (err) {
        results.push({ triggerId: trigger.id, name: trigger.name, outcome: 'error', why: err.message });
        continue;
      }

      const blocker = evaluation.clauses.find(c => !c.ok);

      // Simulate stops here for EVERY trigger, due or not. Reporting
      // "would run" is the whole answer; running it would make this the
      // other button.
      if (simulate) {
        results.push({
          triggerId: trigger.id,
          name:      trigger.name,
          outcome:   evaluation.ok ? 'would_run' : 'not_due',
          why:       evaluation.ok ? evaluation.reason : (blocker ? blocker.why : 'not due'),
          clauses:   evaluation.clauses,
        });
        continue;
      }

      const fired = await triggerDispatcher.fireOne({
        agentSlug:      req.params.slug,
        agentId:        agent.agentId,
        trigger,
        conversationId: Number(conversationId),
        matchReason:    evaluation.reason,
        overrideAgentBody,
        overrideCrewBody: (overrideCrewBodies && overrideCrewBodies[trigger.run.crewId]) || null,
      });
      // `wouldRun` keeps the two questions apart: forcing tells you what
      // the crew produced, and this still tells you whether the clock
      // would have chosen this conversation on its own.
      results.push({
        triggerId: trigger.id,
        name:      trigger.name,
        ...fired,
        wouldRun:  evaluation.ok,
        notDueWhy: evaluation.ok ? null : (blocker ? blocker.why : 'not due'),
        clauses:   evaluation.clauses,
      });
    }

    res.json({
      conversationId: Number(conversationId),
      // Reported rather than enforced: this button is a deliberate test,
      // and refusing to run because the agent's master switch is off
      // would make it useless for exactly the person setting one up.
      masterOff,
      mode,
      considered: runnable.length,
      skipped:    defined.length - runnable.length,
      // Only 'spoke' means a message reached the person. A chain that
      // ran and produced nothing is 'silent', and is a normal outcome.
      fired:      results.filter(r => r.outcome === 'spoke').length,
      ran:        results.filter(r => r.outcome === 'spoke' || r.outcome === 'silent').length,
      results,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
