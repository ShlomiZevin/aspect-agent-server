/**
 * Alfred pinned files — attachments for the Builder Chat.
 *
 * A file is PINNED to the Alfred conversation: present for the whole
 * chat (chips in the UI, removable), included in every brainstorm turn
 * and in Apply generation, and — because pins live in the chat's
 * metadata, not in messages — never consumed by the ✅ Applied marker
 * slice.
 *
 * Storage: NO bucket and NO new table.
 *   - PDFs + images  → uploaded once to the Anthropic Files API and
 *     referenced by file id afterwards (also served back for the
 *     "click to open" chip via the content route).
 *   - docx / xlsx / csv / txt / md → extracted to text (the API has no
 *     native block for them — extraction is the only door) and the
 *     text kept on the pin entry in `conversations.metadata`.
 *
 * Delivery per brain:
 *   - Brainstorm: document blocks (PDF) + image blocks (images) +
 *     labeled extracted text — every turn while pinned.
 *   - Consolidator: a names-only note (contents go to the generator).
 *   - Patch generator: PDFs as document blocks via sendOneShot's
 *     existing `knowledgeBase.anthropicFileIds` path + extracted texts
 *     inline. Images are CHAT-ONLY in v1 (no image path in oneshot).
 *
 * The SUPPORTED table and friendly unsupported-format messages are
 * adapted from hq/services/worker-files.service.js — copied, not
 * imported: the product must not import from hq/ (see server CLAUDE.md
 * import rule).
 */

const path = require('path');
const crypto = require('crypto');
const chunker = require('../../services/kb.chunker.service');
const anthropicFiles = require('../../services/kb.anthropic.service');
const alfredChats = require('./alfredChats');

const MAX_BYTES = 25 * 1024 * 1024;

const SUPPORTED = [
  { ext: 'pdf',  mime: 'application/pdf', as: 'document', label: 'PDF' },
  { ext: 'txt',  mime: 'text/plain',      as: 'text',     label: 'Text' },
  { ext: 'md',   mime: 'text/markdown',   as: 'text',     label: 'Markdown' },
  { ext: 'csv',  mime: 'text/csv',        as: 'text',     label: 'CSV' },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', as: 'text', label: 'Word' },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       as: 'text', label: 'Excel' },
  { ext: 'xls',  mime: 'application/vnd.ms-excel', as: 'text', label: 'Excel' },
  { ext: 'png',  mime: 'image/png',       as: 'image',    label: 'PNG' },
  { ext: 'jpg',  mime: 'image/jpeg',      as: 'image',    label: 'JPEG' },
  { ext: 'jpeg', mime: 'image/jpeg',      as: 'image',    label: 'JPEG' },
  { ext: 'webp', mime: 'image/webp',      as: 'image',    label: 'WebP' },
];

const KNOWN_UNSUPPORTED = {
  pptx: 'PowerPoint. Export it to PDF and attach that — the layout survives.',
  ppt:  'PowerPoint. Export it to PDF and attach that.',
  doc:  'the old Word format. Save it as .docx or PDF.',
  key:  'Keynote. Export it to PDF.',
};

function typeOf(filename, mimeType) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  const hit = SUPPORTED.find(s => s.ext === ext) || SUPPORTED.find(s => s.mime === mimeType);
  if (hit) return hit;
  const why = KNOWN_UNSUPPORTED[ext];
  const list = [...new Set(SUPPORTED.map(s => s.label))].join(', ');
  throw new Error(
    why
      ? `.${ext} is ${why}`
      : `.${ext || mimeType} is not a supported attachment. Supported: ${list}.`,
  );
}

/** Rough but honest — what the file weighs per message once pinned. */
function estimateTokens(text, isImage, bytes) {
  if (isImage) return Math.round((bytes || 0) / 750);
  return Math.ceil((text || '').length / 4);
}

/** The presented (client-safe) shape — never carries the extracted text. */
function present(entry) {
  if (!entry) return entry;
  const { extractedText, ...rest } = entry;
  return { ...rest, hasText: !!extractedText };
}

async function readPins(chatId) {
  const chat = await alfredChats.getChat(chatId);
  if (!chat) throw new Error('Chat not found');
  const pins = chat.metadata && Array.isArray(chat.metadata.alfredFiles)
    ? chat.metadata.alfredFiles
    : [];
  return { chat, pins };
}

async function writePins(chatId, pins) {
  await alfredChats.updateChatMetadata(chatId, meta => ({ ...meta, alfredFiles: pins }));
}

/**
 * Ingest one upload: detect type, extract text (non-images), upload
 * PDFs/images to the Anthropic Files API, pin the entry to the chat.
 */
