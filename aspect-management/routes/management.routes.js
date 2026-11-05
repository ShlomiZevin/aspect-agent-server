/**
 * Aspect Management's HTTP surface. See ../README.md.
 *
 *   GET   /api/management/me                who this sign-in email is here
 *   GET   /api/management/morning           the owner's alerts
 *   GET   /api/management/people            team, with hours
 *   POST  /api/management/people            add
 *   PATCH /api/management/people/:id        update
 *   GET   /api/management/people/:id/reports  last two weeks
 *   GET   /api/management/clients           list
 *   POST  /api/management/clients           add
 *   GET   /api/management/clients/:id       the client card
 *   PATCH /api/management/clients/:id       update
 *   POST  /api/management/clients/:id/notes add a note
 *   GET   /api/management/projects          active projects
 *   POST  /api/management/projects          add, or convert a won quote (quoteId)
 *   PATCH /api/management/projects/:id      update
 *   GET   /api/management/report            one person's day
 *   PUT   /api/management/report            send one person's day
 *   GET   /api/management/quotes            open and closed
 *   POST  /api/management/quotes            add
 *   PATCH /api/management/quotes/:id        update
 *   POST  /api/management/ask               ask the system
 */
const express = require('express');

const management = require('../services/management.service');
const askService = require('../services/ask.service');

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
      console.error(`[aspect-management] ${req.method} ${req.originalUrl}:`, err);
      res.status(500).json({ error: 'משהו השתבש. נסו שוב.' });
    }
  };
}

router.get('/me', handle(async req => ({ person: await management.whoAmI(req.query.email, req.query.name) })));
router.get('/morning', handle(() => management.morning()));

router.get('/people', handle(async () => ({ people: await management.listPeople() })));
router.post('/people', handle(req => management.createPerson(req.body)));
router.patch('/people/:id', handle(req => management.updatePerson(req.params.id, req.body)));
router.get('/people/:id/reports', handle(req => management.personReports(req.params.id)));

router.get('/clients', handle(async () => ({ clients: await management.listClients() })));
router.post('/clients', handle(req => management.createClient(req.body)));
router.get('/clients/:id', handle(async req => {
  const client = await management.getClient(req.params.id);
  if (!client) throw management.invalid('הלקוח לא נמצא');
  return client;
}));
router.patch('/clients/:id', handle(req => management.updateClient(req.params.id, req.body)));
router.post('/clients/:id/notes', handle(req => management.addClientNote(req.params.id, req.body)));

router.get('/projects', handle(async () => ({ projects: await management.listActiveProjects() })));
router.post('/projects', handle(req => management.createProject(req.body)));
router.patch('/projects/:id', handle(req => management.updateProject(req.params.id, req.body)));

router.get('/report', handle(req => management.getReport(req.query.personId, req.query.date)));
router.put('/report', handle(req => management.saveReport(req.body)));

router.get('/quotes', handle(() => management.listQuotes()));
router.post('/quotes', handle(req => management.createQuote(req.body)));
router.patch('/quotes/:id', handle(req => management.updateQuote(req.params.id, req.body)));

router.post('/ask', handle(req => askService.ask(req.body?.question)));

module.exports = router;
