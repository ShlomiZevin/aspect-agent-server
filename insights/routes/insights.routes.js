/**
 * Aspect Intelligence API — mounted at /api/insights (see server.js).
 *
 * A standalone product, separate from /api/bi: proactive "Aspect investigates
 * your data" findings, rather than user-driven ad-hoc queries. All insight
 * and tracked-metric content is real — no illustrative/seed content. Every
 * dataset registered in ../datasets/registry.js and enabled via
 * ../services/intelligence-config.service.js (see the admin panel) is served
 * generically here; insights themselves come from
 * insights/services/investigation.service.js (a real plan -> query ->
 * synthesize LLM/DB pipeline).
 *
 * "Tracked by you" is genuinely user-curated, not a separately
 * auto-computed metric set: it's whichever generated insights have been
 * marked `tracked` via their own "Track" button, condensed into strip cards
 * (see investigationService.listTracked/setTracked) — there is no other
 * source for it.
 *
 * Endpoints:
 *   GET  /api/insights                                — list enabled datasets (auto-discovered from the registry + config)
 *   GET  /api/insights/:datasetId/insights             — real generated insight summaries (fast, in-memory)
 *   GET  /api/insights/:datasetId/tracked              — the subset of insights marked "tracked", as strip cards
 *   POST /api/insights/:datasetId/tracked/reorder       — { insightIds: string[] } -> persists "Manage tracking" drag-to-reorder
 *   GET  /api/insights/:datasetId/:insightId           — full insight detail (generated only)
 *   POST /api/insights/:datasetId/classify-prompt      — { prompt } -> { isSimpleQuery } — is this a quick lookup or a real investigation?
 *   POST /api/insights/:datasetId/investigate          — { prompt? } -> runs a real investigation, returns its result (no prompt = Aspect picks the angle itself)
 *   POST /api/insights/:datasetId/bootstrap            — runs a curated set of real investigations to populate an empty feed
 *   POST /api/insights/:datasetId/:insightId/track     — { tracked: boolean } -> toggles "Tracked by you" membership
 *   POST /api/insights/:datasetId/:insightId/plan      — generates (or returns cached) the "Open <cta> plan" action plan
 *   DELETE /api/insights/:datasetId/:insightId         — removes a generated insight
 *
 * `insights` and `tracked` are separate endpoints (not one combined
 * response) so the client can render/load each independently.
 */

const express = require('express');
const router = express.Router();
const investigationService = require('../services/investigation.service');
const registry = require('../datasets/registry');
const intelligenceConfigService = require('../services/intelligence-config.service');

function toSummary(insight) {
  const { id, category, categoryLabel, tag, confidence, confidenceLabel, foundAgo, headline,
    impactValue, impactLabel, impactDirection, ctaLabel, chart, isGenerated, tracked,
    createdAt, origin, viewed, evidence } = insight;
  return {
    id, category, categoryLabel, tag, confidence, confidenceLabel, foundAgo, headline,
    impactValue, impactLabel, impactDirection, ctaLabel, isGenerated, tracked,
    // My Reports (11a) / Report history (12a) fields — see
    // investigation.service.js's migrateLegacyBlocks for defaults on older
    // records. askedPrompt is what the user actually typed (or, for an
    // Aspect-proposed report, what Aspect chose to investigate).
    createdAt, origin, viewed, askedPrompt: evidence?.prompt || headline,
    chartPreview: { categories: chart.categories, series: chart.series.map(s => ({ key: s.key, points: s.points, color: s.color, dashed: !!s.dashed })) },
  };
}

/**
 * Every report/tracked-metric endpoint below is scoped to the anonymous
 * browser session that owns it (see investigation.service.js's storeKey) —
 * same identity (users.externalId) the chat's own conversations already use,
 * so "your reports" and "your chats" are the same session. Throws a
 * 400-shaped error rather than silently falling back to a shared bucket,
 * which would leak one user's reports into another's view.
 */
