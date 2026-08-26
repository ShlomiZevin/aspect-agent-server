/**
 * Review comments on internal spec / explainer pages.
 *
 * The whole feature is: leave your name and a comment on a section of a page,
 * read what everyone else wrote, delete one if you mistyped. No auth, no
 * threads, no editing, no notifications — these pages are internal review
 * documents shared by link with a handful of named people, and anything
 * heavier would go unused.
 *
 * Mounted at /api/page-comments (one line in server.js).
 */

const express = require('express');
const db = require('../services/db.pg');
const { pageComments } = require('../db/schema');
const { eq, and, asc } = require('drizzle-orm');

const router = express.Router();

const MAX_AUTHOR = 100;
const MAX_BODY = 4000;
/** A page cannot accumulate more than this — a review doc, not a forum. */
const MAX_PER_PAGE = 500;

/** page keys and section ids come from the URL, so keep them boring. */
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;

function drizzle() {
  return db.getDrizzle();
}

/** GET /api/page-comments/:pageKey — every comment on the page, oldest first. */
router.get('/:pageKey', async (req, res) => {
  const { pageKey } = req.params;
  if (!KEY_RE.test(pageKey)) return res.status(400).json({ error: 'Invalid page key' });
  try {
    const rows = await drizzle()
      .select()
      .from(pageComments)
      .where(eq(pageComments.pageKey, pageKey))
      .orderBy(asc(pageComments.createdAt));
    res.json({ comments: rows });
  } catch (err) {
    console.error('[page-comments] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load comments' });
  }
});

/** POST /api/page-comments/:pageKey — { sectionId?, author, body } */
router.post('/:pageKey', async (req, res) => {
  const { pageKey } = req.params;
  if (!KEY_RE.test(pageKey)) return res.status(400).json({ error: 'Invalid page key' });

  const sectionId = (req.body?.sectionId || 'general').toString().trim() || 'general';
  const author = (req.body?.author || '').toString().trim();
  const body = (req.body?.body || '').toString().trim();

  if (!KEY_RE.test(sectionId)) return res.status(400).json({ error: 'Invalid section id' });
  if (!author) return res.status(400).json({ error: 'Name is required' });
  if (!body) return res.status(400).json({ error: 'Comment is required' });

  try {
    const existing = await drizzle()
      .select({ id: pageComments.id })
      .from(pageComments)
      .where(eq(pageComments.pageKey, pageKey));
    if (existing.length >= MAX_PER_PAGE) {
      return res.status(429).json({ error: 'This page has too many comments' });
    }

    const [comment] = await drizzle()
      .insert(pageComments)
      .values({
        pageKey,
        sectionId,
        author: author.slice(0, MAX_AUTHOR),
        body: body.slice(0, MAX_BODY),
      })
      .returning();
    res.status(201).json({ comment });
  } catch (err) {
    console.error('[page-comments] insert failed:', err.message);
    res.status(500).json({ error: 'Failed to save comment' });
  }
});

/** DELETE /api/page-comments/:pageKey/:id — anyone can remove one. */
router.delete('/:pageKey/:id', async (req, res) => {
  const { pageKey } = req.params;
  const id = Number(req.params.id);
  if (!KEY_RE.test(pageKey)) return res.status(400).json({ error: 'Invalid page key' });
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
  try {
    // Scoped by page too, so a wrong id can never reach another page's row.
    await drizzle()
      .delete(pageComments)
      .where(and(eq(pageComments.id, id), eq(pageComments.pageKey, pageKey)));
    res.json({ ok: true });
  } catch (err) {
    console.error('[page-comments] delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

module.exports = router;