async function addFile({ chatId, buffer, filename, mimeType }) {
  if (!buffer || !buffer.length) throw new Error('That file is empty');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`That file is ${(buffer.length / 1048576).toFixed(1)}MB; the limit is 25MB`);
  }
  const type = typeOf(filename, mimeType);
  const isImage = type.as === 'image';

  let extractedText = null;
  if (!isImage) {
    try {
      const out = await chunker.extractText(buffer, filename, type.mime);
      extractedText = ((out && out.text) || '').trim() || null;
    } catch (err) {
      // A PDF that won't extract still works as a document block —
      // Claude reads the pages itself. Non-PDF text types NEED the
      // extraction; surface a real error for those.
      if (type.as !== 'document') {
        throw new Error(`Could not read ${filename}: ${err.message}`);
      }
      console.error('[alfred-files] extraction failed (pdf, non-fatal):', filename, err.message);
    }
  }

  // PDFs + images go to the Files API once, referenced by id after.
  let anthropicFileId = null;
  if (type.as === 'document' || isImage) {
    const up = await anthropicFiles.uploadFile(buffer, filename, type.mime);
    anthropicFileId = (up && (up.fileId || up.id)) || null;
    if (!anthropicFileId) throw new Error('Upload to the model provider failed — try again.');
  }

  const entry = {
    id: 'af_' + crypto.randomBytes(6).toString('hex'),
    name: filename,
    mime: type.mime,
    as: type.as,                      // 'document' | 'text' | 'image'
    bytes: buffer.length,
    anthropicFileId,
    extractedText,
    tokenEstimate: estimateTokens(extractedText, isImage, buffer.length),
    addedAt: new Date().toISOString(),
  };

  const { pins } = await readPins(chatId);
  const next = [...pins, entry];
  await writePins(chatId, next);
  return { file: present(entry), files: next.map(present) };
}

async function listFiles(chatId) {
  const { pins } = await readPins(chatId);
  return pins.map(present);
}

/** Full entries, extracted text included — for building model context. */
async function forContext(chatId) {
  const { pins } = await readPins(chatId);
  return pins;
}

async function removeFile(chatId, fileId) {
  const { pins } = await readPins(chatId);
  const entry = pins.find(p => p.id === fileId);
  if (!entry) throw new Error('No such pinned file');
  await writePins(chatId, pins.filter(p => p.id !== fileId));
  if (entry.anthropicFileId) {
    await anthropicFiles.deleteFile(entry.anthropicFileId).catch(() => {});
  }
  return { ok: true };
}

function getFile(pins, fileId) {
  return pins.find(p => p.id === fileId) || null;
}

// ─── Delivery builders ─────────────────────────────────────────────

/**
 * Content blocks for the brainstorm call — attached to the current
 * user turn every turn while pinned. Returns [] when nothing is
 * pinned so callers can skip the work.
 */
function buildBrainstormBlocks(pins) {
  const blocks = [];
  for (const p of pins) {
    if (p.as === 'document' && p.anthropicFileId) {
      blocks.push({ type: 'document', source: { type: 'file', file_id: p.anthropicFileId } });
    } else if (p.as === 'image' && p.anthropicFileId) {
      blocks.push({ type: 'image', source: { type: 'file', file_id: p.anthropicFileId } });
    }
  }
  const texts = pins.filter(p => p.as === 'text' && p.extractedText);
  if (texts.length > 0) {
    blocks.push({
      type: 'text',
      text: texts.map(p => `## Pinned file: ${p.name}\n${p.extractedText}`).join('\n\n'),
    });
  }
  return blocks;
}

/** One-line system-prompt note so the model knows the pins exist. */
function pinnedNote(pins) {
  if (!pins.length) return '';
  return '\n\n# Pinned files in this chat\n'
    + pins.map(p => `- ${p.name} (${p.as})`).join('\n')
    + '\nTheir contents are attached to the latest user message. Treat an '
    + 'attached spec as the source of truth over your own assumptions.';
}

/**
 * What the patch generator can receive, plus the honest "Based on"
 * list for the Apply preview: delivery per file is
 * 'document' (native block) | 'text' (extracted) | 'chat-only'
 * (images — visible in brainstorm, not deliverable to generation v1).
 */
function attachmentsForGenerator(pins) {
  const anthropicFileIds = pins
    .filter(p => p.as === 'document' && p.anthropicFileId)
    .map(p => p.anthropicFileId);
  const texts = pins
    .filter(p => p.as !== 'image' && p.extractedText && p.as !== 'document')
    .map(p => ({ name: p.name, text: p.extractedText }));
  const basedOn = pins.map(p => ({
    name: p.name,
    delivery: p.as === 'document' ? 'document' : (p.as === 'text' ? 'text' : 'chat-only'),
  }));
  return { anthropicFileIds, texts, basedOn };
}

module.exports = {
  MAX_BYTES,
  SUPPORTED,
  typeOf,
  addFile,
  listFiles,
  forContext,
  removeFile,
  getFile,
  buildBrainstormBlocks,
  pinnedNote,
  attachmentsForGenerator,
};
