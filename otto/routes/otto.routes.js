/**
 * Otto's HTTP surface — v2, the Intelligence-integrated screen builder.
 *
 * Every route is scoped by dataset and sits behind the Otto gate (module
 * `otto` live for that dataset). The old v1 surface — /chat, /plan, /build,
 * /build/stream, /data, /theme.css, /apps/* on the demo dataset with no
 * auth — is gone with the generated-HTML architecture it served. See
 * docs/features/otto.md and tasks/done/otto-intelligence-integration.md.
 *
 *   GET    /:datasetId/screens                 shelf payload (summaries)
 *   POST   /:datasetId/screens                 create a draft
 *   GET    /:datasetId/screens/:id             full record for the builder
 *   PATCH  /:datasetId/screens/:id             title/icon/publish
 *   DELETE /:datasetId/screens/:id             hard-delete a draft
 *   POST   /:datasetId/screens/:id/chat        one brainstorm turn (persists transcript)
 *   POST   /:datasetId/screens/:id/plan        draft / revise the structured plan
 *   POST   /:datasetId/screens/:id/build       start the build job → {buildId}
 *   GET    /:datasetId/screens/:id/build/latest    polled progress
 *   GET    /:datasetId/builds/running          all running builds (the nav pill)
 *   GET    /:datasetId/screens/:id/data        executed result sets (cached)
 *   GET/PUT /:datasetId/store/:moduleId/:collection[/:docId]   the doc store
 */

const express = require('express');

