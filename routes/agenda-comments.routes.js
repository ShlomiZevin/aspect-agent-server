/**
 * Comments on agenda lines — the meeting's action items
 * (services/agendaComments.service.js). No auth: internal tool.
 *
 *   GET    /api/agenda-comments?taskIds=1004,1005   → { comments }
 *   POST   /api/agenda-comments                     { taskId, index, text, author, body } → 201 { comment, task }
 *   PATCH  /api/agenda-comments/:id                 { author, body } → { comment }
 *   DELETE /api/agenda-comments/:id?author=<name>   → { ok: true }
 *
 * The line is addressed like a tick (index among the topic's `- [ ]` lines
 * AND its text): 409 when it moved or changed meanwhile.
 *
 * Mounted at /api/agenda-comments (one line in server.js).
 */
const express = require('express');
const agendaComments = require('../services/agendaComments.service');

const router = express.Router();

function sendError(res, err, what) {
  const status = err.status || 500;
  if (status === 500) console.error(`[agenda-comments] ${what} failed:`, err.message);
  res.status(status).json({ error: status === 500 ? `Failed to ${what}` : err.message });
}

router.get('/', async (req, res) => {
  const taskIds = String(req.query.taskIds || '')
    .split(',')
    .map(s => parseInt(s, 10))
    .filter(n => Number.isInteger(n));
  try {
    res.json({ comments: await agendaComments.list(taskIds) });
  } catch (err) {
    sendError(res, err, 'load comments');
  }
});

router.post('/', async (req, res) => {
  const { taskId, index, text, author, body } = req.body || {};
  try {
    const result = await agendaComments.add({
      taskId: typeof taskId === 'number' ? taskId : parseInt(taskId, 10),
      index: typeof index === 'number' ? index : parseInt(index, 10),
      text,
      author,
      body,
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err, 'save comment');
  }
});

router.patch('/:id', async (req, res) => {
  const { author, body } = req.body || {};
  try {
    res.json({ comment: await agendaComments.edit(parseInt(req.params.id, 10), { author, body }) });
  } catch (err) {
    sendError(res, err, 'save comment');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await agendaComments.remove(parseInt(req.params.id, 10), { author: req.query.author });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'delete comment');
  }
});

module.exports = router;
