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
 *   POST /api/errors/client-drop
 *       { agentSlug, conversationId, userMessageId?, browserError? } — the customer
 *       chat lost a reply stream (#978); the one write that comes from a browser
 *
 * Errors are written by builder/services/errorCenter.js from the hooks on
 * the conversation path; people only set a group's status and note here.
 */

const express = require('express');
const errorCenter = require('../services/errorCenter');
const db = require('../../services/db.pg');

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

/**
 * POST /api/errors/client-drop  (#978)
 *   { agentSlug, conversationId, userMessageId?, browserError? }
 *
 * The customer chat lost a turn's reply stream (a phone switching WiFi ↔
 * mobile data). The server never notices — the turn runs on and saves the
 * reply — so the chat reports it, once per drop. Kept as one Error Center
 * row (area 'turn', kind 'connection_lost'), linked to the turn's reply row
 * (the first assistant message after the customer's), so Admin → Errors and
 * the management center's customer problems show it — answered or not.
 */
router.post('/client-drop', async (req, res) => {
  try {
    const { agentSlug, conversationId, userMessageId = null, browserError = null } = req.body || {};
    const convId = Number(conversationId);
    if (!agentSlug || !Number.isInteger(convId) || convId <= 0) return res.status(400).json({ error: 'Missing agentSlug or conversationId' });
    const userMsgId = Number.isInteger(Number(userMessageId)) && Number(userMessageId) > 0 ? Number(userMessageId) : null;
    const { rows } = await db.query(
      `SELECT c.id,
              (SELECT m.id FROM messages m
                WHERE m.conversation_id = c.id AND m.role = 'assistant' AND $2::int IS NOT NULL AND m.id > $2::int
                ORDER BY m.id LIMIT 1) AS reply_id
         FROM conversations c WHERE c.id = $1 LIMIT 1`,
      [convId, userMsgId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Conversation not found' });
    errorCenter.record(new Error("The customer's connection dropped while the reply was on its way"), {
      area: 'turn', kind: 'connection_lost', code: 'client_stream_dropped',
      agentSlug: String(agentSlug), conversationId: convId, messageId: rows[0].reply_id || null,
      detail: {
        ...(userMsgId ? { userMessageId: userMsgId } : {}),
        ...(browserError ? { browserError: String(browserError).slice(0, 200) } : {}),
      },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[errors] client-drop failed:', err);
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
