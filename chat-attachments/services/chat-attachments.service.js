/**
 * Files attached in chat (task #100) — generic for every agent and format.
 *
 * A file becomes a DIGEST the model can read: for a spreadsheet its layout
 * (sheets, header rows, a label per column, per-column formulas) plus as much
 * of its data as fits a budget; for documents, their text; for images and
 * scanned PDFs, a vision transcription. The digest is embedded in the user's
 * saved message between markers (see composeMessage), so every later turn of
 * the conversation still has the file — no per-crew code involved — and the
 * client renders the marked block as a file chip instead of text.
 *
 * The original bytes are kept so a spreadsheet can be filled back in its OWN
 * structure (fillTemplate): "build me this report from your data" answers in
 * the file the user gave, not in a shape we chose.
 */
const crypto = require('crypto');
const XLSX = require('xlsx');
const db = require('../../services/db.pg');
const llmService = require('../../services/llm');

const MAX_BYTES = 15 * 1024 * 1024;
/** Characters of actual cell data the model gets, across all sheets. */
const DATA_BUDGET = 14000;
const TEXT_BUDGET = 20000;
const MAX_SHEETS = 8;
const VISION_MODEL = 'claude-sonnet-4-6';

const MARKER_OPEN = '<<<ATTACHED_FILE';
const MARKER_CLOSE = '<<<END_ATTACHED_FILE>>>';

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

function detectKind(filename, mimeType) {
  const ext = extOf(filename);
  if (['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv'].includes(ext)) return 'spreadsheet';
  if (ext === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  if (ext === 'docx') return 'document';
  if (IMAGE_TYPES[ext] || (mimeType || '').startsWith('image/')) return 'image';
  if (['txt', 'md', 'json', 'xml', 'html', 'htm', 'log', 'sql'].includes(ext) || (mimeType || '').startsWith('text/')) return 'text';
  return null;
}

// ── Spreadsheets ──────────────────────────────────────────────────────────────

const isNumericText = v => /^[\s(]*[-+]?[\d,]*\.?\d+%?[\s)]*$/.test(String(v));

/**
 * The header row: among the first rows, the one with the most non-numeric
 * text cells. Rows directly above it that carry a few values (a year over a
 * run of months) are a "super header" whose value spans to the right, the
 * way a merged cell reads.
 */
function analyzeSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
  if (rows.length === 0) return null;
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);

  let headerIdx = 0;
  let best = -1;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const textCells = rows[r].filter(v => String(v).trim() && !isNumericText(v)).length;
    if (textCells > best) { best = textCells; headerIdx = r; }
  }

  let superIdx = null;
  if (headerIdx > 0) {
    const above = rows[headerIdx - 1];
    const filled = above.filter(v => String(v).trim()).length;
    if (filled > 0 && filled < width * 0.6) superIdx = headerIdx - 1;
  }

  let dataStart = headerIdx + 1;
  let dataEnd = rows.length; // exclusive; drop trailing empty rows
  while (dataEnd > dataStart && rows[dataEnd - 1].every(v => !String(v).trim())) dataEnd--;

  // One formula per column, from the first data row, made row-relative:
  // "=K3+J3" on row 3 becomes "K{r}+J{r}" — refs to other rows stay absolute.
  const excelRow = dataStart + 1;
  const formulaAt = c => {
    const cell = ws[`${XLSX.utils.encode_col(c)}${excelRow}`];
    return cell && cell.f
      ? cell.f.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g, (m, col, abs, row) => (Number(row) === excelRow && !abs ? `${col}{r}` : m))
      : null;
  };

  // A group header's span: exact when it is a merged cell; otherwise it runs
  // right until the next group value, a blank header, or — when the group
  // started on plain data columns — the first calculated column. Without that
  // last stop a "2026" over Jan–May also claimed the totals after it.
  const mergedSuper = new Map();
  if (superIdx !== null) {
    for (const m of ws['!merges'] || []) {
      if (m.s.r <= superIdx && m.e.r >= superIdx) {
        const v = String(rows[superIdx][m.s.c] ?? '').trim();
        for (let c = m.s.c; c <= m.e.c; c++) mergedSuper.set(c, v);
      }
    }
  }

  const columns = [];
  let carried = '';
  let carriedIsData = false;
  for (let c = 0; c < width; c++) {
    const letter = XLSX.utils.encode_col(c);
    const header = String(rows[headerIdx][c] ?? '').trim();
    const formula = formulaAt(c);
    let superVal = '';
    if (superIdx !== null) {
      const own = String(rows[superIdx][c] ?? '').trim();
      if (mergedSuper.has(c)) {
        superVal = mergedSuper.get(c);
        carried = '';
      } else if (own) {
        carried = own;
        carriedIsData = !formula;
        superVal = own;
      } else if (carried && header && !(carriedIsData && formula)) {
        superVal = carried;
      } else {
        carried = '';
      }
    }
    if (!header && !superVal && !formula) continue;
    columns.push({
      index: c,
      letter,
      header,
      label: superVal && header ? `${superVal} ${header}` : (header || superVal),
      formula,
    });
  }

  return { rows, width, headerIdx, superIdx, dataStart, dataEnd, columns };
}