function requireUserId(value) {
  if (!value || typeof value !== 'string') {
    const err = new Error('A userId is required');
    err.status = 400;
    throw err;
  }
  return value;
}

/** Throws a 404-shaped error unless the dataset exists and is enabled. */
async function requireEnabled(datasetId) {
  if (!registry.get(datasetId)) {
    const err = new Error(`Unknown dataset: ${datasetId}`);
    err.status = 404;
    throw err;
  }
  const config = await intelligenceConfigService.getConfig(datasetId);
  if (!config.enabled) {
    const err = new Error(`Aspect Intelligence is not enabled for dataset: ${datasetId}`);
    err.status = 404;
    throw err;
  }
}

function handleError(res, err, context) {
  const status = err.status || 500;
  if (status >= 500) console.error(`❌ Insights ${context}:`, err.message);
  res.status(status).json({ error: err.message });
}

// Generic — auto-discovers every dataset registered in ../datasets/registry.js
// that's currently enabled (see ../services/intelligence-config.service.js).
// Adding a new dataset to the registry + enabling it in the admin panel is
// the only step needed for it to appear here.
router.get('/', async (_req, res) => {
  try {
    const configs = await intelligenceConfigService.getAllConfigs();
    const datasets = configs
      .filter(c => c.enabled)
      .map(c => ({ id: c.id, ...registry.get(c.id).defaultMeta }));
    res.json({ datasets });
  } catch (err) {
    handleError(res, err, 'list datasets');
  }
});

// Registered before the generic /:datasetId/:insightId route below so
// "insights" and "tracked" are matched as static segments, not an insightId.
router.get('/:datasetId/insights', async (req, res) => {
  try {
    await requireEnabled(req.params.datasetId);
    const userId = requireUserId(req.query.userId);
    const insights = investigationService.listGenerated(req.params.datasetId, userId).map(toSummary);
    res.json({ insights });
  } catch (err) {
    handleError(res, err, 'list');
  }
});

router.get('/:datasetId/tracked', async (req, res) => {
  try {
    await requireEnabled(req.params.datasetId);
    const userId = requireUserId(req.query.userId);
    const tracked = investigationService.listTracked(req.params.datasetId, userId);
    res.json({ tracked });
  } catch (err) {
    handleError(res, err, 'tracked');
  }
});

// "Manage tracking" drag-to-reorder — { insightIds: string[] } is the
// complete new order, sent by the client that's already rendering the
// draggable list. Registered before /:datasetId/:insightId below so
// "tracked" is matched as a static segment, not an insightId.
router.post('/:datasetId/tracked/reorder', async (req, res) => {
  try {
    await requireEnabled(req.params.datasetId);
    const userId = requireUserId(req.body?.userId);
    const insightIds = Array.isArray(req.body?.insightIds) ? req.body.insightIds : [];
    const tracked = investigationService.reorderTracked(req.params.datasetId, userId, insightIds);
    res.json({ tracked });
  } catch (err) {
    handleError(res, err, 'reorder tracked');
  }
});

router.get('/:datasetId/:insightId', async (req, res) => {
  try {
    await requireEnabled(req.params.datasetId);
    const userId = requireUserId(req.query.userId);
    const detail = investigationService.getGeneratedById(req.params.datasetId, userId, req.params.insightId);
    if (!detail) return res.status(404).json({ error: `Unknown insight: ${req.params.insightId}` });
    // Opening the detail page IS "viewing" it — drives the History page's
    // "Ready — not viewed yet" highlight (design turn 12a). Fired after the
    // response is built from the still-unviewed `detail` object on purpose,
    // so this page load itself still shows whatever state it was in when
    // the click happened.
    investigationService.markViewed(req.params.datasetId, userId, req.params.insightId);
    res.json(detail);
  } catch (err) {
    handleError(res, err, 'detail');
  }
});

