/**
 * Internal brainstorm comments — threaded comments for any internal page (by page_id)
 * (first user: /lybi/bank-jerusalem). No auth, by design: internal page.
 *
 *   GET    /api/doc-comments/:pageId           all non-deleted, oldest first
 *   POST   /api/doc-comments/:pageId           { itemId, author, body, parentId? }
 *   PATCH  /api/doc-comments/:pageId/:id       { resolved?, body?, by }
 *   DELETE /api/doc-comments/:pageId/:id       soft delete
 *   GET    /api/doc-comments/:pageId/settings  { hiddenSections }
 *   PUT    /api/doc-comments/:pageId/settings  { hiddenSections: string[], by }
 *
 * Table is created lazily (also recorded in db/migrations/067_internal_brainstorm_comments.sql).
 */
const express = require('express');
const db = require('../services/db.pg');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = db.query(`
      CREATE TABLE IF NOT EXISTS internal_brainstorm_comments (
        id SERIAL PRIMARY KEY,
        page_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        parent_id INTEGER,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        resolved BOOLEAN NOT NULL DEFAULT FALSE,
        resolved_by TEXT,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS internal_brainstorm_comments_page_idx ON internal_brainstorm_comments (page_id);
      CREATE TABLE IF NOT EXISTS internal_brainstorm_settings (
        page_id TEXT PRIMARY KEY,
        hidden_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch(err => { ready = null; throw err; });
  }
  return ready;
}

const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const COLS = 'id, page_id AS "pageId", item_id AS "itemId", parent_id AS "parentId", author, body, resolved, resolved_by AS "resolvedBy", created_at AS "createdAt", updated_at AS "updatedAt"';

router.get('/:pageId/settings', async (req, res) => {
  try {
    if (!str(req.params.pageId, 80)) return res.status(400).json({ error: 'bad pageId' });
    await ensureTable();
    const r = await db.query('SELECT hidden_sections AS "hiddenSections", updated_by AS "updatedBy" FROM internal_brainstorm_settings WHERE page_id = $1', [req.params.pageId]);
    res.json(r.rows[0] || { hiddenSections: [], updatedBy: null });
  } catch (err) {
    console.error('[page-comments] settings read failed:', err.message);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

router.put('/:pageId/settings', async (req, res) => {
  try {
    const { hiddenSections, by } = req.body || {};
    if (!str(req.params.pageId, 80)) return res.status(400).json({ error: 'bad pageId' });
    if (!Array.isArray(hiddenSections) || hiddenSections.length > 50 || !hiddenSections.every(x => str(x, 80))) {
      return res.status(400).json({ error: 'hiddenSections must be a list of short strings' });
    }
    await ensureTable();
    const r = await db.query(
      `INSERT INTO internal_brainstorm_settings (page_id, hidden_sections, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (page_id) DO UPDATE SET hidden_sections = EXCLUDED.hidden_sections, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING hidden_sections AS "hiddenSections", updated_by AS "updatedBy"`,
      [req.params.pageId, JSON.stringify([...new Set(hiddenSections)]), str(by, 40) ? by.trim() : null],
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[page-comments] settings write failed:', err.message);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

router.get('/:pageId', async (req, res) => {
  try {
    if (!str(req.params.pageId, 80)) return res.status(400).json({ error: 'bad pageId' });
    await ensureTable();
    const r = await db.query(`SELECT ${COLS} FROM internal_brainstorm_comments WHERE page_id = $1 AND deleted = FALSE ORDER BY created_at, id`, [req.params.pageId]);
    res.json({ comments: r.rows });
  } catch (err) {
    console.error('[page-comments] list failed:', err.message);
    res.status(500).json({ error: 'Could not load comments' });
  }
});

router.post('/:pageId', async (req, res) => {
  try {
    const { itemId, author, body, parentId } = req.body || {};
    if (!str(req.params.pageId, 80) || !str(itemId, 80)) return res.status(400).json({ error: 'bad pageId/itemId' });
    if (!str(author, 40)) return res.status(400).json({ error: 'author required (≤ 40 chars)' });
    if (!str(body, 4000)) return res.status(400).json({ error: 'body required (≤ 4000 chars)' });
    const parent = parentId == null ? null : Number(parentId);
    if (parent !== null && !Number.isInteger(parent)) return res.status(400).json({ error: 'bad parentId' });
    await ensureTable();
    const r = await db.query(
      `INSERT INTO internal_brainstorm_comments (page_id, item_id, parent_id, author, body) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
      [req.params.pageId, itemId, parent, author.trim(), body.trim()],
    );
    res.status(201).json({ comment: r.rows[0] });
  } catch (err) {
    console.error('[page-comments] create failed:', err.message);
    res.status(500).json({ error: 'Could not save the comment' });
  }
});

router.patch('/:pageId/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const { resolved, body, by } = req.body || {};
    const sets = [];
    const params = [];
    if (typeof resolved === 'boolean') {
      params.push(resolved); sets.push(`resolved = $${params.length}`);
      params.push(resolved && str(by, 40) ? by.trim() : null); sets.push(`resolved_by = $${params.length}`);
    }
    if (body !== undefined) {
      if (!str(body, 4000)) return res.status(400).json({ error: 'body ≤ 4000 chars' });
      params.push(body.trim()); sets.push(`body = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    await ensureTable();
    params.push(id, req.params.pageId);
    const r = await db.query(
      `UPDATE internal_brainstorm_comments SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length - 1} AND page_id = $${params.length} AND deleted = FALSE RETURNING ${COLS}`,
      params,
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ comment: r.rows[0] });
  } catch (err) {
    console.error('[page-comments] update failed:', err.message);
    res.status(500).json({ error: 'Could not update the comment' });
  }
});

router.delete('/:pageId/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    await ensureTable();
    const r = await db.query(
      'UPDATE internal_brainstorm_comments SET deleted = TRUE, updated_at = NOW() WHERE id = $1 AND page_id = $2 AND deleted = FALSE RETURNING id',
      [id, req.params.pageId],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[page-comments] delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete the comment' });
  }
});

module.exports = router;
