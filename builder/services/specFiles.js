/**
 * Reading builder-only material (never sent to the running agent) —
 * shared by Alfred's project summary and the Builder's AI door, so the
 * two can never disagree:
 *   - files attached to the agent's Spec (task #870)
 *   - notes + files on each Targeted KB (task #871)
 * Writes live in builder/routes/specRoute.js.
 */

const { eq, and, asc } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { builderSpecFiles, builderTkbNotes } = require('../../db/schema');

async function listSpecFiles(agentId) {
  if (!agentId) return [];
  return db.getDrizzle().select().from(builderSpecFiles)
    .where(and(eq(builderSpecFiles.agentId, agentId), eq(builderSpecFiles.scope, 'spec')))
    .orderBy(asc(builderSpecFiles.createdAt));
}

/**
 * The files as prose for an AI reader: name, then the text extracted from
 * it. `maxCharsPerFile` keeps one long document from crowding out the rest
 * of the context; 0 = no cap.
 */
function renderSpecFiles(files, { maxCharsPerFile = 0 } = {}) {
  return files.map(f => {
    const text = String(f.extractedText || '').trim();
    const body = !text
      ? '(no readable text — the person can open the original in the Builder)'
      : maxCharsPerFile > 0 && text.length > maxCharsPerFile
        ? `${text.slice(0, maxCharsPerFile)}\n…[cut — ${text.length - maxCharsPerFile} more characters]`
        : text;
    return `### 📎 ${f.fileName}\n${body}`;
  }).join('\n\n');
}

/**
 * Notes + files of every Targeted KB of an agent that has any, as prose.
 * `enums` (the agent body's) supplies names; a note on a KB that has since
 * been deleted is skipped. '' when there is nothing.
 */
async function renderTkbNotes(agentId, enums, { maxCharsPerFile = 0, maxNoteChars = 0 } = {}) {
  if (!agentId) return '';
  const d = db.getDrizzle();
  const notes = await d.select().from(builderTkbNotes).where(eq(builderTkbNotes.agentId, agentId));
  const files = await d.select().from(builderSpecFiles)
    .where(and(eq(builderSpecFiles.agentId, agentId), eq(builderSpecFiles.scope, 'tkb')))
    .orderBy(asc(builderSpecFiles.createdAt));
  const byId = new Map((Array.isArray(enums) ? enums : []).map(e => [e.id, e]));
  const blocks = [];
  for (const e of byId.values()) {
    const note = (notes.find(n => n.enumId === e.id)?.notes || '').trim();
    const mine = files.filter(f => f.refId === e.id);
    if (!note && mine.length === 0) continue;
    const noteText = maxNoteChars > 0 && note.length > maxNoteChars
      ? `${note.slice(0, maxNoteChars)}\n…[cut — ${note.length - maxNoteChars} more characters]`
      : note;
    blocks.push([
      `### Targeted KB "${e.name}"`,
      ...(noteText ? [noteText] : []),
      ...(mine.length ? [renderSpecFiles(mine, { maxCharsPerFile })] : []),
    ].join('\n\n'));
  }
  return blocks.join('\n\n');
}

module.exports = { listSpecFiles, renderSpecFiles, renderTkbNotes };
