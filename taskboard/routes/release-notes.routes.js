/**
 * The customer side of release notes (task #102), read by the Intelligence
 * Center's "what's new" popup.
 *
 *   GET  /api/release-notes?userId=   notes published since this user's last "got it"
 *   POST /api/release-notes/seen      { userId, until } -- move the watermark
 *
 * Its own router, outside /api/taskboard, on purpose: this is what customers'
 * browsers call, and it returns only the note itself (headline, body, publish
 * time) -- never anything else from the task. See release-notes.service.js.
 */
const express = require('express');
const releaseNotesService = require('../services/release-notes.service');

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
      console.error(`[release-notes] ${req.method} ${req.originalUrl}:`, err);
      res.status(500).json({ error: 'Release notes request failed' });
    }
  };
}

router.get('/', handle(async (req, res) => {
  res.json({ notes: await releaseNotesService.unseen(req.query.userId) });
}));

router.post('/seen', handle(async (req, res) => {
  await releaseNotesService.markSeen(req.body?.userId, req.body?.until);
  res.json({ success: true });
}));

module.exports = router;
