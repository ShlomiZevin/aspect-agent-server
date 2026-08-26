/**
 * HQ — files a worker is given.
 *
 * The HQ library is retrieval: she searches it when she needs a fact, and may
 * not. This is the opposite — a small curated set that is ALWAYS in front of
 * her. Brand guidelines, tone of voice, an example of what good looks like.
 *
 * Two scopes:
 *   briefcase     — attached to her job description, present in every message
 *   conversation  — attached to one chat, present for that whole chat
 *
 * How each type reaches the model matters:
 *   PDF    → a native Anthropic document block, so she sees real pages and
 *            layout rather than flattened text. Uploaded to the Files API once
 *            and referenced by id afterwards.
 *   images → image blocks, and optionally registered with Leonardo so brand
 *            colour is matched rather than described.
 *   docs   → extracted to text. Word and Excel have no native block, and text
 *            is what they are anyway.
 *
 * Extracted text is kept for everything, because the voice model cannot read
 * Claude document blocks and has to be briefed in plain prose.
 */

const path = require('path');
const db = require('../../services/db.pg');
const chunker = require('../../services/kb.chunker.service');
const anthropicFiles = require('../../services/kb.anthropic.service');
const media = require('./media.service');
const leonardo = require('./leonardo.service');

/**
 * What can be attached, and how each is carried.
 *
 * Shown in the UI before anyone picks a file — an upload that fails after the
 * fact is a worse experience than a list that says what works up front.
 */
const SUPPORTED = [
  { ext: 'pdf',  mime: 'application/pdf', as: 'document', label: 'PDF' },
  { ext: 'txt',  mime: 'text/plain',      as: 'text',     label: 'Text' },
  { ext: 'md',   mime: 'text/markdown',   as: 'text',     label: 'Markdown' },
  { ext: 'csv',  mime: 'text/csv',        as: 'text',     label: 'CSV' },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', as: 'text', label: 'Word' },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       as: 'text', label: 'Excel' },
  { ext: 'png',  mime: 'image/png',       as: 'image',    label: 'PNG' },
  { ext: 'jpg',  mime: 'image/jpeg',      as: 'image',    label: 'JPEG' },
  { ext: 'jpeg', mime: 'image/jpeg',      as: 'image',    label: 'JPEG' },
  { ext: 'webp', mime: 'image/webp',      as: 'image',    label: 'WebP' },
];

/**
 * A PowerPoint deck is the commonest brand-guidelines format and is NOT
 * readable, so it gets a real answer rather than a generic refusal.
 */
const KNOWN_UNSUPPORTED = {
  pptx: 'PowerPoint. Export it to PDF and attach that — the layout survives and she can read it.',
  ppt: 'PowerPoint. Export it to PDF and attach that.',
  doc: 'the old Word format. Save it as .docx or PDF.',
  key: 'Keynote. Export it to PDF.',
  ai: 'an Illustrator file. Export a PNG or PDF.',
  psd: 'a Photoshop file. Export a PNG.',
};

const MAX_BYTES = 25 * 1024 * 1024;

function typeOf(filename, mimeType) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  const hit = SUPPORTED.find(s => s.ext === ext) || SUPPORTED.find(s => s.mime === mimeType);
  if (hit) return hit;

  const why = KNOWN_UNSUPPORTED[ext];
  const list = [...new Set(SUPPORTED.map(s => s.label))].join(', ');
  throw new Error(
    why
      ? `.${ext} is ${why}`
      : `.${ext || mimeType} is not something she can read. Supported: ${list}.`
  );
}

/** Rough but honest — enough to show what a file weighs before it costs money. */
function estimateTokens(text, isImage, bytes) {
  if (isImage) return Math.round((bytes || 0) / 750);
  return Math.ceil((text || '').length / 4);
}

/**
 * Take a file in and make it usable.
 *
 * Everything slow or fallible — extraction, two uploads — happens here once,
 * rather than on the turn where she actually needs it.
 */
