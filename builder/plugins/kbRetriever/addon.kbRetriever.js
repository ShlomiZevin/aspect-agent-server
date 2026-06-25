/**
 * KB Retriever plugin — server side. Stage B of KB_V2.
 *
 * Adaptive RAG as a chain step. Two independent axes:
 *   - Trigger (when): 'always' | 'llm' (a prompt → fire/skip)
 *   - Query   (what): 'history' (last N) | 'llm' (rewrite convo → query)
 * Searches the selected KBs (Pinecone namespaces), writes the formatted
 * result (or the configured empty-sentinel) into an ephemeral named slot
 * (`brain.retrieval[NAME]`) that prompts inject via `{{kb:NAME}}`.
 *
 * The slot is recomputed every run; `onNoRetrieval` decides what happens
 * on a turn that retrieves nothing: 'clear' (write the sentinel) or
 * 'keep' (leave the previous result). Never persisted as memory.
 *
 * Each LLM step appends a LOCKED `outputContract` to its prompt so the
 * decider returns a clean yes/no and the rewriter returns only a query —
 * regardless of the conversation language. The contract is part of the
 * effective prompt surfaced in the debug card (no hidden behaviour).
 *
 * Does NOT call the talker LLM — its only LLM calls are the optional
 * trigger/query planners (each with its own model). See
 * docs/guides/KB_V2_RETRIEVER.md.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const descriptor = require('../../addons/kbRetriever.addon.json');
const kbService = require('../../../services/kb.pinecone.service');

const KB_RETRIEVER_PLUGIN_ID = descriptor.pluginId;

/** Format hits for prompt injection. `withScores` (structured) appends
 *  the relevance per chunk; plain text omits it. */
function formatHits(results, withScores) {
  if (!results.length) return '';
  const sections = results.map(r =>
    withScores
      ? `### From: ${r.fileName} (relevance: ${Number(r.score).toFixed(2)})\n${r.text}`
      : `### From: ${r.fileName}\n${r.text}`,
  );
  return `## Relevant Knowledge Base Content\nThe following excerpts are from the knowledge base. Use them to answer.\n\n${sections.join('\n\n')}`;
}

function modelIdOf(m) {
  if (!m) return null;
  return typeof m === 'string' ? m : (m.modelId || null);
}

/** Join the author prompt with the locked format contract. The contract
 *  is what guarantees a parseable answer, so it's always appended. */
function withContract(prompt, contract) {
  const p = (prompt || '').trim();
  const c = (contract || '').trim();
  if (!c) return p;
  return p ? `${p}\n\n${c}` : c;
}

/** Robust yes-detection. With the contract appended the model should
 *  reply a bare English "yes"/"no"; we also accept a few common
 *  affirmatives (incl. Hebrew כן, true) so a stray language slip doesn't
 *  silently read as "no". Anything else → no. */
function isAffirmative(ans) {
  const s = (ans || '').trim().toLowerCase();
  if (/\bno\b|^n\b|\blo\b|\bלא\b|\bfalse\b/.test(s)) return false;
  return /\byes\b|^y\b|\btrue\b|\bכן\b/.test(s);
}

/** Slice the (full) history per a step's own HistoryMode. The addon's
 *  context.history is 'all', so each LLM step controls how much IT sees.
 *  'none' = the step sees ONLY the current user message (passed to the
 *  LLM separately) — i.e. "current message only". */
function sliceHistory(msgs, h) {
  if (!Array.isArray(msgs)) return [];
  if (!h || !h.mode) return msgs;
  if (h.mode === 'none') return [];
  if (h.mode === 'last_n') return msgs.slice(-(Number(h.n) || 5));
  return msgs; // all | full | since_*
}

/** One-line label for a step's history setting (for the debug card). */
function describeHistory(h) {
  if (!h || !h.mode || h.mode === 'all' || h.mode === 'full') return 'full conversation';
  if (h.mode === 'none') return 'current message only';
  if (h.mode === 'last_n') return `last ${Number(h.n) || 5} messages`;
  return h.mode;
}

