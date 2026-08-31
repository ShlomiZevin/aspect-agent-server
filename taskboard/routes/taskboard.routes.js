/**
 * The Aspect task board's HTTP surface.
 *
 *   GET    /api/taskboard/tasks                  list, with optional filters
 *   POST   /api/taskboard/tasks                  create
 *   GET    /api/taskboard/tasks/whats-new        deployed and not yet dismissed
 *   GET    /api/taskboard/tasks/needs-attention  ids waiting on you
 *   GET    /api/taskboard/tasks/:id              one task
 *   PATCH  /api/taskboard/tasks/:id              update
 *   DELETE /api/taskboard/tasks/:id              delete (cascades)
 *   POST   /api/taskboard/tasks/:id/deploy       mark deployed
 *   POST   /api/taskboard/tasks/:id/dismiss      drop from your What's New
 *   GET    /api/taskboard/tasks/:id/comments     list
 *   POST   /api/taskboard/tasks/:id/comments     add
 *   DELETE /api/taskboard/comments/:id           delete
 *   POST   /api/taskboard/comments/:id/like      toggle
 *   GET    /api/taskboard/people                 roster
 *   POST   /api/taskboard/people                 add
 *   GET    /api/taskboard/notifications          unread, for ?person=
 *   POST   /api/taskboard/notifications/read     mark read
 *   POST   /api/taskboard/translate              Hebrew <-> English
 *   GET    /api/taskboard/stream                 SSE
 *
 * The literal routes come BEFORE `/tasks/:id`. Express matches in order, so
 * `/tasks/whats-new` registered after the parameter route would be swallowed by
 * it and answer "task 'whats-new' not found" -- the same trap the modules router
 * documents for its own admin prefix.
 */
const express = require('express');

const tasksService = require('../services/tasks.service');
const commentsService = require('../services/comments.service');
const peopleService = require('../services/people.service');
const translateService = require('../services/translate.service');
const events = require('../services/events.service');

const router = express.Router();

/**
 * Turns a service call into a response, so no handler repeats the try/catch.
 * A ValidationError is the caller's fault (400); anything else is ours (500)
 * and gets logged with its stack rather than flattened into a message.
 */
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.name === 'ValidationError') {
        return res.status(400).json({ error: err.message });
      }
      console.error(`[taskboard] ${req.method} ${req.originalUrl}:`, err);
      res.status(500).json({ error: 'Task board request failed' });
    }
  };
}

const id = req => Number(req.params.id);
const notFound = res => res.status(404).json({ error: 'Not found' });

// --- tasks ------------------------------------------------------------------

router.get('/tasks', handle(async (req, res) => {
  const { status, assignee, type, priority, tag, openOnly } = req.query;
  const tasks = await tasksService.listTasks({
    status, assignee, type, priority, tag,
    openOnly: openOnly === 'true',
  });
  res.json({ tasks });
}));

router.post('/tasks', handle(async (req, res) => {
  res.status(201).json({ task: await tasksService.createTask(req.body) });
}));

router.get('/tasks/whats-new', handle(async (req, res) => {
  const person = req.query.person;
  if (!person) return res.status(400).json({ error: 'person is required' });
  res.json({ tasks: await tasksService.whatsNew(person) });
}));

router.get('/tasks/needs-attention', handle(async (req, res) => {
  const person = req.query.person;
  if (!person) return res.status(400).json({ error: 'person is required' });
  res.json({ taskIds: await commentsService.needsAttention(person) });
}));

router.get('/tasks/:id', handle(async (req, res) => {
  const task = await tasksService.getTask(id(req));
  return task ? res.json({ task }) : notFound(res);
}));

router.patch('/tasks/:id', handle(async (req, res) => {
  const task = await tasksService.updateTask(id(req), req.body);
  return task ? res.json({ task }) : notFound(res);
}));

router.delete('/tasks/:id', handle(async (req, res) => {
  const gone = await tasksService.deleteTask(id(req));
  return gone ? res.json({ success: true }) : notFound(res);
}));

router.post('/tasks/:id/deploy', handle(async (req, res) => {
  const task = await tasksService.markDeployed(id(req));
  return task ? res.json({ task }) : notFound(res);
}));

router.post('/tasks/:id/dismiss', handle(async (req, res) => {
  const { person } = req.body;
  if (!person) return res.status(400).json({ error: 'person is required' });
  const done = await tasksService.dismiss(id(req), person);
  return done ? res.json({ success: true }) : notFound(res);
}));

// --- comments ---------------------------------------------------------------

router.get('/tasks/:id/comments', handle(async (req, res) => {
  res.json({ comments: await commentsService.listComments(id(req)) });
}));

router.post('/tasks/:id/comments', handle(async (req, res) => {
  const { author, body } = req.body;
  const comment = await commentsService.addComment(id(req), author, body);
  return comment ? res.status(201).json({ comment }) : notFound(res);
}));

router.delete('/comments/:id', handle(async (req, res) => {
  const gone = await commentsService.deleteComment(id(req));
  return gone ? res.json({ success: true }) : notFound(res);
}));

router.post('/comments/:id/like', handle(async (req, res) => {
  const { person } = req.body;
  if (!person) return res.status(400).json({ error: 'person is required' });
  const comment = await commentsService.toggleLike(id(req), person);
  return comment ? res.json({ comment }) : notFound(res);
}));

// --- people and notifications ------------------------------------------------

router.get('/people', handle(async (_req, res) => {
  res.json({ people: await peopleService.list() });
}));

router.post('/people', handle(async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  res.status(201).json({ person: await peopleService.add(name) });
}));

router.get('/notifications', handle(async (req, res) => {
  const person = req.query.person;
  if (!person) return res.status(400).json({ error: 'person is required' });
  res.json({ notifications: await peopleService.notifications(person) });
}));

router.post('/notifications/read', handle(async (req, res) => {
  const { person, ids, all } = req.body;
  if (!person) return res.status(400).json({ error: 'person is required' });
  const count = all
    ? await peopleService.markAllRead(person)
    : await peopleService.markRead(ids, person);
  res.json({ marked: count });
}));

// --- translation --------------------------------------------------------------

/**
 * Translates a piece of task text and returns it; stores nothing.
 *
 * Deliberately not a field on the task: a translation is a reading aid, and
 * writing one back would mean the board holds two versions of a title that then
 * drift apart every time someone edits one of them.
 */
router.post('/translate', handle(async (req, res) => {
  const { text } = req.body;
  res.json(await translateService.translate(text));
}));

// --- live updates -------------------------------------------------------------

router.get('/stream', (req, res) => {
  const unsubscribe = events.subscribe(res);
  req.on('close', unsubscribe);
});

module.exports = router;
