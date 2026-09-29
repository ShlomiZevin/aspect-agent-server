/**
 * Material for whoever BUILDS an agent — never sent to the running agent.
 *
 * Mounted at /api/builder. Three things live here:
 *
 *   - The PROJECT spec text (task #870). `builder_projects.spec` existed
 *     from day one but nothing ever wrote to it: what Noa typed in the
 *     project Spec window lived only in her browser, and Alfred (who reads
 *     the DB) always saw it empty. This saves it.
 *
 *   - Files attached to the agent's Spec (#870): `builder_spec_files`
 *     rows with scope 'spec'. Original in GCS under spec-files/<agentId>/,
 *     extracted text beside it so Alfred and the AI door can read it.
 *
 *   - Notes and files on a Targeted KB (#871): a knowledge map — where
 *     each piece came from, what overlaps. Notes in `builder_tkb_notes`,
 *     files in the same table as Spec files with scope 'tkb' + the KB's
 *     enum id, originals under tkb-files/<agentId>/.
 *
 * All of it is keyed by agent, not version — see migrations 056 / 057.
 */

const express = require('express');
const multer = require('multer');
const { eq, and, desc } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { builderProjects, builderAgents, builderSpecFiles, builderTkbNotes } = require('../../db/schema');
const storage = require('../../services/storage.service');
const { extractText } = require('../../services/kb.chunker.service');

const router = express.Router();
const MAX_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

function drizzle() {
  return db.getDrizzle();
}

/** The listing shape — never the extracted text, which can be large. */
function publicRow(r) {
  return {
    id:        r.id,
    fileName:  r.fileName,
    mimeType:  r.mimeType,
    fileSize:  r.fileSize,
    hasText:   !!(r.extractedText && r.extractedText.trim()),
    createdAt: r.createdAt,
  };
}

async function agentExists(agentId) {
  const [agent] = await drizzle().select({ id: builderAgents.id }).from(builderAgents)
    .where(eq(builderAgents.id, agentId)).limit(1);
  return !!agent;
}

/** multer with a friendly size message. */
function receiveFile(req, res, next) {
  upload.single('file')(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `That file is larger than ${MAX_BYTES / 1024 / 1024} MB.` });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

/**
 * Store one uploaded file: extract its text, put the original in GCS,
 * record the row. Shared by Spec files and Targeted KB files — only the
 * scope, the KB it belongs to and the storage folder differ.
 */
async function storeFile(req, res, { scope, refId = null, prefix }) {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file received.' });
  if (!(await agentExists(req.params.agentId))) return res.status(404).json({ error: 'Agent not found' });

  // Browsers send the name as latin1; restore UTF-8 so Hebrew names
  // survive (same fix as Alfred's pinned files).
  const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');

  // Text first: it is what the AI surfaces read, and a file type we
  // can't parse (an image, say) is still worth keeping for the person.
  let extractedText = null;
  try {
    extractedText = (await extractText(file.buffer, fileName, file.mimetype))?.text || null;
  } catch (e) {
    console.warn(`[spec] no text extracted from "${fileName}": ${e.message}`);
  }

  let gcsPath = null;
  try {
    gcsPath = await storage.uploadFile(file.buffer, fileName, file.mimetype, req.params.agentId, prefix);
  } catch (e) {
    // Keep the row: the text is the part the AI needs. Download is what
    // is lost, and the listing says so.
    console.error(`[spec] GCS upload failed for "${fileName}": ${e.message}`);
  }
  if (!gcsPath && !extractedText) {
    return res.status(500).json({ error: 'The file could not be stored or read. Try again, or a different format.' });
  }

  const [row] = await drizzle().insert(builderSpecFiles).values({
    agentId:  req.params.agentId,
    fileName,
    mimeType: file.mimetype || null,
    fileSize: file.size,
    gcsPath,
    extractedText,
    scope,
    refId,
  }).returning();
  return res.json({ file: publicRow(row) });
}

// ─── Project spec text (#870) ──────────────────────────────────────

