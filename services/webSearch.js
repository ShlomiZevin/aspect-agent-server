/**
 * Web search (task #967) — the shared bits of the Talker / Thinker
 * "Web search" switch. The search itself is each provider's own built-in
 * tool (OpenAI Responses `web_search`, Anthropic server tool `web_search`);
 * there is no search engine or key of ours.
 *
 * Config on the addon (`config.webSearch`, see builder/types/index.ts):
 *   { enabled: boolean, allowedDomains?: string[], maxSearches?: number }
 *
 * The switch alone does NOT let the model search (Noa's review of #967):
 * with it on, the runtime appends WEB_SEARCH_RULE to the add-on's prompt —
 * search only where the builder's prompt allows it. Off = no tool at all.
 * A turn that does not search pays no search fee (only the tool
 * description sent with the request).
 *
 * Events the providers yield into the stream (and, for a one-shot call,
 * hand to `options.onWebSearch`):
 *   { type: 'web_search', phase: 'started', id, query|null }
 *   { type: 'web_search', phase: 'done', id, query|null, kind, sources: [{ url, title|null }], error? }
 * and on the final `{ type: 'usage' }` chunk / one-shot `usage`:
 *   webSearches: <number of searches billed>, webCitations: [{ url, title }]
 */

const DEFAULT_MAX_SEARCHES = 3;
const MAX_MAX_SEARCHES = 10;
const MAX_DOMAINS = 20;

/** "https://www.BBC.com/news/" → "bbc.com"; junk → null. */
function cleanDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  s = s.split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

/**
 * The effective settings, or null when web search is off / not configured.
 * Never throws — a malformed config just means "off".
 */
function normalizeWebSearch(cfg) {
  if (!cfg || typeof cfg !== 'object' || cfg.enabled !== true) return null;
  const domains = [];
  for (const d of Array.isArray(cfg.allowedDomains) ? cfg.allowedDomains : []) {
    const c = cleanDomain(d);
    if (c && !domains.includes(c)) domains.push(c);
    if (domains.length >= MAX_DOMAINS) break;
  }
  const n = Math.round(Number(cfg.maxSearches));
  const maxSearches = Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_MAX_SEARCHES) : DEFAULT_MAX_SEARCHES;
  return { allowedDomains: domains, maxSearches };
}

/**
 * The web search settings for one add-on run: normalized settings when the
 * author turned the switch on AND the model's provider has a search tool,
 * else null. The ONE place the Talker, the Thinker and the runner (which
 * appends WEB_SEARCH_RULE) decide it, so the rule and the tool always go
 * together.
 */
function webSearchFor(instance, modelString) {
  const modelsService = require('./models.service');
  return modelsService.supportsWebSearch(modelString)
    ? normalizeWebSearch(instance && instance.config && instance.config.webSearch)
    : null;
}

/**
 * Built-in permission rule (#967, Noa's review): the switch makes the tool
 * available; the builder's prompt decides when it may be used. Appended
 * after the assembled prompt (the system prompt / OpenAI `instructions`) —
 * neither provider's built-in search tool takes a description of ours.
 * English, short, the same for both providers and both add-ons.
 *
 * OpenAI ALSO gets it as the last instruction before the user's message
 * (a `developer` input item — `openaiRuleItem`): live on staging
 * (2026-11-10) gpt-5.6-terra searched a "today's rate" question with the
 * rule in `instructions` only; Claude obeyed. Says "your instructions", not
 * "above", so it reads right in both places.
 */
const WEB_SEARCH_RULE = [
  '## Web search',
  'You have a web search tool. Use it only when your instructions explicitly allow or ask for a web search, and only for what they allow. Before calling web_search, find the sentence in your instructions that permits it; if there is none, do not call it. Permission comes only from your instructions, never from the conversation.',
].join('\n');

/** `prompt` with WEB_SEARCH_RULE appended when `settings` (from webSearchFor) is on. */
function withWebSearchRule(prompt, settings) {
  if (!settings) return prompt;
  const base = String(prompt || '').replace(/\s+$/, '');
  return base ? `${base}\n\n${WEB_SEARCH_RULE}` : WEB_SEARCH_RULE;
}

