/**
 * The management center for non-technical users (task #985) — its API.
 * Client: `/manage/<slug>` and `/manage/all` (aspect-react-client/src/manage/).
 *
 *   GET /api/manage/agents/:slug/customer-problems?range=today|week
 *       one agent's customer-chat problems, in plain Hebrew. Open, like
 *       every per-agent Admin read (Admin → Errors uses /api/errors).
 *   GET /api/manage/customer-problems?range=today|week[&agent=<slug>]
 *       every agent ("all" — internal only): needs the super-admin key
 *       header (services/super-admin.js), the same light gate as the
 *       hidden /users page. `agent` narrows the problems; `agents` still
 *       lists everyone for the filter.
 *
 * The words come from builder/services/customerProblems.js — the MCP
 * prints the same ones.
 */

const express = require('express');
const customerProblems = require('../services/customerProblems');
const { requireSuperAdmin } = require('../../services/super-admin');

const router = express.Router();

router.get('/agents/:slug/customer-problems', async (req, res) => {
  try {
    const slug = String(req.params.slug);
    if (!(await customerProblems.agentExists(slug))) {
      return res.status(404).json({ error: `No agent "${slug}".` });
    }
    const data = await customerProblems.listProblems({ slug, range: req.query.range });
    res.json({ scope: 'agent', agent: data.agents.find(a => a.slug === slug) || { slug, name: slug }, ...data });
  } catch (err) {
    console.error('[manage] customer problems failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/customer-problems', requireSuperAdmin, async (req, res) => {
  try {
    const agent = req.query.agent ? String(req.query.agent) : null;
    const [everyone, data] = await Promise.all([
      customerProblems.listProblems({ slug: null, range: req.query.range }),
      agent ? customerProblems.listProblems({ slug: agent, range: req.query.range }) : null,
    ]);
    const view = data || everyone;
    res.json({ scope: 'all', agent: null, filter: agent, ...view, agents: everyone.agents });
  } catch (err) {
    console.error('[manage] all customer problems failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