// Toggles whether this insight shows up in "Tracked by you" — the ONLY way
// anything lands in that strip, see file header comment.
router.post('/:datasetId/:insightId/track', (req, res) => {
  try {
    const userId = requireUserId(req.body?.userId);
    const tracked = !!(req.body && req.body.tracked);
    const insight = investigationService.setTracked(req.params.datasetId, userId, req.params.insightId, tracked);
    if (!insight) return res.status(404).json({ error: `Unknown insight: ${req.params.insightId}` });
    res.json({ id: insight.id, tracked: insight.tracked });
  } catch (err) {
    handleError(res, err, 'track');
  }
});

// "Open <cta> plan" on the detail page — generates (or returns the cached)
// concrete action plan for this insight. No new query: grounded only in the
// insight's own already-computed fields (see generateActionPlan).
router.post('/:datasetId/:insightId/plan', async (req, res) => {
  try {
    await requireEnabled(req.params.datasetId);
    const userId = requireUserId(req.body?.userId);
    const plan = await investigationService.generateActionPlan(req.params.datasetId, userId, req.params.insightId);
    if (!plan) return res.status(404).json({ error: `Unknown insight: ${req.params.insightId}` });
    res.json(plan);
  } catch (err) {
    handleError(res, err, 'plan');
  }
});

// Only ever removes a generated insight — there is no other kind anymore.
router.delete('/:datasetId/:insightId', (req, res) => {
  try {
    const userId = requireUserId(req.query.userId);
    const removed = investigationService.deleteGenerated(req.params.datasetId, userId, req.params.insightId);
    if (!removed) return res.status(404).json({ error: `No generated insight: ${req.params.insightId}` });
    res.json({ deleted: true });
  } catch (err) {
    handleError(res, err, 'delete');
  }
});

// Runs a real plan -> query -> synthesize investigation (see
// insights/services/investigation.service.js) against the actual database.
// `prompt` is optional — an empty/omitted prompt means "Request a new
// insight" (no text typed): the service itself picks a fresh, uncovered
// angle (see proposeInvestigationPrompt). No canned fallback either way — a
// failure is a real failure, returned as an error so the UI shows its
// existing error/restart state (JobBadge) rather than a fabricated success.
router.post('/:datasetId/investigate', async (req, res) => {
  const prompt = ((req.body && req.body.prompt) || '').trim();

  try {
    await requireEnabled(req.params.datasetId);
    const userId = requireUserId(req.body?.userId);
    const insight = await investigationService.investigate(req.params.datasetId, userId, prompt);
    res.json({
      prompt: insight.evidence.prompt, // the actual prompt used — may be the auto-proposed one
      status: 'ready',
      resultLabel: insight.title,
      findingsCount: 1,
      combinedImpactLabel: insight.impactValue,
      insightIds: [insight.id],
    });
  } catch (err) {
    handleError(res, err, 'investigate');
  }
});

// "Gentle helper" (design turn 4c) — before actually starting an
// investigation, the client checks whether the typed prompt is really just a
// quick lookup Data Chat could answer instantly. One short LLM call, no SQL.
router.post('/:datasetId/classify-prompt', async (req, res) => {
  const prompt = ((req.body && req.body.prompt) || '').trim();
  if (!prompt) return res.status(400).json({ error: 'A prompt is required' });
  try {
    await requireEnabled(req.params.datasetId);
    const isSimpleQuery = await investigationService.classifyPrompt(prompt);
    res.json({ isSimpleQuery });
  } catch (err) {
    handleError(res, err, 'classify-prompt');
  }
});

// Populates the feed with a curated set of real investigations — for an
// empty feed (fresh dataset, or right after a restart before the JSON
// persistence file exists) rather than shipping fake placeholder content.
router.post('/:datasetId/bootstrap', async (req, res) => {
  try {
    await requireEnabled(req.params.datasetId);
    const insights = await investigationService.bootstrap(req.params.datasetId);
    res.json({ created: insights.length, insightIds: insights.map(i => i.id) });
  } catch (err) {
    handleError(res, err, 'bootstrap');
  }
});

module.exports = router;