function csvLine(cells) {
  return cells.map(v => {
    const s = String(v ?? '').trim();
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

function spreadsheetDigest(buffer, filename) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true, raw: false });
  const sheets = [];
  for (const name of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const a = analyzeSheet(wb.Sheets[name]);
    if (a) sheets.push({ name, ...a });
  }
  if (sheets.length === 0) throw new Error('The spreadsheet has no readable sheets');

  // The main sheet is the one with the most data — the one a "build me this"
  // request is about, and the one fillTemplate writes into.
  const main = sheets.reduce((m, s) => (s.dataEnd - s.dataStart > m.dataEnd - m.dataStart ? s : m), sheets[0]);

  const parts = [`Spreadsheet "${filename}" — ${sheets.length} sheet(s)${wb.SheetNames.length > MAX_SHEETS ? ` (first ${MAX_SHEETS} of ${wb.SheetNames.length})` : ''}. Main sheet: "${main.name}".`];
  let budget = DATA_BUDGET;
  for (const s of [main, ...sheets.filter(x => x !== main)]) {
    const dataRows = s.dataEnd - s.dataStart;
    parts.push('');
    parts.push(`## Sheet "${s.name}" — ${dataRows} data row(s) × ${s.columns.length} column(s). Header on row ${s.headerIdx + 1}${s.superIdx !== null ? ` (with a group header on row ${s.superIdx + 1} above it)` : ''}; data from row ${s.dataStart + 1}.`);
    parts.push('Columns (letter: label — formula when the column is calculated):');
    for (const c of s.columns) {
      parts.push(`- ${c.letter}: "${c.label}"${c.formula ? ` — formula =${c.formula.replace(/\{r\}/g, '')} (per row)` : ''}`);
    }
    // Data: the main sheet gets most of the budget, the rest share what's left.
    const share = s === main ? Math.floor(budget * 0.75) : Math.floor(budget / 2);
    const lines = [];
    let used = 0;
    for (let r = s.dataStart; r < s.dataEnd; r++) {
      const line = csvLine(s.columns.map(c => s.rows[r][c.index]));
      if (used + line.length + 1 > share) break;
      lines.push(line);
      used += line.length + 1;
    }
    budget -= used;
    if (lines.length > 0) {
      parts.push(`Data (CSV, columns in the order above${lines.length < dataRows ? `; first ${lines.length} of ${dataRows} rows` : ''}):`);
      parts.push(csvLine(s.columns.map(c => c.label)));
      parts.push(...lines);
    }
  }

  const meta = {
    mainSheet: main.name,
    sheets: sheets.map(s => ({
      name: s.name,
      headerRowIndex: s.headerIdx,
      superRowIndex: s.superIdx,
      dataStartIndex: s.dataStart,
      dataRowCount: s.dataEnd - s.dataStart,
      columns: s.columns,
    })),
  };
  return { digest: parts.join('\n'), meta };
}

// ── Documents, text, images ───────────────────────────────────────────────────

function capText(text) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  return t.length > TEXT_BUDGET ? `${t.slice(0, TEXT_BUDGET)}\n…(truncated — ${t.length} characters in total)` : t;
}

const TRANSCRIBE_PROMPT = `You transcribe a file a user attached to a business-data chat, so another model can work with it without seeing it.
Reproduce ALL of its content faithfully, in its original language — do not translate, summarize or comment.
- Tables: reproduce each as a markdown table with the exact column headers and every row. If headers span several rows (e.g. a year above months), combine them ("2025 Jan").
- Note any visible formulas or calculated columns (e.g. "Total = sum of the months").
- Other text: reproduce it as-is, keeping its structure (headings, lists).
Start with one line describing what the file is (e.g. "A supplier order-recommendation table, 99 rows").`;

