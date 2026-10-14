/**
 * Chat file attachments (task #100) — mounted at /api/chat-attachments.
 *
 *   POST /                — multipart `file` (+ agentName, conversationId, userId):
 *                           parse, store, return { id, filename, kind, sizeBytes, summary }.
 *                           The chat then sends `attachments: [id]` with the message
 *                           (see /api/finance-assistant/stream).
 *   POST /:id/query       — JSON { spec, format? }: re-run a query_attached_file result
 *                           (the chat's table viewer / its Excel export).
 *   POST /:id/fill        — JSON { schema, sql } | { fileQuery } | { columns, rows }:
 *                           the attached spreadsheet filled with that result in its own
 *                           structure, as an .xlsx download.
 */
const express = require('express');
const multer = require('multer');
const service = require('../services/chat-attachments.service');
const fileQuery = require('../services/file-query.service');

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

/**
 * Re-run a query_attached_file result (the chat's table viewer, after the
 * live turn or a reload). `format: "xlsx"` returns the plain Excel export
 * (with `displayColumns` labels), otherwise JSON { columns, rows }.
 */
router.post('/:id/query', async (req, res) => {
  try {
    const { spec = {}, format, displayColumns, title } = req.body || {};
    const out = await fileQuery.queryFile(req.params.id, spec);
    if (format !== 'xlsx') return res.json({ columns: out.columns, rows: out.rows, rowCount: out.rows.length });

    const XLSX = require('xlsx');
    const cols = Array.isArray(displayColumns) && displayColumns.length
      ? displayColumns
      : out.columns.map(key => ({ key, label: key }));
    const aoa = [cols.map(c => c.label), ...out.rows.map(r => cols.map(c => r[c.key] ?? ''))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), String(title || out.sheet || 'Data').slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="table.xlsx"');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('❌ chat attachment query:', e.message);
    res.status(status).json({ error: e.message });
  }
});

router.post('/:id/fill', async (req, res) => {
  try {
    // The result to write in: a database table's {schema, sql}, or a file
    // query's {fileQuery} — both re-run server-side, like
    // /api/data-query/export-excel, so a big table is never POSTed back.
    let { columns, rows, schema, sql, fileQuery: fq } = req.body || {};
    if (sql) {
      const runBiSql = req.app.get('runBiSql');
      ({ columns, rows } = await runBiSql(schema, sql));
    } else if (fq?.attachmentId) {
      ({ columns, rows } = await fileQuery.queryFile(fq.attachmentId, fq.spec || {}));
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