async function add(buffer, {
  workerId, conversationId = null, filename, mimeType, label = null, kind = null,
} = {}) {
  if (!buffer || !buffer.length) throw new Error('That file is empty');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`That file is ${(buffer.length / 1048576).toFixed(1)}MB; the limit is 25MB`);
  }

  const type = typeOf(filename, mimeType);
  const isImage = type.as === 'image';

  // Text for everything readable: the token estimate needs it, and the voice
  // model can only be briefed in prose. An image has none, which is fine.
  let text = null;
  if (!isImage) {
    try {
      const out = await chunker.extractText(buffer, filename, type.mime);
      text = ((out && out.text) || '').trim() || null;
    } catch (err) {
      // A PDF that will not extract can still go as a document block — Claude
      // reads the pages itself. Only the voice briefing loses out.
      console.error('[worker-files] extraction failed', filename, err.message);
    }
  }

  // PDFs go to Anthropic once and are referenced by id after that, so the bytes
  // are not re-sent on every turn of a long job.
  let anthropicFileId = null;
  if (type.as === 'document') {
    try {
      const up = await anthropicFiles.uploadFile(buffer, filename, type.mime);
      anthropicFileId = (up && (up.fileId || up.id)) || null;
    } catch (err) {
      console.error('[worker-files] Anthropic upload failed', filename, err.message);
    }
  }

  // Our own copy, so the file survives independently of a provider's retention.
  const stored = await media.store(buffer, {
    workerId,
    conversationId,
    title: (label && label.trim()) || filename,
    kind: isImage ? 'image' : 'document',
    mimeType: type.mime,
    extension: path.extname(filename).slice(1).toLowerCase() || 'bin',
    source: 'upload',
    // Marks this as something she was GIVEN, so the Media gallery can keep
    // showing only what she made.
    metadata: { role: 'given', briefcase: !conversationId },
  }).catch(err => {
    console.error('[worker-files] GCS store failed', filename, err.message);
    return null;
  });

  const { rows } = await db.query(
    `INSERT INTO hq_worker_files
       (worker_id, conversation_id, kind, label, filename, mime_type, bytes,
        gcs_path, anthropic_file_id, extracted_text, token_estimate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      workerId, conversationId,
      kind || (isImage ? 'reference' : 'instructions'),
      (label && label.trim()) || null,
      filename, type.mime, buffer.length,
      (stored && stored.gcs_path) || null,
      anthropicFileId, text,
      estimateTokens(text, isImage, buffer.length),
    ]
  );
  return present(rows[0]);
}

/** Never send the extracted text to the browser — it can be a whole book. */
function present(row) {
  if (!row) return row;
  const copy = { ...row };
  copy.has_text = !!copy.extracted_text;
  delete copy.extracted_text;
  return copy;
}

/** Rows as stored, text included — for building context. Never for the client. */
async function forContext({ workerId, conversationId = null } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM hq_worker_files
      WHERE worker_id = $1
        AND active
        AND (conversation_id IS NULL OR conversation_id = $2)
      ORDER BY conversation_id NULLS FIRST, id`,
    [workerId, conversationId]
  );
  return rows;
}

async function list({ workerId, conversationId = null } = {}) {
  const where = conversationId
    ? 'worker_id = $1 AND conversation_id = $2'
    : 'worker_id = $1 AND conversation_id IS NULL';
  const { rows } = await db.query(
    `SELECT * FROM hq_worker_files WHERE ${where} ORDER BY id`,
    conversationId ? [workerId, conversationId] : [workerId]
  );
  return rows.map(present);
}

async function remove(id) {
  const { rows } = await db.query(
    `DELETE FROM hq_worker_files WHERE id = $1 RETURNING anthropic_file_id`, [id]);
  const fileId = rows[0] && rows[0].anthropic_file_id;
  if (fileId) await anthropicFiles.deleteFile(fileId).catch(() => {});
  return { ok: true };
}

/**
 * Edit a file after the fact.
 *
 * `active` is off-rather-than-deleted, for a guide you are between versions of.
 * `label` is added here rather than at upload time: naming a file before it
 * exists is an extra step in front of the thing you actually came to do.
 *
 * Only the keys passed are touched, so setting one cannot clear the other.
 */
async function update(id, { active, label } = {}) {
  const sets = [];
  const params = [id];
  if (active !== undefined) { params.push(!!active); sets.push(`active = $${params.length}`); }
  if (label !== undefined) {
    params.push((label && label.trim()) || null);
    sets.push(`label = $${params.length}`);
  }
  if (!sets.length) return null;

  const { rows } = await db.query(
    `UPDATE hq_worker_files SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return present(rows[0]);
}

/**
 * Register an image with Leonardo so it can steer a generation.
 *
 * Lazy and then cached on the row: most reference images are never used this
 * way, and uploading on every generate would be waste.
 */
async function leonardoReference(id) {
  const { rows } = await db.query(`SELECT * FROM hq_worker_files WHERE id = $1`, [id]);
  const file = rows[0];
  if (!file) throw new Error('No such file');
  if (file.leonardo_ref_id) return file.leonardo_ref_id;
  if (!String(file.mime_type).startsWith('image/')) {
    throw new Error('Only an image can be a visual reference');
  }

  const buffer = await media.download(file.gcs_path);
  const refId = await leonardo.uploadReference(buffer, file.filename);
  await db.query(`UPDATE hq_worker_files SET leonardo_ref_id = $2 WHERE id = $1`, [id, refId]);
  return refId;
}

module.exports = {
  SUPPORTED, KNOWN_UNSUPPORTED, MAX_BYTES,
  add, list, forContext, remove, update, leonardoReference,
};
