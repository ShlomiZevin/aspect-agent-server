/**
 * HQ — reports. Mounted at /api/hq/reports.
 *
 * `/view` returns a full HTML page rather than JSON: the whole point is a link
 * you can open, send to someone, or put on a screen in a meeting.
 */

const express = require('express');
const router = express.Router();
const reports = require('../services/reports.service');

router.get('/', async (req, res) => {
  try {
    res.json({
      reports: await reports.list({
        conversationId: req.query.conversationId ? parseInt(req.query.conversationId, 10) : null,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/view', async (req, res) => {
  try {
    const report = await reports.get(parseInt(req.params.id, 10));
    if (!report) return res.status(404).send('No such report');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(await reports.render(report));
  } catch (err) {
    console.error('[hq/reports]', err.message);
    res.status(500).send('Could not render this report');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const report = await reports.get(parseInt(req.params.id, 10));
    if (!report) return res.status(404).json({ error: 'No such report' });
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