async function transcribeWithVision(buffer, mediaType, isPdf, filename) {
  const source = { type: 'base64', media_type: mediaType, data: buffer.toString('base64') };
  const block = isPdf ? { type: 'document', source } : { type: 'image', source };
  const text = await llmService.sendOneShot(TRANSCRIBE_PROMPT, [block, { type: 'text', text: `File name: ${filename}` }], {
    model: VISION_MODEL,
    maxTokens: 8000,
    temperature: 0,
    context: 'chat_attachment_transcribe',
    stream: true,
  });
  return capText(text);
}

async function buildDigest(buffer, filename, mimeType, kind) {
  if (kind === 'spreadsheet') {
    const { digest, meta } = spreadsheetDigest(buffer, filename);
    return { digest, meta };
  }
  if (kind === 'pdf') {
    let text = '';
    try {
      text = (await require('pdf-parse')(buffer)).text || '';
    } catch { /* unreadable as text — fall through to vision */ }
    // A scanned PDF has no text layer: read it the way a person would.
    if (text.replace(/\s/g, '').length < 200) {
      return { digest: `PDF "${filename}" (scanned — transcribed):\n${await transcribeWithVision(buffer, 'application/pdf', true, filename)}`, meta: null };
    }
    return { digest: `PDF "${filename}":\n${capText(text)}`, meta: null };
  }
  if (kind === 'document') {
    const { value } = await require('mammoth').extractRawText({ buffer });
    return { digest: `Document "${filename}":\n${capText(value)}`, meta: null };
  }
  if (kind === 'image') {
    const mediaType = IMAGE_TYPES[extOf(filename)] || mimeType;
    return { digest: `Image "${filename}" (transcribed):\n${await transcribeWithVision(buffer, mediaType, false, filename)}`, meta: null };
  }
  return { digest: `Text file "${filename}":\n${capText(buffer.toString('utf8'))}`, meta: null };
}

// ── Store / read ─────────────────────────────────────────────────────────────

/**
 * Parse and store one uploaded file.
 * @returns {Promise<{id, filename, kind, sizeBytes, summary}>}
 */
async function createAttachment({ buffer, filename, mimeType, agentName, conversationId, userId }) {
  if (!buffer || buffer.length === 0) throw Object.assign(new Error('The file is empty'), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('The file is larger than 15 MB'), { status: 413 });
  const kind = detectKind(filename, mimeType);
  if (!kind) {
    throw Object.assign(new Error('This file type cannot be read. Supported: Excel / CSV, PDF, Word (.docx), text files and images.'), { status: 415 });
  }

  const { digest, meta } = await buildDigest(buffer, filename, mimeType, kind);
  const id = `att_${crypto.randomBytes(9).toString('hex')}`;
  await db.query(
    `INSERT INTO chat_attachments (id, agent_name, conversation_external_id, user_external_id, filename, mime_type, size_bytes, kind, digest, meta, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, agentName || null, conversationId || null, userId || null, filename, mimeType || null, buffer.length, kind, digest, meta ? JSON.stringify(meta) : null, buffer]
  );

  const main = meta?.sheets?.find(s => s.name === meta.mainSheet);
  const summary = main
    ? `${main.dataRowCount} rows × ${main.columns.length} columns`
    : `${digest.length.toLocaleString()} characters read`;
  return { id, filename, kind, sizeBytes: buffer.length, summary };
}

async function getAttachments(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id, filename, kind, digest, meta FROM chat_attachments WHERE id = ANY($1)`,
    [ids.slice(0, 5)]
  );
  // Keep the caller's order.
  return ids.map(id => rows.find(r => r.id === id)).filter(Boolean);
}

/**
 * The user's message as the model (and the saved history) sees it: their
 * text, then each attached file between markers. The instructions inside the
 * block are generic on purpose — the same file may be asked about, compared
 * against, or used as a template.
 */
