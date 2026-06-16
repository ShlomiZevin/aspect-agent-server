/**
 * Repo route — shared library of reusable prompts (and, eventually,
 * whole addon configs). One table, polymorphic via `kind`. For v1
 * the client only writes/reads `kind: 'prompt'` entries; the addon-
 * repo flow will reuse this surface later by sending `kind: 'addon'`
 * with the full AddonInstance config as `content`.
 *
 * Endpoints (all under /api/builder/repo):
 *
 *   GET    /entries?kind=prompt&pluginId=field-extractor
 *     List entries matching the filter. Both query params required.
 *     Returns { entries: RepoEntry[] }.
 *
 *   POST   /entries
 *     Body: { kind, pluginId, name, content }
 *     Creates one entry. Returns { entry: RepoEntry }.
 *
 *   DELETE /entries/:id
 *     Removes one entry by id. Returns { ok: true }.
 *
 * Built-in defaults are NOT stored here — the client synthesises them
 * on every read from the live `@addons/*.addon.json` imports. This
 * table only holds entries a user actually saved.
 */

const express = require('express');
const { eq, and } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { repoEntries } = require('../../db/schema');

const router = express.Router();

function drizzle() {
  return db.getDrizzle();
}

function genId() {
  return `repo_${Math.random().toString(36).slice(2, 10)}`;
}

/** Validation shared by POST. Returns a string with the failure
 *  reason or null when ok. Strict on the polymorphic columns so a
 *  stray client send can't write a row the consumer can't read. */
function validateEntryBody(body) {
  if (!body || typeof body !== 'object') return 'Missing body';
  const { kind, pluginId, name, content } = body;
  if (kind !== 'prompt' && kind !== 'addon') {
    return 'kind must be "prompt" or "addon"';
  }
  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
    return 'pluginId is required';
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    return 'name is required';
  }
  if (content === null || content === undefined) {
    return 'content is required';
  }
  // For the prompt kind enforce the well-known shape so consumers
  // don't have to defend against junk on every read.
  if (kind === 'prompt') {
    if (typeof content !== 'object' || typeof content.prompt !== 'string') {
      return 'For kind="prompt", content must be { prompt: <string> }';
    }
  }
  return null;
}

// ─── GET /entries ─────────────────────────────────────────────────

router.get('/entries', async (req, res) => {
  try {
    const { kind, pluginId } = req.query;
    if (!kind || !pluginId) {
      return res.status(400).json({ error: 'kind and pluginId query params required' });
    }
    const rows = await drizzle().select()
      .from(repoEntries)
      .where(and(
        eq(repoEntries.kind, String(kind)),
        eq(repoEntries.pluginId, String(pluginId)),
      ));
    // Newest first so the user's recent saves are easiest to spot.
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({
      entries: rows.map(r => ({
        id:        r.id,
        kind:      r.kind,
        pluginId:  r.pluginId,
        name:      r.name,
        content:   r.content,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('[repo] GET entries failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /entries ────────────────────────────────────────────────

router.post('/entries', async (req, res) => {
  try {
    const err = validateEntryBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const { kind, pluginId, name, content } = req.body;
    const id = genId();
    const [row] = await drizzle().insert(repoEntries).values({
      id,
      kind,
      pluginId: pluginId.trim(),
      name:     name.trim(),
      content,
    }).returning();
    res.json({
      entry: {
        id:        row.id,
        kind:      row.kind,
        pluginId:  row.pluginId,
        name:      row.name,
        content:   row.content,
        createdAt: row.createdAt,
      },
    });
  } catch (err) {
    console.error('[repo] POST entries failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /entries/:id ──────────────────────────────────────────

router.delete('/entries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await drizzle().delete(repoEntries).where(eq(repoEntries.id, id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[repo] DELETE entry failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