async function run(ctx) {
  const { instance, userMessage, historyMessages, llm } = ctx;
  const agentName = ctx.agentNameForLogs;
  const crewMember = ctx.usageCrew || ctx.crewLabel;
  const conversationId = ctx.conversationId;
  const userId = ctx.ownerUserId;
  const start = Date.now();

  const cfg = instance.config || {};
  // Slot = where we write / what {{kb:NAME}} reads. `name` is the addon
  // label; `domain` is the slot (older configs used `name`).
  const name = (cfg.domain || cfg.name || 'knowledge').trim();
  const kbNamespaces = Array.isArray(cfg.kbNamespaces) ? cfg.kbNamespaces : [];
  const topK = Number(cfg.topK) || 5;
  const minScore = Number.isFinite(Number(cfg.minScore)) ? Number(cfg.minScore) : 0.3;
  const maxTokens = Number(cfg.maxTokens) || 3000;
  const structured = cfg.format === 'structured';
  const emptyText = cfg.emptyText || 'No relevant information was found in the knowledge base.';
  const keepOnEmpty = cfg.onNoRetrieval === 'keep';
  const trigger = cfg.trigger || { mode: 'always' };
  const query = cfg.query || { mode: 'history', n: 1 };

  // Slot write helpers. On "no retrieval": keep → no write (leave prior);
  // clear → write the sentinel so {{kb:NAME}} reads "no data".
  const writeSlot = value => [{ kind: 'retrieval', name, value }];
  const emptySlot = () => (keepOnEmpty ? [] : [{ kind: 'retrieval', name, value: emptyText }]);
  const writtenInfo = (action, chars) => ({ slot: name, action, chars });

  // The step trail surfaced in the debug card. Every step that ran is
  // pushed in order so the card reads top-to-bottom like the engine ran.
  const steps = [];

  // Assemble the final card. `written` describes what landed in the
  // {{kb:NAME}} slot; `steps` is the ordered trail.
  const card = (base, written) => ({
    // rawOutput stays small + readable (used for copy + any generic
    // renderer): just the headline metadata, never the chunk bodies.
    rawOutput: JSON.stringify({
      slot: name, fired: base.fired, query: base.query ?? null,
      hitCount: base.hitCount ?? 0, queryTimeMs: base.queryTimeMs ?? 0,
    }),
    parsedOutput: { kb: name, steps, written, ...base },
    durationMs: Date.now() - start,
    tokens: { input: 0, output: 0, total: 0 },
  });

  // ── 1. Trigger: should we retrieve this turn? ──
  if (trigger.mode === 'llm') {
    const prompt = withContract(trigger.prompt, trigger.outputContract);
    const raw = await llm.sendOneShot(prompt, userMessage, {
      model: modelIdOf(trigger.model), historyMessages: sliceHistory(historyMessages, trigger.history),
      context: 'kb-trigger', agentName, crewMember, conversationId: String(conversationId), userId,
    });
    const ans = (typeof raw === 'string' ? raw : (raw && raw.text) || '').trim();
    const fired = isAffirmative(ans);
    steps.push({
      id: 'trigger', title: 'When to retrieve', summary: `LLM decided: ${fired ? 'YES' : 'NO'}`,
      llm: { model: modelIdOf(trigger.model), history: describeHistory(trigger.history), prompt, output: ans },
    });
    if (!fired) {
      const written = keepOnEmpty ? writtenInfo('kept', null) : writtenInfo('cleared', emptyText.length);
      return { ...card({ fired: false, query: null, hitCount: 0 }, written), memoryWrites: emptySlot() };
    }
  } else {
    steps.push({ id: 'trigger', title: 'When to retrieve', summary: 'Every turn' });
  }

  // ── 2. Query: what do we ask? ──
  let queryText = userMessage || '';
  if (query.mode === 'llm') {
    const prompt = withContract(query.prompt, query.outputContract);
    const raw = await llm.sendOneShot(prompt, userMessage, {
      model: modelIdOf(query.model), historyMessages: sliceHistory(historyMessages, query.history),
      context: 'kb-query', agentName, crewMember, conversationId: String(conversationId), userId,
    });
    const q = (typeof raw === 'string' ? raw : (raw && raw.text) || '').trim();
    if (q) queryText = q;
    steps.push({
      id: 'query', title: 'What to ask', summary: 'LLM rewrote the conversation into a query',
      llm: { model: modelIdOf(query.model), history: describeHistory(query.history), prompt, output: q || '(empty)' },
    });
  } else {
    const n = Math.max(1, Number(query.n) || 1);
    if (n > 1 && Array.isArray(historyMessages) && historyMessages.length) {
      const tail = historyMessages.slice(-(n - 1)).map(m => m && m.content).filter(Boolean);
      queryText = [...tail, userMessage].filter(Boolean).join('\n');
    }
    steps.push({ id: 'query', title: 'What to ask', summary: `Last ${n} message${n === 1 ? '' : 's'} (verbatim)` });
  }

  // ── 3. Retrieve ──
  if (!kbNamespaces.length || !queryText.trim()) {
    const note = !kbNamespaces.length ? 'No knowledge base selected' : 'Empty query';
    steps.push({ id: 'search', title: 'Search', summary: note, error: true });
    const written = keepOnEmpty ? writtenInfo('kept', null) : writtenInfo('cleared', emptyText.length);
    return { ...card({ fired: true, query: queryText, hitCount: 0, note }, written), memoryWrites: emptySlot() };
  }

  let results = [];
  let queryTimeMs = 0;
  try {
    const r = await kbService.query(kbNamespaces, queryText, { topK, scoreThreshold: minScore, maxTokens });
    results = Array.isArray(r.results) ? r.results : [];
    queryTimeMs = r.queryTimeMs || 0;
  } catch (err) {
    steps.push({ id: 'search', title: 'Search', summary: `Error: ${err.message}`, error: true });
    const written = keepOnEmpty ? writtenInfo('kept', null) : writtenInfo('cleared', emptyText.length);
    return { ...card({ fired: true, query: queryText, hitCount: 0, error: err.message }, written), memoryWrites: emptySlot(), parseError: err.message };
  }

  const hits = results.map(h => ({
    fileName: h.fileName, score: h.score, chunkIndex: h.chunkIndex, namespace: h.namespace, text: h.text,
  }));
  steps.push({
    id: 'search', title: 'Search',
    summary: `${results.length} chunk${results.length === 1 ? '' : 's'} from ${kbNamespaces.length} KB${kbNamespaces.length === 1 ? '' : 's'} in ${queryTimeMs}ms`,
    namespaces: kbNamespaces, topK, minScore,
  });

  // ── 4. Write the slot (or clear/keep on empty) + emit the card ──
  let written;
  let memoryWrites;
  if (results.length) {
    const value = formatHits(results, structured);
    memoryWrites = writeSlot(value);
    written = writtenInfo('set', value.length);
  } else {
    memoryWrites = emptySlot();
    written = keepOnEmpty ? writtenInfo('kept', null) : writtenInfo('cleared', emptyText.length);
  }

  return {
    ...card({ fired: true, query: queryText, hitCount: results.length, queryTimeMs, hits }, written),
    memoryWrites,
  };
}

registerPlugin({
  id: descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  // The retriever resolves its own (optional) trigger/query models from
  // config — it has no top-level config.model, so skip the engine's
  // "no model configured" guard (Direct mode needs no model at all).
  requiresModel: false,
  run,
});

module.exports = { KB_RETRIEVER_PLUGIN_ID };
