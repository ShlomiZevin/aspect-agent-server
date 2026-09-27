/**
 * Reading an agent's Spec files (task #870) — shared by Alfred's project
 * summary and the Builder's AI door, so the two can never disagree about
 * what the Spec says. Writes live in builder/routes/specRoute.js.
 */

const { eq, asc } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { builderSpecFiles } = require('../../db/schema');

async function listSpecFiles(agentId) {
  if (!agentId) return [];
  return db.getDrizzle().select().from(builderSpecFiles)
    .where(eq(builderSpecFiles.agentId, agentId))
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

module.exports = { listSpecFiles, renderSpecFiles };
