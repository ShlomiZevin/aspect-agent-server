/**
 * The Spec — guidance for whoever BUILDS an agent (task #870).
 *
 * Mounted at /api/builder. Two things live here:
 *
 *   - The PROJECT spec text. `builder_projects.spec` existed from day one
 *     but nothing ever wrote to it: what Noa typed in the project Spec
 *     window lived only in her browser, and Alfred (who reads the DB)
 *     always saw it empty. This saves it.
 *
 *   - Files attached to the agent's Spec. The original goes to GCS under
 *     spec-files/<agentId>/; the text extracted from it is stored beside
 *     it so Alfred and the Builder's AI door can read it. Keyed by agent,
 *     not version — see migration 056.
 *
 * None of it is ever sent to the running agent.
 */

const express = require('express');
const multer = require('multer');
const { eq, desc } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { builderProjects, builderAgents, builderSpecFiles } = require('../../db/schema');
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

router.get('/agents/:agentId/spec-files', async (req, res) => {
  try {
    const rows = await drizzle().select().from(builderSpecFiles)
      .where(eq(builderSpecFiles.agentId, req.params.agentId))
      .orderBy(desc(builderSpecFiles.createdAt));
    res.json({ files: rows.map(publicRow) });
  } catch (err) {
    console.error('[spec] list files failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/agents/:agentId/spec-files', (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `That file is larger than ${MAX_BYTES / 1024 / 1024} MB.` });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received.' });
    const [agent] = await drizzle().select({ id: builderAgents.id }).from(builderAgents)
      .where(eq(builderAgents.id, req.params.agentId)).limit(1);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

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
      gcsPath = await storage.uploadFile(file.buffer, fileName, file.mimetype, agent.id, 'spec-files');
    } catch (e) {
      // Keep the row: the text is the part the AI needs. Download is what
      // is lost, and the listing says so.
      console.error(`[spec] GCS upload failed for "${fileName}": ${e.message}`);
    }
    if (!gcsPath && !extractedText) {
      return res.status(500).json({ error: 'The file could not be stored or read. Try again, or a different format.' });
    }

    const [row] = await drizzle().insert(builderSpecFiles).values({
      agentId:  agent.id,
      fileName,
      mimeType: file.mimetype || null,
      fileSize: file.size,
      gcsPath,
      extractedText,
    }).returning();
    res.json({ file: publicRow(row) });
  } catch (err) {
    console.error('[spec] upload failed:', err);
    res.status(500).json({ error: err.message });
  }
});

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
