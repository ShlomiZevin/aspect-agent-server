/**
 * Otto's HTTP surface — the screen builder.
 *
 *   POST   /api/otto/chat            one brainstorm turn
 *   POST   /api/otto/plan            consolidate the conversation into a plan
 *   POST   /api/otto/build           build (or revise) the screen from an approved plan
 *   POST   /api/otto/build/stream    the same build, reporting progress as it writes
 *   GET    /api/otto/data            the demo dataset the built screen runs on
 *   GET    /api/otto/apps/:datasetId       saved screens, summaries only
 *   GET    /api/otto/apps/:datasetId/:id   one saved screen, with its HTML
 *   POST   /api/otto/apps/:datasetId       save (or replace) a screen
 *   DELETE /api/otto/apps/:datasetId/:id   delete one
 *
 * THE CONVERSATION IS NOT STREAMED, THE BUILD IS. Otto's turns are two to four
 * lines — a stream buys nothing there. The build is a minute of silence, and
 * silence is where a user decides the thing has hung. /build/stream reports
 * the phase Otto has actually reached, read off the HTML as it arrives; the
 * plain /build stays as the fallback for a client that cannot read a stream.
 */
const express = require('express');

const fs = require('fs');
const path = require('path');

const otto = require('../services/otto.service');
const store = require('../services/otto-apps.store');
const { demoData, SCHEMA } = require('../data/demo-dataset');

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`[otto] ${req.method} ${req.originalUrl}:`, err);
      res.status(500).json({ error: err.message || 'הבקשה נכשלה' });
    }
  };
}

/** Both conversational endpoints take the same transcript, so validate it once. */
function readMessages(req) {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages || messages.length === 0) {
    const err = new Error('חסרה שיחה');
    err.status = 400;
    throw err;
  }
  return messages
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content.trim() }))
    .slice(-24); // enough context to stay coherent, short enough to stay cheap
}

router.post('/chat', handle(async (req, res) => {
  // `currentPlan` is what turns this from "design a screen" into "change the
  // screen you already have". The client sends it once a build exists.
  res.json(await otto.brainstorm({ messages: readMessages(req), currentPlan: req.body?.currentPlan || null }));
}));

router.post('/plan', handle(async (req, res) => {
  res.json({ plan: await otto.plan({ messages: readMessages(req), currentPlan: req.body?.currentPlan || null }) });
}));

router.post('/build', handle(async (req, res) => {
  const { plan, previousHtml } = req.body || {};
  if (!plan || !plan.title || !Array.isArray(plan.parts)) {
    return res.status(400).json({ error: 'חסרה תוכנית מאושרת' });
  }
  // The rows travel back WITH the screen. They used to come from a separate
  // GET /data fired once on mount, which meant a single failed request left
  // the preview permanently blank while the build itself succeeded — a silent
  // failure with nothing on screen to explain it. The builder already has the
  // data in hand; sending it is free and removes the dependency entirely.
  const { html, data } = await otto.build({ plan, previousHtml: previousHtml || null });
  res.json({ html, data, model: otto.BUILD_MODEL });
}));

/**
 * Progress as Server-Sent Events over POST — so the request can carry a plan
 * and a previous screen, which EventSource cannot do. Every event is one line
 * of JSON: {type:'progress'|'done'|'error', ...}.
 */
router.post('/build/stream', handle(async (req, res) => {
  const { plan, previousHtml } = req.body || {};
  if (!plan || !plan.title || !Array.isArray(plan.parts)) {
    return res.status(400).json({ error: 'חסרה תוכנית מאושרת' });
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Cloud Run and nginx will otherwise sit on the response until it ends,
    // which turns a stream back into the one long silent call it replaced.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}

`);

  // The client going away mid-build is normal (a reload, a closed tab). Stop
  // writing rather than letting the generator run on into a dead socket.
  //
  // WATCH THE RESPONSE, NOT THE REQUEST. `req` emits 'close' as soon as its
  // body has been read — which bodyParser already did before this handler ran —
  // so a req-based guard is true from the first line and silently suppresses
  // every write, leaving the client hanging on an empty 200 forever.
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    for await (const event of otto.buildStream({ plan, previousHtml: previousHtml || null })) {
      if (aborted) return;
      send(event.type === 'done' ? { ...event, model: otto.BUILD_MODEL } : event);
    }
  } catch (err) {
    console.error('[otto] build stream failed:', err);
    if (!aborted) send({ type: 'error', error: err.message || 'הבנייה נכשלה' });
  } finally {
    if (!aborted) res.end();
  }
}));

// The built screen runs on this. Served separately so the HTML the model wrote
// stays free of a 4,000-row literal — it references DATA, the page injects it.
router.get('/data', handle(async (_req, res) => {
  res.json({ schema: SCHEMA, data: demoData() });
}));

/**
 * The stylesheet every generated app inherits.
 *
 * Read from disk per request rather than bundled into the page: it is 700
 * lines, it belongs to the design system rather than to React, and serving it
 * means an app saved today picks up a theme fix tomorrow without being rebuilt.
 * Cached for an hour — it changes about as often as the brand does.
 */
const THEME_PATH = path.join(__dirname, '..', 'data', 'app-theme.css');
router.get('/theme.css', handle(async (_req, res) => {
  res.type('text/css').set('Cache-Control', 'public, max-age=3600');
  res.send(fs.readFileSync(THEME_PATH, 'utf8'));
}));

// --- saved screens ----------------------------------------------------------

router.get('/apps/:datasetId', handle(async (req, res) => {
  res.json({ apps: await store.list(req.params.datasetId) });
}));

router.get('/apps/:datasetId/:id', handle(async (req, res) => {
  const app = await store.get(req.params.datasetId, req.params.id);
  if (!app) return res.status(404).json({ error: 'המסך לא נמצא' });
  res.json({ app });
}));

router.post('/apps/:datasetId', handle(async (req, res) => {
  const { id, title, summary, icon, plan, html, createdBy } = req.body || {};
  if (!title || !html) return res.status(400).json({ error: 'חסרים שם המסך או תוכן' });
  res.json({ app: await store.save(req.params.datasetId, { id, title, summary, icon, plan, html, createdBy }) });
}));

router.delete('/apps/:datasetId/:id', handle(async (req, res) => {
  const ok = await store.remove(req.params.datasetId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'המסך לא נמצא' });
  res.json({ deleted: true });
}));

module.exports = router;
