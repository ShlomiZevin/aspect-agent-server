/**
 * Error center — the API behind Admin → Errors (task #903).
 *
 *   GET /api/errors?agentSlug=<slug>[&kind=&area=&source=&sort=recent|frequent]
 *       the agent's error groups (last month)
 *   GET /api/errors/occurrences?agentSlug=<slug>&fingerprint=<fp>
 *       every time one group happened, newest first
 *   GET /api/errors/summary?agentSlug=<slug>
 *       per-status counts, customer conversations hit (24 h), errors per day (14 days)
 *   GET /api/errors/count?agentSlug=<slug>
 *       how many groups are new (incl. reopened) — the Admin menu count
 *   PUT /api/errors/status
 *       { agentSlug, fingerprint, status: new|looking|handled|ignored, note?, by? }
 *   PUT /api/errors/note
 *       { agentSlug, fingerprint, note, by? } — the note only; the status stays
 *
 * Errors are written by builder/services/errorCenter.js from the hooks on
 * the conversation path; people only set a group's status and note here.
 */

const express = require('express');
const errorCenter = require('../services/errorCenter');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { agentSlug, kind, area, source, status, sort, limit } = req.query;
    if (!agentSlug) return res.status(400).json({ error: 'Missing agentSlug' });
    res.json({ groups: await errorCenter.listGroups({ slug: String(agentSlug), kind, area, source, status, sort, limit }) });
  } catch (err) {
    console.error('[errors] list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/occurrences', async (req, res) => {
  try {
    const { agentSlug, fingerprint, limit } = req.query;
    if (!agentSlug || !fingerprint) return res.status(400).json({ error: 'Missing agentSlug or fingerprint' });
    const [occurrences, perDay] = await Promise.all([
      errorCenter.listOccurrences({ slug: String(agentSlug), fingerprint, limit }),
      errorCenter.groupPerDay({ slug: String(agentSlug), fingerprint }),
    ]);
    res.json({ occurrences, perDay });
  } catch (err) {
    console.error('[errors] occurrences failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const { agentSlug } = req.query;
    if (!agentSlug) return res.status(400).json({ error: 'Missing agentSlug' });
    res.json(await errorCenter.summary({ slug: String(agentSlug) }));
  } catch (err) {
    console.error('[errors] summary failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/count', async (req, res) => {
  try {
    const { agentSlug } = req.query;
    if (!agentSlug) return res.status(400).json({ error: 'Missing agentSlug' });
    res.json({ new: await errorCenter.countNew({ slug: String(agentSlug) }) });
  } catch (err) {
    console.error('[errors] count failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/status', async (req, res) => {
  try {
    const { agentSlug, fingerprint, status, note, by } = req.body || {};
    if (!agentSlug || !fingerprint) return res.status(400).json({ error: 'Missing agentSlug or fingerprint' });
    res.json(await errorCenter.setGroupStatus({ slug: String(agentSlug), fingerprint, status, note, by }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[errors] status failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/note', async (req, res) => {
  try {
    const { agentSlug, fingerprint, note, by } = req.body || {};
    if (!agentSlug || !fingerprint) return res.status(400).json({ error: 'Missing agentSlug or fingerprint' });
    res.json(await errorCenter.setGroupNote({ slug: String(agentSlug), fingerprint, note, by }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[errors] note failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
