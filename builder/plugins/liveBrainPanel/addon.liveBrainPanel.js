/**
 * Live Brain Panel plugin — server-side, INTERNAL.
 *
 * Not an authored addon: the Live Brain screen doesn't create these; the
 * `liveBrainDispatcher` synthesises one instance per AI-source panel and
 * runs it through the standard `addonRunner`. So there's no client mirror
 * and no `.addon.json` descriptor (nothing for Alfred to offer).
 *
 * What it does: call the LLM with the panel's assembled prompt, take the
 * answer, and write the panel's content to `brain.panels[panelId]`:
 *   - `text` render   → the raw string (markdown allowed).
 *   - other renders   → JSON validated against the render's shape.
 * If the answer is empty or doesn't fit the shape, we CLEAR the slot so
 * the panel simply doesn't show this turn (per product decision — no
 * fallbacks). Usage is logged automatically by `llm.sendOneShot` under
 * the `live-brain-panel` process, so brain runs are distinguishable from
 * regular chat addons in the usage dashboard.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');
const { validatePanelValues } = require('../../runtime/panelShapes');

const LIVE_BRAIN_PANEL_PLUGIN_ID = 'live-brain-panel';

// A panel ANALYSES the conversation — it must not be handed a user turn
// to answer. On the offline lane `historyMessages` already contains the
// whole current turn (user message + assistant reply); passing the
// current user message AGAIN as the trailing turn ends the transcript on
// a user turn, which the model reads as "reply to this" — so it chats
// back instead of following the panel's instruction. Sending this fixed
// directive keeps a valid trailing `user` turn (some providers require
// it) while steering to analysis, not conversation. Scoped to this
// plugin only — no other addon is affected.
const ANALYSIS_DIRECTIVE =
  'Using the conversation above, produce this panel’s content exactly as instructed. Do not reply to the user or continue the conversation — output only the panel content.';

// Baked-in rules for HTML panels so the author doesn't have to spell them
// out. The panel renders a sanitized HTML *fragment* inside a card that's
// already on the page — a whole document (<!DOCTYPE>/<html>/<head>) or a
// <style> block is stripped for safety, and its CSS would leak as text.
const HTML_FRAGMENT_DIRECTIVE =
  ' Output a single HTML fragment only — no <!DOCTYPE>, <html>, <head>, <body>, <style>, <script>, and no markdown code fences. Style every element with inline style="…" attributes (a <style> block will NOT apply).';

/** For an HTML panel, drop a ```html … ``` fence the model may wrap the
 *  fragment in — otherwise Markdown renders it as a literal code block. */
function stripHtmlFence(s) {
  return String(s || '')
    .replace(/^\s*```(?:html)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

async function run(ctx) {
  const {
    instance, prompt, modelString, conversationId,
    agentNameForLogs, ownerUserId, historyMessages, llm, usageProcess, usageCrew,
  } = ctx;

  const start = Date.now();
  const cfg = instance.config || {};
  const panelId = instance.instanceId;
  const render = typeof cfg.render === 'string' ? cfg.render : 'text';
  // `text` (Markdown) and `html` are free-form string renders — everything
  // else has a JSON shape the model must return.
  const structured = render !== 'text' && render !== 'html';

  // HTML panels get the fragment rules appended so the model returns a
  // clean inline-styled fragment even if the author didn't spell it out.
  const directive = render === 'html'
    ? ANALYSIS_DIRECTIVE + HTML_FRAGMENT_DIRECTIVE
    : ANALYSIS_DIRECTIVE;

  const result = await llm.sendOneShot(prompt, directive, {
    model:          modelString,
    jsonOutput:     structured,
    historyMessages,
    context:        usageProcess,      // 'live-brain-panel' → tagged in llm_usage
    agentName:      agentNameForLogs,
    crewMember:     usageCrew,
    conversationId: String(conversationId),
    userId:         ownerUserId,
  });
  const raw = typeof result === 'string' ? result : (result?.text || '');

  let entry = null;
  let parsedOutput = null;
  let parseError;

  if (!structured) {
    // HTML: strip a ```html fence the model may wrap the fragment in,
    // else Markdown renders it as a literal code block instead of a card.
    const text = render === 'html' ? stripHtmlFence(raw) : raw.trim();
    parsedOutput = { text };
    entry = text ? { render, text, ranAt: Date.now() } : null;
  } else {
    const { parsed, error } = parseOutput('json-to-memory', raw);
    parseError = error || undefined;
    const values = validatePanelValues(render, parsed);
    parsedOutput = values;
    entry = values ? { render, values, ranAt: Date.now() } : null;
  }

  // Valid → replace the slot; invalid/empty → clear it so the panel hides.
  const memoryWrites = entry
    ? [{ kind: 'panel', panelId, entry }]
    : [{ kind: 'panel', panelId, clear: true }];

  return {
    rawOutput:    raw,
    parsedOutput,
    memoryWrites,
    parseError,
    durationMs:   Date.now() - start,
    tokens:       { input: 0, output: 0, total: 0 },
  };
}

registerPlugin({
  id:                 LIVE_BRAIN_PANEL_PLUGIN_ID,
  allowedOutputTypes: ['json-to-memory'],
  run,
});

module.exports = { LIVE_BRAIN_PANEL_PLUGIN_ID };