router.put('/projects/:projectId/spec', express.json(), async (req, res) => {
  try {
    const spec = req.body?.spec;
    if (typeof spec !== 'string') return res.status(400).json({ error: 'spec must be a string' });
    const updated = await drizzle().update(builderProjects)
      .set({ spec, updatedAt: new Date() })
      .where(eq(builderProjects.id, req.params.projectId))
      .returning({ id: builderProjects.id });
    if (updated.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[spec] save project spec failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Spec files (#870) ─────────────────────────────────────────────

router.get('/agents/:agentId/spec-files', async (req, res) => {
  try {
    const rows = await drizzle().select().from(builderSpecFiles)
      .where(and(eq(builderSpecFiles.agentId, req.params.agentId), eq(builderSpecFiles.scope, 'spec')))
      .orderBy(desc(builderSpecFiles.createdAt));
    res.json({ files: rows.map(publicRow) });
  } catch (err) {
    console.error('[spec] list files failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/agents/:agentId/spec-files', receiveFile, async (req, res) => {
  try {
    await storeFile(req, res, { scope: 'spec', prefix: 'spec-files' });
  } catch (err) {
    console.error('[spec] upload failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Targeted KB notes + files (#871) ──────────────────────────────

router.get('/agents/:agentId/tkb/:enumId', async (req, res) => {
  try {
    const { agentId, enumId } = req.params;
    const [note] = await drizzle().select().from(builderTkbNotes)
      .where(and(eq(builderTkbNotes.agentId, agentId), eq(builderTkbNotes.enumId, enumId))).limit(1);
    const files = await drizzle().select().from(builderSpecFiles)
      .where(and(
        eq(builderSpecFiles.agentId, agentId),
        eq(builderSpecFiles.scope, 'tkb'),
        eq(builderSpecFiles.refId, enumId),
      ))
      .orderBy(desc(builderSpecFiles.createdAt));
    res.json({ notes: note?.notes ?? '', files: files.map(publicRow) });
  } catch (err) {
    console.error('[tkb] read notes failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/agents/:agentId/tkb/:enumId/notes', express.json(), async (req, res) => {
  try {
    const notes = req.body?.notes;
    if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
    const { agentId, enumId } = req.params;
    if (!(await agentExists(agentId))) return res.status(404).json({ error: 'Agent not found' });
    await drizzle().insert(builderTkbNotes)
      .values({ agentId, enumId, notes, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [builderTkbNotes.agentId, builderTkbNotes.enumId],
        set: { notes, updatedAt: new Date() },
      });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tkb] save notes failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/agents/:agentId/tkb/:enumId/files', receiveFile, async (req, res) => {
  try {
    await storeFile(req, res, { scope: 'tkb', refId: req.params.enumId, prefix: 'tkb-files' });
  } catch (err) {
    console.error('[tkb] upload failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Any stored file (Spec or Targeted KB) ─────────────────────────

router.get('/spec-files/:id/download', async (req, res) => {
  try {
    const [row] = await drizzle().select().from(builderSpecFiles)
      .where(eq(builderSpecFiles.id, Number(req.params.id))).limit(1);
    if (!row) return res.status(404).json({ error: 'File not found' });
    if (!row.gcsPath) return res.status(404).json({ error: 'Only the text of this file was kept — the original could not be stored.' });
    const buffer = await storage.downloadFile(row.gcsPath);
    res.setHeader('Content-Type', row.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName)}`);
    res.send(buffer);
  } catch (err) {
    console.error('[spec] download failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/spec-files/:id', async (req, res) => {
  try {
    const [row] = await drizzle().delete(builderSpecFiles)
      .where(eq(builderSpecFiles.id, Number(req.params.id))).returning();
    if (!row) return res.status(404).json({ error: 'File not found' });
    if (row.gcsPath) storage.deleteFile(row.gcsPath).catch(() => { /* row is gone; an orphan blob is harmless */ });
    res.json({ ok: true });
  } catch (err) {
    console.error('[spec] delete failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
