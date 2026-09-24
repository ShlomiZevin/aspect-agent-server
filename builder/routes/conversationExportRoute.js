/**
 * Builder V2 — conversation export route (task #861).
 *
 *   GET /api/agents/:slug/conversations/:convId/export?include=messages|outputs|full
 *       → JSON (see builder/services/conversationExport.js for the shape)
 *
 * Mounted on `/api/agents` next to runtimeRoute. The path doesn't collide
 * with any runtime path (runtime has no GET …/:convId/export).
 */

const express = require('express');
const { exportConversation } = require('../services/conversationExport');

const router = express.Router();

router.get('/:slug/conversations/:convId/export', async (req, res) => {
  try {
    const data = await exportConversation({
      conversationId: req.params.convId,
      include: req.query.include,
      agentSlug: req.params.slug,
    });
    if (!data) return res.status(404).json({ error: 'Conversation not found for this agent' });
    res.json(data);
  } catch (err) {
    console.error('[builder] GET conversation export failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
