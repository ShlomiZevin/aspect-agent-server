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

module.exports = router;