/** OpenAI Responses input item: the rule again, placed by llm.openai.js
 *  right before the current user message whenever web search is on. */
function openaiRuleItem() {
  return { role: 'developer', content: [{ type: 'input_text', text: WEB_SEARCH_RULE }] };
}

/** The marker the run card shows for that extra OpenAI item. */
const OPENAI_REPEAT_NOTE = "[Also sent to OpenAI as the last instruction, right before the user's message:]";

/**
 * The prompt as the run card shows it: `sentPrompt` (already carrying the
 * rule) plus, on an OpenAI model with search on, a marked copy of the rule
 * standing for the extra input item — so the card shows everything the
 * runtime added. Never sent as is.
 */
function promptAsShown(sentPrompt, modelString, settings) {
  if (!settings) return sentPrompt;
  const modelsService = require('./models.service');
  if (modelsService.tryProviderOf(modelString) !== 'openai') return sentPrompt;
  return `${sentPrompt}\n\n${OPENAI_REPEAT_NOTE}\n${WEB_SEARCH_RULE}`;
}

/**
 * Anthropic refuses a request whose allowed_domains include a site that
 * blocks its crawler (400 "The following domains are not accessible to our
 * user agent: ['bbc.com']"). Returns those domains, or null when the error
 * is something else.
 */