async function composeMessage(message, attachmentIds, conversationId) {
  const files = await getAttachments(attachmentIds);
  if (files.length === 0) return message;
  // A file uploaded from the welcome screen has no conversation yet — it gets
  // one with the message that carries it.
  if (conversationId) {
    await db.query(
      `UPDATE chat_attachments SET conversation_external_id = $2 WHERE id = ANY($1) AND conversation_external_id IS NULL`,
      [files.map(f => f.id), conversationId]
    ).catch(() => {});
  }
  const blocks = files.map(f => {
    const isSheet = f.kind === 'spreadsheet';
    const guidance = [
      'The user attached this file. Work from THIS FILE\'s own data: answer about it, calculate from it, and build the tables they ask for out of it. '
        + 'Do NOT fetch from the business database unless the user explicitly asks for the system\'s data (e.g. to compare the file with it).',
      'Values inside the file (names, Hebrew labels) say nothing about the reply language — reply in the language of the user\'s own words.',
      ...(isSheet ? [
        `For anything listed, filtered, counted, totalled, averaged or calculated from this file, call query_attached_file with file_id "${f.id}" — it runs over EVERY row exactly. `
          + 'The data below may be only a sample, and numbers must never be computed by hand. '
          + 'To build a new table from the file (e.g. "like this, with X"), use its computed columns, select, group_by and sort.',
        'The resulting table can be viewed in full and downloaded under your answer, also in this file\'s own format (same headers and formulas) — mention it.',
      ] : []),
    ];
    return `${MARKER_OPEN} id="${f.id}" name="${f.filename.replace(/"/g, "'")}" kind="${f.kind}">>>\n${guidance.join('\n')}\n\n${f.digest}\n${MARKER_CLOSE}`;
  });
  return `${message}\n\n${blocks.join('\n\n')}`;
}

/**
 * Has this conversation got an attached spreadsheet? Then every data result
 * in it is a candidate for "download in the file's format", so the chat shows
 * the table viewer even for a small result it would otherwise print inline.
 */
async function conversationHasSpreadsheet(conversationId) {
  if (!conversationId) return false;
  const { rowCount } = await db.query(
    `SELECT 1 FROM chat_attachments WHERE conversation_external_id = $1 AND kind = 'spreadsheet' LIMIT 1`,
    [conversationId]
  );
  return rowCount > 0;
}

// ── Fill a spreadsheet back in its own structure ─────────────────────────────

