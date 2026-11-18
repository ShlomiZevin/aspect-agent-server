/**
 * Data protection (task #986) — the two calls a chat makes about a block.
 * Mounted at /api/agents (server.js), next to the runtime route.
 *
 *   POST /api/agents/:slug/protection-events
 *        A block that happened IN THE BROWSER (the text never left it):
 *        { surface: 'live'|'builder', detectors: [...], conversationId?, lang? }
 *        → { blockId }. Detector ids only — the route refuses anything that
 *        looks like message text (no `text` / `message` key is read).
 *
 *   POST /api/agents/:slug/protection-events/:id/mistake
 *        The customer's one tap "blocked by mistake" — on a browser block or
 *        on a server block (its id came in the `protection.blocked` event).
 *        Only records; the message is never let through. → { ok, alreadyReported }
 *
 *   GET  /api/agents/:slug/protection-events?days=30
 *        The Admin report (P3) — the same `protectionEvents.report` the MCP
 *        reads.
 *
 * No auth, like the rest of the customer chat calls (proportionate: the
 * rows hold no personal data). The agent and conversation are checked so
 * the report stays clean.
 */

const express = require('express');
const db = require('../../services/db.pg');
const protection = require('../protection');
const protectionEvents = require('../services/protectionEvents');

const router = express.Router();

const CLIENT_SURFACES = new Set(['live', 'builder']);

router.post('/:slug/protection-events', async (req, res) => {
  try {
    const { slug } = req.params;
    const { surface, detectors, conversationId = null, lang = null } = req.body || {};
    if (!CLIENT_SURFACES.has(surface)) {
      return res.status(400).json({ error: 'surface must be "live" or "builder"' });
    }
    const { DETECTOR_IDS } = await protection.load();
    if (!Array.isArray(detectors) || detectors.length === 0
      || detectors.length > DETECTOR_IDS.length
      || !detectors.every(d => DETECTOR_IDS.includes(d))) {
      return res.status(400).json({ error: `detectors must be a non-empty list of: ${DETECTOR_IDS.join(', ')}` });
    }
    const { rows: agents } = await db.query('SELECT 1 FROM builder_agents WHERE slug = $1 LIMIT 1', [slug]);
    if (agents.length === 0) return res.status(404).json({ error: `No agent "${slug}"` });

    let convId = null;
    if (conversationId !== null && conversationId !== undefined) {
      convId = Number(conversationId);
      if (!Number.isInteger(convId) || convId <= 0) return res.status(400).json({ error: 'conversationId must be a number' });
      const { rows } = await db.query(
        `SELECT 1 FROM conversations WHERE id = $1 AND metadata->>'agentSlug' = $2 LIMIT 1`,
        [convId, slug],
      );
      if (rows.length === 0) return res.status(404).json({ error: `Conversation ${convId} is not a conversation of "${slug}"` });
    }

    const blockId = await protectionEvents.record({
      agentSlug: slug,
      conversationId: convId,
      side: 'client',
      surface,
      detectors: [...new Set(detectors)],
      lang,
    });
    res.json({ blockId });
  } catch (err) {
    console.error('[protection] record client block failed:', err.message);
    res.status(500).json({ error: 'Could not record the block' });
  }
});

/**
 * GET /api/agents/:slug/protection-events?days=30 — the Admin report
 * (task #986 P3): totals, browser vs server, per surface, per detector with
 * its mistake rate, and the latest blocks. Detector ids only, never text.
 */
router.get('/:slug/protection-events', async (req, res) => {
  try {
    const report = await protectionEvents.report({ agentSlug: req.params.slug, days: req.query.days, recentLimit: 200 });
    res.json(report);
  } catch (err) {
    console.error('[protection] report failed:', err.message);
    res.status(500).json({ error: 'Could not read the blocks' });
  }
});

router.post('/:slug/protection-events/:id/mistake', async (req, res) => {
  try {
    const result = await protectionEvents.reportMistake({ agentSlug: req.params.slug, id: req.params.id });
    if (!result) return res.status(404).json({ error: 'No such block on this agent' });
    res.json({ ok: true, alreadyReported: result.alreadyReported });
  } catch (err) {
    console.error('[protection] mistake report failed:', err.message);
    res.status(500).json({ error: 'Could not record the report' });
  }
});

module.exports = router;