const { requireOttoLive } = require('../services/gate.middleware');
const screens = require('../services/screens.store');
const brainstormService = require('../services/brainstorm.service');
const planService = require('../services/plan.service');
const buildJob = require('../services/build-job.service');
const dataService = require('../services/data.service');
const docStore = require('../services/doc-store.service');
const { ICONS, isBilingual } = require('../services/spec.contract');

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[otto] ${req.method} ${req.originalUrl}:`, err);
      res.status(status).json({ error: err.message || 'Request failed', detail: err.planErrors || err.specErrors || undefined });
    }
  };
}

router.use('/:datasetId', requireOttoLive());

/** Both conversational endpoints take the same transcript shape. */
function readMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    const err = new Error('messages are required');
    err.status = 400;
    throw err;
  }
  return messages
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content.trim() }))
    .slice(-24); // enough context to stay coherent, short enough to stay cheap
}

/** Who is asking — same anonymous per-browser id `createdBy` is stamped
 *  with on create (services/userService, no real auth yet). Sent as a query
 *  param so it is available on every verb, including DELETE. */
function readViewerId(req) {
  const v = req.query?.viewerId ?? req.body?.viewerId;
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
}

/**
 * Loads a screen and enforces per-creator scoping (task #92): a draft/ready
 * screen a viewer did not create does not exist as far as they're concerned
 * (404, not 403 — it must not even reveal it exists). A published app is
 * visible to everyone but `forEdit` routes (chat/plan/build/rename/publish/
 * unpublish/revert/delete) still require the creator.
 */
async function loadScreen(req, { forEdit = false } = {}) {
  const screen = await screens.get(req.params.datasetId, req.params.id);
  if (!screen) {
    const err = new Error('Screen not found');
    err.status = 404;
    throw err;
  }
  const viewerId = readViewerId(req);
  if (!screens.canView(screen, viewerId)) {
    const err = new Error('Screen not found');
    err.status = 404;
    throw err;
  }
  if (forEdit && !screens.canEdit(screen, viewerId)) {
    const err = new Error('Only the creator can edit this screen');
    err.status = 403;
    throw err;
  }
  return screen;
}

// ── screens ──────────────────────────────────────────────────────────────

router.get('/:datasetId/screens', handle(async (req, res) => {
  res.json({
    screens: await screens.list(req.params.datasetId, { viewerId: readViewerId(req) }),
    starters: req.otto.brief.starters || [],
  });
}));

router.post('/:datasetId/screens', handle(async (req, res) => {
  const { title, createdBy } = req.body || {};
  const screen = await screens.create(req.params.datasetId, {
    title: isBilingual(title) ? title : undefined,
    createdBy: typeof createdBy === 'string' ? createdBy.slice(0, 80) : null,
  });
  res.json({ screen });
}));

router.get('/:datasetId/screens/:id', handle(async (req, res) => {
  res.json({ screen: await loadScreen(req) });
}));

router.patch('/:datasetId/screens/:id', handle(async (req, res) => {
  const screen = await loadScreen(req, { forEdit: true });
  const body = req.body || {};

  // "Edit app": the ONE operation a published app accepts — it drops back
  // to 'ready' (editable) while the publish snapshot stays for Cancel
  // changes. Must run before the frozen guard below.
  if (body.unpublish === true) {
    const row = await screens.unpublish(req.params.datasetId, screen.id);
    if (!row) { const e = new Error('Only a published app can be edited'); e.status = 409; throw e; }
    return res.json({ screen: row });
  }

  // "Cancel changes": restore the last published state and go live again.
  if (body.revert === true) {
    const row = await screens.revert(req.params.datasetId, screen.id);
    if (!row) { const e = new Error('There is no published state to return to'); e.status = 409; throw e; }
    require('../services/data.service').invalidate(req.params.datasetId, screen.id);
    return res.json({ screen: row });
  }

  // Published screens are frozen (D4) — everything else refuses.
  if (screen.status === 'active') {
    const err = new Error('A published screen cannot be edited');
    err.status = 409;
    throw err;
  }

  if (body.publish === true) {
    const published = await screens.publish(req.params.datasetId, screen.id);
    if (!published) {
      const err = new Error('Only a built screen (status ready) can be saved to Apps');
      err.status = 409;
      throw err;
    }
    return res.json({ screen: published });
  }

  const patch = {};
  if (body.title !== undefined) {
    if (!isBilingual(body.title)) { const e = new Error('title must carry en and he'); e.status = 400; throw e; }
    patch.title = { en: String(body.title.en).slice(0, 60), he: String(body.title.he).slice(0, 60) };
  }
  if (body.icon !== undefined) {
    if (!ICONS.includes(body.icon)) { const e = new Error('unknown icon'); e.status = 400; throw e; }
    patch.icon = body.icon;
  }
  res.json({ screen: await screens.update(req.params.datasetId, screen.id, patch) });
}));

router.delete('/:datasetId/screens/:id', handle(async (req, res) => {
  const screen = await loadScreen(req, { forEdit: true });
  if (screen.status === 'active') {
    // Q4: published removal is super-admin tooling, not a client button.
    const err = new Error('A published screen cannot be deleted from here');
    err.status = 403;
    throw err;
  }
  const ok = await screens.removeDraft(req.params.datasetId, screen.id);
  res.json({ deleted: ok });
}));

// ── the three calls ──────────────────────────────────────────────────────

router.post('/:datasetId/screens/:id/chat', handle(async (req, res) => {
  const screen = await loadScreen(req, { forEdit: true });
  if (screen.status === 'active') { const e = new Error('A published screen cannot be edited'); e.status = 409; throw e; }
  const messages = readMessages(req.body);

  const result = await brainstormService.brainstorm({
    messages,
    currentPlan: screen.screenSpec ? screen.plan : null,
    brief: req.otto.brief,
    settings: req.otto.settings,
    // The shell's EN/HE toggle, sent by the client — Otto converses in the
    // interface language, like Data Chat and reports (owner, 2026-09-15).
    language: ['en', 'he'].includes(req.body?.language) ? req.body.language : null,
    agentName: req.params.datasetId,
  });

  // The transcript is part of the draft — a reopened draft continues
  // mid-thought instead of starting over.
  await screens.update(req.params.datasetId, screen.id, {
    conversation: [...messages, { role: 'assistant', content: result.reply }],
  });

  res.json(result);
}));

router.post('/:datasetId/screens/:id/plan', handle(async (req, res) => {
  const screen = await loadScreen(req, { forEdit: true });
  if (screen.status === 'active') { const e = new Error('A published screen cannot be edited'); e.status = 409; throw e; }
  const messages = readMessages(req.body);

  const plan = await planService.draftPlan({
    messages,
    currentPlan: screen.screenSpec ? screen.plan : null,
    brief: req.otto.brief,
    settings: req.otto.settings,
    agentName: req.params.datasetId,
  });

  // The plan is stored on the draft immediately — it is the approval gate's
  // artifact, and the title it carries becomes the draft's identity.
  await screens.update(req.params.datasetId, screen.id, {
    plan,
    title: plan.title,
    summary: plan.summary,
    icon: plan.icon || screen.icon || 'grid',
  });

  res.json({ plan });
}));

router.post('/:datasetId/screens/:id/build', handle(async (req, res) => {
  const screen = await loadScreen(req, { forEdit: true });
  if (screen.status === 'active') { const e = new Error('A published screen cannot be rebuilt'); e.status = 409; throw e; }
  if (!screen.plan || !screen.plan.title) {
    const err = new Error('The screen has no approved plan yet');
    err.status = 400;
    throw err;
  }

  const result = await buildJob.startBuild({
    datasetId: req.params.datasetId,
    screen,
    brief: req.otto.brief,
    settings: req.otto.settings,
    pool: req.otto.pool,
    schemaName: req.otto.schemaName,
  });
  if (result.error) return res.status(result.code || 500).json({ error: result.error });
  res.json(result);
}));

router.get('/:datasetId/screens/:id/build/latest', handle(async (req, res) => {
  await loadScreen(req);
  const run = await buildJob.latestBuild(req.params.datasetId, req.params.id);
  res.json({ build: buildJob.describeProgress(run) });
}));

router.get('/:datasetId/builds/running', handle(async (req, res) => {
  const runs = await buildJob.runningBuilds(req.params.datasetId);
  res.json({ builds: runs.map(r => buildJob.describeProgress(r)) });
}));

// ── screen data (the ONLY data path a rendered screen has) ───────────────

router.get('/:datasetId/screens/:id/data', handle(async (req, res) => {
  const screen = await loadScreen(req);
  if (!screen.screenSpec) {
    const err = new Error('The screen has not been built yet');
    err.status = 409;
    throw err;
  }
  res.json(await dataService.getScreenData(screen, req.otto.brief, {
    pool: req.otto.pool,
    schemaName: req.otto.schemaName,
    datasetId: req.params.datasetId,
  }));
}));

// ── the generic doc store (no v1 block writes here yet) ──────────────────

router.get('/:datasetId/store/:moduleId/:collection', handle(async (req, res) => {
  const { datasetId, moduleId, collection } = req.params;
  res.json({ docs: await docStore.listDocs(datasetId, moduleId, collection) });
}));

router.get('/:datasetId/store/:moduleId/:collection/:docId', handle(async (req, res) => {
  const { datasetId, moduleId, collection, docId } = req.params;
  const doc = await docStore.getDoc(datasetId, moduleId, collection, docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json({ doc });
}));

router.put('/:datasetId/store/:moduleId/:collection/:docId', handle(async (req, res) => {
  const { datasetId, moduleId, collection, docId } = req.params;
  res.json({ doc: await docStore.putDoc(datasetId, moduleId, collection, docId, req.body?.data) });
}));

module.exports = router;