const norm = s => String(s ?? '').replace(/["'`״׳]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * SheetJS writes formulas but no `<calcPr>`, so Excel would show the 0
 * placeholders until the user forces a recalculation. `fullCalcOnLoad` makes
 * Excel (and LibreOffice / Sheets) compute every formula when the file opens.
 * calcPr belongs after <sheets> / <definedNames> in the schema order.
 */
function forceRecalcOnOpen(xlsxBuffer) {
  const zip = XLSX.CFB.read(xlsxBuffer, { type: 'buffer' });
  const idx = zip.FullPaths.findIndex(p => /xl\/workbook\.xml$/.test(p));
  if (idx < 0) return xlsxBuffer;
  const entry = zip.FileIndex[idx];
  let xml = Buffer.from(entry.content).toString('utf8');
  if (/<calcPr\b/.test(xml)) {
    xml = xml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  } else {
    const anchor = xml.includes('</definedNames>') ? '</definedNames>' : '</sheets>';
    xml = xml.replace(anchor, `${anchor}<calcPr fullCalcOnLoad="1"/>`);
  }
  entry.content = Buffer.from(xml, 'utf8');
  return Buffer.from(XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer' }));
}

/**
 * Write `rows` (objects keyed by `columns`) into the attachment's main sheet:
 * header rows kept, old data removed, each template column filled from the
 * result column with the same label (or header), formula columns re-created
 * per row, result columns the template lacks appended on the right.
 * @returns {{ buffer: Buffer, filename: string, matched: string[], unmatched: string[] }}
 */
async function fillTemplate(id, { columns, rows }) {
  const { rows: found } = await db.query(`SELECT filename, kind, meta, content FROM chat_attachments WHERE id = $1`, [id]);
  const att = found[0];
  if (!att) throw Object.assign(new Error('Attachment not found'), { status: 404 });
  if (att.kind !== 'spreadsheet' || !att.meta) throw Object.assign(new Error('Only a spreadsheet can be filled'), { status: 400 });
  if (!Array.isArray(columns) || !Array.isArray(rows)) throw Object.assign(new Error('columns and rows are required'), { status: 400 });
  return fillWorkbook(att, { columns, rows });
}

/** The DB-free part of fillTemplate: `att` = { filename, meta, content }. */
function fillWorkbook(att, { columns, rows }) {
  const wb = XLSX.read(att.content, { type: 'buffer', cellFormula: true, cellStyles: true });
  const sheetMeta = att.meta.sheets.find(s => s.name === att.meta.mainSheet);
  const ws = wb.Sheets[sheetMeta.name];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  // Drop the template's own data rows (and anything below them).
  for (let r = sheetMeta.dataStartIndex; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) delete ws[XLSX.utils.encode_cell({ r, c })];
  }

  // Template column -> result column, by label first, then by the bare header
  // when that header is unique in the sheet (months repeat across years).
  const headerCounts = {};
  for (const c of sheetMeta.columns) headerCounts[norm(c.header)] = (headerCounts[norm(c.header)] || 0) + 1;
  const used = new Set();
  const mapping = new Map();
  for (const c of sheetMeta.columns) {
    if (c.formula) continue;
    const byLabel = columns.find(k => !used.has(k) && norm(k) === norm(c.label));
    const byHeader = !byLabel && headerCounts[norm(c.header)] === 1
      ? columns.find(k => !used.has(k) && norm(k) === norm(c.header))
      : null;
    const hit = byLabel || byHeader;
    if (hit) { mapping.set(c.index, hit); used.add(hit); }
  }
  // A result column named like one of the template's FORMULA columns is that
  // column (recomputed by its formula on every row) — not a new one to append.
  for (const c of sheetMeta.columns) {
    if (!c.formula) continue;
    const same = columns.find(k => !used.has(k) && (norm(k) === norm(c.label) || norm(k) === norm(c.header)));
    if (same) used.add(same);
  }
  const extra = columns.filter(k => !used.has(k));
  let nextCol = Math.max(range.e.c, ...sheetMeta.columns.map(c => c.index)) + 1;
  const extraCols = extra.map(k => {
    const index = nextCol++;
    ws[XLSX.utils.encode_cell({ r: sheetMeta.headerRowIndex, c: index })] = { t: 's', v: k };
    return { index, key: k };
  });

  const toCell = v => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return { t: 'n', v };
    const s = String(v);
    const n = Number(s.replace(/,/g, ''));
    return s.trim() !== '' && Number.isFinite(n) && /^[\s\-+\d.,]+$/.test(s) ? { t: 'n', v: n } : { t: 's', v: s };
  };

  rows.forEach((row, i) => {
    const r = sheetMeta.dataStartIndex + i;
    const excelRow = r + 1;
    for (const c of sheetMeta.columns) {
      const addr = XLSX.utils.encode_cell({ r, c: c.index });
      if (c.formula) {
        // SheetJS drops a formula cell that has no value, so it carries a 0
        // placeholder; forceRecalcOnOpen makes Excel compute the real one.
        ws[addr] = { t: 'n', v: 0, f: c.formula.replace(/\{r\}/g, excelRow) };
      } else if (mapping.has(c.index)) {
        const cell = toCell(row[mapping.get(c.index)]);
        if (cell) ws[addr] = cell;
      }
    }
    for (const x of extraCols) {
      const cell = toCell(row[x.key]);
      if (cell) ws[XLSX.utils.encode_cell({ r, c: x.index })] = cell;
    }
  });

  ws['!ref'] = XLSX.utils.encode_range({
    s: range.s,
    e: { r: Math.max(sheetMeta.dataStartIndex + rows.length - 1, sheetMeta.headerRowIndex), c: Math.max(nextCol - 1, range.e.c) },
  });

  // Only the main sheet: the others hold the template's own snapshot data
  // (e.g. a pivot of ITS open orders), which would contradict the new rows.
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, ws, sheetMeta.name);
  const buffer = forceRecalcOnOpen(XLSX.write(out, { type: 'buffer', bookType: 'xlsx', cellStyles: true }));

  const base = att.filename.replace(/\.[^.]+$/, '');
  return {
    buffer,
    filename: `${base} - ${new Date().toISOString().slice(0, 10)}.xlsx`,
    matched: [...mapping.values()],
    unmatched: extra,
  };
}

module.exports = {
  MAX_BYTES,
  MARKER_OPEN,
  MARKER_CLOSE,
  detectKind,
  spreadsheetDigest,
  createAttachment,
  getAttachments,
  composeMessage,
  conversationHasSpreadsheet,
  fillTemplate,
  fillWorkbook,
};
