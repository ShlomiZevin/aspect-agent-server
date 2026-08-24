/**
 * HQ — employees. Mounted at /api/hq/workers.
 *
 * The chat endpoint streams SSE so you can watch the worker think, call tools
 * and tick off its plan. The work itself does not belong to that stream: jobs
 * and media are written as they happen, so a dropped connection costs you the
 * live view and nothing else.
 */

const express = require('express');
const router = express.Router();

const workers = require('../services/workers.service');
const media = require('../services/media.service');
const leonardo = require('../services/leonardo.service');
const reports = require('../services/reports.service');
const phrasing = require('../services/phrasing.service');
const render = require('../services/render.service');

function fail(res, err, status = null) {
  console.error('[hq/workers]', err.message);
  if (!res.headersSent) res.status(status || err.status || 500).json({ error: err.message });
}

function openStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  return (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client left */ } };
}

// ─── Roster ──────────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    const roster = await workers.list();
    res.json({
      workers: await Promise.all(roster.map(async w => ({
        ...w, spend: await workers.spend(w.id, w.slug).catch(() => null),
      }))),
      capabilities: {
        images: leonardo.isConfigured(),
        htmlRender: render.isAvailable(),
        imageModels: leonardo.OFFERED.map(k => ({ ...leonardo.MODELS[k], id: k })),
        phrasingModels: phrasing.PHRASING_MODELS,
      },
    });
  } catch (err) { fail(res, err); }
});

router.get('/:slug', async (req, res) => {
  try {
    const worker = await workers.get(req.params.slug);
    if (!worker) return res.status(404).json({ error: 'No such employee' });
    res.json({
      worker,
      conversations: await workers.conversations(worker.id),
      spend: await workers.spend(worker.id, worker.slug).catch(() => null),
    });
  } catch (err) { fail(res, err); }
});

/** The employment definition is editable by anyone — that is the point. */
router.patch('/:slug', async (req, res) => {
  try {
    // Same guard as the per-conversation route: an unreviewed picture model must
    // not reach a worker through either door.
    const wanted = req.body?.imageModel;
    if (wanted && !leonardo.OFFERED.includes(wanted)) {
      return res.status(400).json({ error: `${wanted} is not a picture model we offer` });
    }
    const worker = await workers.update(req.params.slug, req.body || {});
    if (!worker) return res.status(404).json({ error: 'No such employee' });
    res.json({ worker });
  } catch (err) { fail(res, err); }
});

// ─── What she has learned ────────────────────────────────────────────────────
//
// Editable by anyone, exactly like the job description — these silently shape
// every answer, so they must not be something only the database knows.

router.get('/:slug/lessons', async (req, res) => {
  try {
    const worker = await workers.get(req.params.slug);
    if (!worker) return res.status(404).json({ error: 'No such employee' });
    res.json({ lessons: await workers.allLessons(worker.id) });
  } catch (err) { fail(res, err); }
});

router.post('/:slug/lessons', async (req, res) => {
  try {
    const worker = await workers.get(req.params.slug);
    if (!worker) return res.status(404).json({ error: 'No such employee' });
    const text = (req.body?.lesson || '').trim();
    if (!text) return res.status(400).json({ error: 'A lesson needs some text' });
    res.json({ lesson: await workers.addLesson(worker.id, text) });
  } catch (err) { fail(res, err); }
});

router.patch('/lessons/:id', async (req, res) => {
  try {
    const lesson = await workers.updateLesson(parseInt(req.params.id, 10), req.body || {});
    if (!lesson) return res.status(400).json({ error: 'Nothing to change' });
    res.json({ lesson });
  } catch (err) { fail(res, err); }
});

router.delete('/lessons/:id', async (req, res) => {
  try {
    await workers.removeLesson(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// ─── Conversations ───────────────────────────────────────────────────────────

router.post('/:slug/conversations', async (req, res) => {
  try {
    const worker = await workers.get(req.params.slug);
    if (!worker) return res.status(404).json({ error: 'No such employee' });
    res.json({ conversation: await workers.createConversation(worker.id, req.body?.title) });
  } catch (err) { fail(res, err); }
});

router.get('/:slug/conversations/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Everything a conversation produced, so the client can group each job
    // with the images and reports that came out of it.
    res.json({
      conversation: await workers.conversation(id),
      messages: await workers.messages(id),
      jobs: await workers.jobs({ conversationId: id }),
      media: await media.list({ conversationId: id }),
      reports: await reports.list({ conversationId: id }),
    });
  } catch (err) { fail(res, err); }
});

/**
 * Settings that belong to one conversation rather than to the employee.
 * Right now that is which model draws the pictures — see the migration for why
 * it lives here and not on the worker.
 */
router.patch('/:slug/conversations/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { model, phrasingModel, imageModel } = req.body || {};

    // A picture model is a short opinionated list; validate against it. The
    // brain and voice come from the platform registry, which is the authority.
    if (imageModel && imageModel !== 'auto' && !leonardo.OFFERED.includes(imageModel)) {
      return res.status(400).json({ error: `${imageModel} is not a picture model we offer` });
    }

    const patch = {};
    if ('model' in (req.body || {})) patch.model = model;
    if ('phrasingModel' in (req.body || {})) patch.phrasingModel = phrasingModel;
    if ('imageModel' in (req.body || {})) patch.imageModel = imageModel;

    res.json({ conversation: await workers.setConversationModels(id, patch) });
  } catch (err) { fail(res, err); }
});

// ─── Talking ─────────────────────────────────────────────────────────────────

router.post('/:slug/conversations/:id/message', async (req, res) => {
  const send = openStream(res);
  try {
    const worker = await workers.get(req.params.slug);
    if (!worker) { send('error', { error: 'No such employee' }); return res.end(); }

    const conversationId = parseInt(req.params.id, 10);
    const message = (req.body?.message || '').trim();
    if (!message) { send('error', { error: 'Say something' }); return res.end(); }

    const result = await workers.send({
      worker, conversationId, message,
      onEvent: (e) => {
        if (e.type === 'job_started') workers.registerActive(e.job.id);
        send('event', e);
      },
    });

    if (result.jobId) workers.clearActive(result.jobId);
    send('done', {
      ...result,
      media: await media.list({ conversationId }),
      jobs: await workers.jobs({ conversationId }),
      reports: await reports.list({ conversationId }),
    });
  } catch (err) {
    console.error('[hq/workers] message failed:', err.message);
    send('error', { error: err.message });
  } finally { res.end(); }
});

// ─── Jobs ────────────────────────────────────────────────────────────────────

router.get('/:slug/jobs', async (req, res) => {
  try {
    const worker = await workers.get(req.params.slug);
    if (!worker) return res.status(404).json({ error: 'No such employee' });
    res.json({ jobs: await workers.jobs({ workerId: worker.id }) });
  } catch (err) { fail(res, err); }
});

router.post('/jobs/:id/cancel', async (req, res) => {
  try {
    res.json({ ok: true, stopping: workers.cancelJob(req.params.id) });
  } catch (err) { fail(res, err); }
});

module.exports = router;
