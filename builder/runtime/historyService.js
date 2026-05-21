/**
 * historyService — pull message history per an addon's
 * `context.history` config.
 *
 * Returns an array of `{ role, content }` shaped messages the LLM
 * provider can ingest. The provider-specific transformation (Claude
 * vs OpenAI vs Gemini) is done downstream by llm.js / per-provider
 * adapters; we just supply the raw chronological list.
 *
 * History modes (mirror client HistoryMode):
 *   - 'none'   → []
 *   - 'last_n' → last N (default 5) ordered oldest→newest
 *   - 'full'   → entire conversation, oldest→newest
 */

const db = require('../../services/db.pg');
const { messages } = require('../../db/schema');
const { eq, asc } = require('drizzle-orm');

function drizzle() {
  return db.getDrizzle();
}

async function loadHistory({ conversationId, historyMode }) {
  const mode = historyMode?.mode || 'none';
  if (mode === 'none') return [];

  const all = await drizzle().select()
    .from(messages)
    .where(eq(messages.conversationId, Number(conversationId)))
    .orderBy(asc(messages.createdAt));

  // The most recently inserted user message is the "current turn".
  // BuilderRunner passes it as `userMessage` separately, so we drop
  // the trailing user message from history to avoid duplicating it.
  const trimmed = all.length > 0 && all[all.length - 1].role === 'user'
    ? all.slice(0, -1)
    : all;

  const formatted = trimmed.map(m => ({ role: m.role, content: m.content }));

  if (mode === 'full') return formatted;

  // last_n: take the last N. Default 5 matches the client default.
  const n = Math.max(0, Math.floor(historyMode?.n ?? 5));
  return formatted.slice(-n);
}

module.exports = { loadHistory };