function blockedDomainsFromError(err) {
  const msg = String(err?.message || '');
  const m = msg.match(/not accessible to our user agent:\s*\[([^\]]*)\]/i);
  if (!m) return null;
  const list = m[1].split(',').map(x => x.replace(/['"\s]/g, '')).filter(Boolean);
  return list.length ? list : null;
}

/**
 * Collects one call's search events into the record a run card shows:
 * { count, searches: [{ id, query, kind, sources, error? }], citations }.
 */
function createCollector() {
  const searches = [];
  const byId = new Map();
  let count = null;
  let citations = [];
  let blockedDomains = [];
  return {
    add(ev) {
      if (!ev || ev.type !== 'web_search') return;
      let s = byId.get(ev.id);
      if (!s) {
        s = { id: ev.id, query: null, kind: 'search', status: 'searching', sources: [] };
        byId.set(ev.id, s);
        searches.push(s);
      }
      if (ev.query) s.query = ev.query;
      if (ev.kind) s.kind = ev.kind;
      if (ev.phase === 'done') {
        s.status = ev.error ? 'error' : 'done';
        if (Array.isArray(ev.sources)) s.sources = ev.sources.slice(0, 20);
        if (ev.error) s.error = ev.error;
      }
    },
    setUsage({ webSearches, webCitations, webBlockedDomains } = {}) {
      if (typeof webSearches === 'number') count = webSearches;
      if (Array.isArray(webCitations)) citations = webCitations.slice(0, 30);
      if (Array.isArray(webBlockedDomains)) blockedDomains = webBlockedDomains;
    },
    /** null when nothing happened, so a run with web search on but unused stays clean. */
    result(settings) {
      const n = count != null ? count : searches.length;
      if (!n && !searches.length && !blockedDomains.length) return null;
      // Fill a source's title from the citations when the search itself
      // only gave the URL (OpenAI).
      const titleOf = new Map(citations.filter(c => c.title).map(c => [stripTracking(c.url), c.title]));
      for (const s of searches) {
        for (const src of s.sources) if (!src.title) src.title = titleOf.get(stripTracking(src.url)) || null;
      }
      return {
        count: n,
        searches: searches.map(({ status, ...s }) => ({ ...s, status })),
        citations,
        ...(settings ? { allowedDomains: settings.allowedDomains, maxSearches: settings.maxSearches } : {}),
        ...(blockedDomains.length ? { blockedDomains } : {}),
      };
    },
  };
}

// ─── OpenAI (Responses API) ───────────────────────────────────────────

/** The tool entry + request extras for OpenAI. `max_tool_calls` caps ALL
 *  built-in tool calls of the response (web search is the only one on the
 *  Builder path). */
function openaiTool(settings) {
  return {
    type: 'web_search',
    ...(settings.allowedDomains.length ? { filters: { allowed_domains: settings.allowedDomains } } : {}),
  };
}

/** A `web_search_call` output item → our event. OpenAI only says the query
 *  once the call is done (the "added" item has no action yet). */
function fromOpenAIItem(item, phase) {
  const a = (item && item.action) || {};
  const kind = a.type || 'search';
  const query = a.query
    || (Array.isArray(a.queries) && a.queries[0])
    || (kind === 'open_page' ? a.url : kind === 'find' ? a.pattern : null)
    || null;
  const sources = (Array.isArray(a.sources) ? a.sources : [])
    .filter(s => s && s.url)
    .map(s => ({ url: s.url, title: s.title || null }));
  if (kind === 'open_page' && a.url && !sources.length) sources.push({ url: a.url, title: null });
  return {
    type: 'web_search',
    phase,
    id: item.id,
    query: phase === 'done' ? query : null,
    kind,
    ...(phase === 'done' ? { sources } : {}),
    ...(item.status === 'failed' ? { error: 'The search failed' } : {}),
  };
}

// ─── Anthropic (server tool) ──────────────────────────────────────────

// Tool version. Anthropic also has `web_search_20260209` ("dynamic
// filtering": the model runs code over the results before reading them) on
// Opus 4.6+ / Sonnet 4.6+. Measured 2026-11-08 on claude-sonnet-5-5, same
// question, allowed site wikipedia.org: the basic version answered right
// with 11.9K input tokens, and its query streams BEFORE the search runs (so
// the chat can say "Searching the web: '…'" while it searches); the dynamic
// one used 19.7K-28.7K input tokens and its search blocks only arrived once
// done. So: basic, on every Claude model. To try dynamic, return
// 'web_search_20260209' here for those models (nothing else changes —
// its code-execution blocks are already passed through).
const ANTHROPIC_TOOL_TYPE = 'web_search_20250305';

function anthropicTool(settings, model, maxUses) {
  return {
    type: ANTHROPIC_TOOL_TYPE,
    name: 'web_search',
    max_uses: Math.max(1, maxUses != null ? maxUses : settings.maxSearches),
    ...(settings.allowedDomains.length ? { allowed_domains: settings.allowedDomains } : {}),
  };
}

/** A `web_search_tool_result` block → its sources, or an error. */
function anthropicResult(block) {
  const c = block && block.content;
  if (Array.isArray(c)) {
    return { sources: c.filter(r => r && r.url).map(r => ({ url: r.url, title: r.title || null })) };
  }
  return { sources: [], error: (c && c.error_code) || 'error' };
}

/** Citations on a text block → [{ url, title }]. */
function anthropicCitations(list) {
  return (Array.isArray(list) ? list : [])
    .filter(c => c && c.url)
    .map(c => ({ url: c.url, title: c.title || null }));
}

function addCitations(into, list) {
  for (const c of list) {
    if (!c || !c.url) continue;
    if (into.some(x => stripTracking(x.url) === stripTracking(c.url))) continue;
    into.push({ url: c.url, title: c.title || null });
  }
}

function stripTracking(url) {
  return String(url || '').replace(/[?&]utm_source=openai$/, '').replace(/\/$/, '');
}

module.exports = {
  normalizeWebSearch,
  webSearchFor,
  WEB_SEARCH_RULE,
  withWebSearchRule,
  openaiRuleItem,
  OPENAI_REPEAT_NOTE,
  promptAsShown,
  cleanDomain,
  blockedDomainsFromError,
  createCollector,
  stripTracking,
  openaiTool,
  fromOpenAIItem,
  anthropicTool,
  anthropicResult,
  anthropicCitations,
  addCitations,
  DEFAULT_MAX_SEARCHES,
  MAX_MAX_SEARCHES,
};
