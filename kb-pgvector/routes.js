/**
 * pgvector proof of concept (2026-11-23) — the /:agent/pgvector-poc page.
 * Same KB, same query vector, searched in Pinecone (today's path) and in
 * pgvector inside this environment's Postgres; see ./service.js.
 *
 *   GET  /api/kb-pgvector/:agentSlug/info[?namespace=]   which KB, chunks, model
 *   POST /api/kb-pgvector/:agentSlug/search              { query, topK, namespace? }
 *        → both ranked lists (snippet, file, score), latency of each, overlap
 *
 * Read-only on both stores. No auth, like the other internal pages (pre-launch
 * platform). A KB gets here by kb-pgvector/copy-from-pinecone.js (migration 073).
 */
const express = require('express');
const poc = require('./service');

const router = express.Router();
router.use(express.json({ limit: '16kb' }));

const send = (res, err) => {
  if (err instanceof poc.PocError) return res.status(err.status).json({ error: err.message });
  console.error('[kb-pgvector]', err);
  return res.status(500).json({ error: err.message });
};

router.get('/:agentSlug/info', async (req, res) => {
  try {
    res.json(await poc.info(req.params.agentSlug, req.query.namespace || undefined));
  } catch (err) { send(res, err); }
});

router.post('/:agentSlug/search', async (req, res) => {
  try {
    const { query, topK, namespace } = req.body || {};
    res.json(await poc.search(req.params.agentSlug, { query, topK, namespace }));
  } catch (err) { send(res, err); }
});

module.exports = router;
