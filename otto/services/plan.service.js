/**
 * The plan — call 2 of 3, and the human approval gate.
 *
 * Consolidates the conversation into the structured card M3 shows: SCREEN /
 * SOURCES / FILTERS / COLUMNS / KPIS / ACTIONS / NOTES, every reference a
 * brief field id, every label bilingual. A non-developer cannot review a
 * spec, but they can absolutely review this — getting it wrong here is
 * cheap; after the build it is not.
 *
 * A structurally invalid plan retries ONCE with the exact errors named
 * (the structured-output pattern); a second failure surfaces to the user
 * as a plain "couldn't draft the plan" rather than a wrong plan.
 */

const llmService = require('../../services/llm');
const { renderBriefForPrompt } = require('./brief.service');
const { LANGUAGE_RULE, extractJSON, transcriptOf } = require('./brainstorm.service');
const { validatePlan, ICONS } = require('./spec.contract');

async function draftPlan({ messages, currentPlan = null, brief, settings }) {
  const revising = currentPlan
    ? `\n\nThis is NOT a fresh plan. A screen already exists:\n  title: ${currentPlan.title?.en}\n  summary: ${currentPlan.summary?.en || ''}\nProduce a CHANGE plan: return the full plan of the screen AFTER the change, and fill "changes" with what actually changes, one line each. Keep the existing title unless the user asked to rename.`
    : '';

  const system = `You are Otto. The conversation is over — turn it into a clear action plan the user will approve before the screen is built.${revising}

${LANGUAGE_RULE}

The available data (your ONLY vocabulary — every field reference below must be one of these ids):

${renderBriefForPrompt(brief)}

The plan must be readable by a non-developer: every entry is something they will see on the screen, not a technical component.

Return ONLY JSON:
{
  "title": { "en": "screen name, 2-4 words", "he": "..." },
  "summary": { "en": "one sentence: what this screen does and for whom", "he": "..." },
  "icon": one of ${JSON.stringify(ICONS)},
  "sources": [ { "id": "brief source id this screen reads", "label": { "en": "its human name", "he": "..." } } ],
  "columns": [ { "field": "brief field id", "label": { "en": "", "he": "" } } ],
  "filters": [ { "field": "brief field id (a text field worth filtering by)", "label": { "en": "", "he": "" } } ],
  "kpis":    [ { "label": { "en": "", "he": "" }, "detail": { "en": "how it is computed, one phrase", "he": "" } } ],
  "charts":  [ { "label": { "en": "e.g. Revenue by category (bar)", "he": "" }, "detail": { "en": "what it plots and how it is grouped", "he": "" } } ],
  "actions": [ { "label": { "en": "", "he": "" } } ],
  "notes":   [ { "en": "a data limitation the user must know (from the caveats)", "he": "" } ],
  "changes": [ { "en": "only for a change plan: what changes, one line each", "he": "" } ]
}

3 to 8 columns, 0 to 3 filters, 0 to 4 KPIs, 0 to 2 charts, 0 to 2 actions. EVERYTHING the user asked for appears somewhere in the plan — a request you cannot honor goes in notes, never silently dropped.`;

  const transcript = transcriptOf(messages);
  const model = settings?.talkModel || 'claude-sonnet-5';

  let lastErrors = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = lastErrors
      ? `${transcript}\n\nYOUR PREVIOUS PLAN FAILED VALIDATION. Fix exactly these problems:\n${lastErrors.map(e => `- ${e}`).join('\n')}`
      : transcript;

    const response = await llmService.sendOneShot(system, user, {
      // Bilingual labels are token-expensive; 2000 truncated a real plan's
      // JSON mid-array (same failure mode as the knowledge pass).
      model, maxTokens: 5000, jsonOutput: true, context: 'otto_plan',
    });

    let plan;
    try {
      plan = extractJSON(response);
    } catch (e) {
      lastErrors = [`not valid JSON: ${e.message}`];
      continue;
    }

    const errors = validatePlan(plan, brief);
    if (errors.length === 0) {
      plan.isChange = Boolean(currentPlan);
      if (!Array.isArray(plan.changes)) plan.changes = [];
      if (!Array.isArray(plan.notes)) plan.notes = [];
      if (!Array.isArray(plan.kpis)) plan.kpis = [];
      if (!Array.isArray(plan.actions)) plan.actions = [];
      if (!Array.isArray(plan.filters)) plan.filters = [];
      if (!Array.isArray(plan.charts)) plan.charts = [];
      return plan;
    }
    lastErrors = errors;
  }

  const err = new Error('the plan did not pass validation after a retry');
  err.planErrors = lastErrors;
  throw err;
}

module.exports = { draftPlan };
