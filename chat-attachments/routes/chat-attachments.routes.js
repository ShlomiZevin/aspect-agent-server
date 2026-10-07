/**
 * Chat file attachments (task #100) — mounted at /api/chat-attachments.
 *
 *   POST /                — multipart `file` (+ agentName, conversationId, userId):
 *                           parse, store, return { id, filename, kind, sizeBytes, summary }.
 *                           The chat then sends `attachments: [id]` with the message
 *                           (see /api/finance-assistant/stream).
 *   POST /:id/fill        — JSON { schema, sql } (a chat data_table step, re-run here)
 *                           or { columns, rows }: the attached spreadsheet filled with
 *                           that result in its own structure, as an .xlsx download.
 */
const express = require('express');
const multer = require('multer');
const service = require('../services/chat-attachments.service');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: service.MAX_BYTES } });

router.post('/', (req, res) => {
  upload.single('file')(req, res, async err => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'The file is larger than 15 MB' : err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Missing file' });
    try {
      const attachment = await service.createAttachment({
        buffer: req.file.buffer,
        // multer hands non-ASCII names over as latin1 — Hebrew file names
        // arrive mangled without this.
        filename: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
        mimeType: req.file.mimetype,
        agentName: req.body.agentName,
        conversationId: req.body.conversationId,
        userId: req.body.userId,
      });
      res.json(attachment);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('❌ chat attachment upload:', e.message);
      res.status(status).json({ error: e.message });
    }
  });
});

router.post('/:id/fill', async (req, res) => {
  try {
    // From a chat data_table step: {schema, sql} — re-run server-side, like
    // /api/data-query/export-excel, so a big table is never POSTed back.
    let { columns, rows, schema, sql } = req.body || {};
    if (sql) {
      const runBiSql = req.app.get('runBiSql');
      ({ columns, rows } = await runBiSql(schema, sql));
    }
    const { buffer, filename, matched, unmatched } = await service.fillTemplate(req.params.id, { columns, rows });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('X-Matched-Columns', String(matched.length));
    res.setHeader('X-Unmatched-Columns', encodeURIComponent(JSON.stringify(unmatched)));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Matched-Columns, X-Unmatched-Columns');
    res.send(buffer);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('❌ chat attachment fill:', e.message);
    res.status(status).json({ error: e.message });
  }
});

module.exports = router;
