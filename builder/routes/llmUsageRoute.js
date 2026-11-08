/**
 * LLM usage — the API behind Builder Admin → LLM Usage (task #953).
 *
 *   GET /api/llm-usage?agentSlug=<slug>[&period=today|7d|30d|90d|all|YYYY-MM-DD]
 *        [&crew=<name>&addon=<instanceId|process:<p>>&model=<id>]
 *        [&view=runs|conversations&offset=&limit=]
 *       summary (the four cards), filter options, days with calls, and
 *       either a page of calls (runs, newest first, limit ≤ 500) or the
 *       calls grouped by conversation (unlinked calls last, id null).
 *   GET /api/llm-usage/conversation?agentSlug=<slug>&id=<conversationId|unlinked>
 *        [&period&crew&addon&model]
 *       that conversation's calls, split by interaction.
 *
 * Read-only. The join of llm_usage (every model call) with addon_runs (which
 * add-on, which interaction) lives in builder/services/llmUsageReport.js.
 */

const express = require('express');
const usage = require('../services/llmUsageReport');

const router = express.Router();

const filtersOf = q => ({
  period: q.period,
  crew: q.crew != null && q.crew !== '' ? String(q.crew) : undefined,
  addon: q.addon ? String(q.addon) : undefined,
  model: q.model ? String(q.model) : undefined,
});

router.get('/', async (req, res) => {
  try {
    const { agentSlug, view, offset, limit } = req.query;
    if (!agentSlug) return res.status(400).json({ error: 'Missing agentSlug' });
    const out = await usage.report({
      agentSlug: String(agentSlug),
      ...filtersOf(req.query),
      view: view === 'conversations' ? 'conversations' : 'runs',
      offset,
      limit,
    });
    if (!out) return res.status(404).json({ error: `No agent with slug "${agentSlug}"` });
    res.json(out);
  } catch (err) {
    console.error('[llm-usage] report failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversation', async (req, res) => {
  try {
    const { agentSlug, id } = req.query;
    if (!agentSlug || !id) return res.status(400).json({ error: 'Missing agentSlug or id' });
    const out = await usage.conversationDetail({
      agentSlug: String(agentSlug),
      conversation: String(id),
      ...filtersOf(req.query),
    });
    if (!out) return res.status(404).json({ error: `No agent with slug "${agentSlug}"` });
    res.json(out);
  } catch (err) {
    console.error('[llm-usage] conversation failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
