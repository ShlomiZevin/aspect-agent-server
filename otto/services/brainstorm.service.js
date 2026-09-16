/**
 * Otto's conversational turn — call 1 of 3 (brainstorm / plan / build).
 *
 * Same machine as v1 (proven in Builder V2, decisions 51-52), re-pointed:
 * the system prompt is built from the client's REAL dataset brief instead
 * of a demo schema, and the language follows the MIRROR RULE — the reply is
 * in whatever language the user wrote, never assumed. (Both failure
 * directions of that rule are documented in CLAUDE.md; the wording below is
 * deliberately exactly "mirror the prompt" and nothing more.)
 */

const llmService = require('../../services/llm');
const { renderBriefForPrompt } = require('./brief.service');

/** Fallback when no interface language is given — the exact mirror wording, no more. */
const LANGUAGE_RULE =
  'LANGUAGE: mirror the prompt — answer in the language the user\'s message was written in. '
  + 'Hebrew IN THE DATA (store names, product names, suppliers) says nothing about the requested '
  + 'language; database values are never translated. Fields where this contract asks for BOTH '
  + '"en" and "he" always carry both, regardless of the conversation language.';

/**
 * The rule that actually ships: the shell has an explicit EN/HE toggle, so
 * the client SENDS the interface language and Otto follows it — same
 * practice as Data Chat and reports, and deterministic where mirroring is
 * not (the first live test wrote English and got Hebrew back: the brief's
 * Hebrew labels pulled the reply language, the exact documented failure).
 */
function languageRule(language) {
  if (language !== 'en' && language !== 'he') return LANGUAGE_RULE;
  const name = language === 'he' ? 'HEBREW' : 'ENGLISH';
  return `LANGUAGE: the user's interface is set to ${name} — write "reply" in ${name}, `
    + 'whatever language the user typed and whatever language appears in the data. '
    + 'Database values (store names, product names, suppliers) are never translated. '
    + 'Fields where this contract asks for BOTH "en" and "he" always carry both.';
}

function extractJSON(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new Error('the model did not return valid JSON');
}

function transcriptOf(messages) {
  return messages
    .map(m => `${m.role === 'user' ? 'USER' : 'OTTO'}: ${m.content}`)
    .join('\n\n');
}

/** Share of Hebrew letters among the non-space characters — the
 *  deterministic check behind the language enforcement below. */
function hebrewShare(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (!t) return 0;
  return ((t.match(/[\u0590-\u05FF]/g) || []).length) / t.length;
}

/** Did the reply actually come back in the requested language? Thresholds
 *  are loose on purpose: an English reply legitimately quotes Hebrew store
 *  names, and a Hebrew reply quotes column words — only a WRONG-language
 *  reply moves the share decisively. */
function replyLanguageOk(reply, language) {
  const share = hebrewShare(reply);
  if (language === 'en') return share < 0.4;
  if (language === 'he') return share > 0.25;
  return true;
}

/**
 * One turn. `currentPlan` flips the footing from "design a screen" to
 * "change the screen you already have" — same composer, different contract.
 */
async function brainstorm({ messages, currentPlan = null, brief, settings, language = null }) {
  const existing = currentPlan
    ? `\n\nAn app already exists: "${currentPlan.title?.en}" — ${currentPlan.summary?.en || ''}.\nThe conversation is now about CHANGING that app. Understand exactly what the user wants to add, remove or change. Do not plan a new app from scratch.`
    : '';

  const system = `You are Otto, the app builder of the Intelligence Center. You are talking to a retail employee who is not a developer. They want an operational app for their daily work: a table, filters, KPI cards, a chart. Your job in this phase is ONLY to understand exactly what they need — not to build. In everything you say to the user, call the thing you build an APP (never a "screen").

${languageRule(language)}

You know this organization's data — and ONLY this. Anything not listed here does not exist for you:

${renderBriefForPrompt(brief)}${existing}

How you behave:
- Ask one or two questions per turn, not a list. This is a conversation, not a form.
- Offer a concrete phrasing instead of an open question. "By branch or by supplier?" beats "how would you like to see it?".
- If something they ask for is not possible from the data above — say so immediately and explicitly, naming the limitation. Never quietly build something similar instead.
- Never ask about colors, design or layout. That is your job.
- Never write code or describe HTML. You talk about what the screen does.
- When it is clear what should be built or changed — summarize in one sentence and say you can move to the plan. Stop asking.

Return ONLY JSON:
{
  "reply": "what you say to the user, in the language the LANGUAGE rule names. Short — two to four lines.",
  "readyToPlan": true when you have enough to build the app, else false,
  "readySummary": "when ready — one sentence describing the app. Otherwise empty string.",
  "state": { "en": "one very short first-person sentence of where you stand — what you know, what you still need", "he": "the same sentence in Hebrew" },
  "suggestions": ["0-3 short tap-to-answer options for the question your reply asks — each a complete answer the user could send as-is, under 8 words, in the SAME language as the reply. Empty array when your reply asks nothing."]
}`;

  const ask = async (extra) => {
    const response = await llmService.sendOneShot(system, transcriptOf(messages) + (extra || ''), {
      model: settings?.talkModel || 'claude-sonnet-5',
      maxTokens: 900,
      jsonOutput: true,
      context: 'otto_brainstorm',
    });
    return extractJSON(response);
  };

  let parsed = await ask();

  // ENFORCED, not requested: the first live test asked in English and got a
  // Hebrew reply despite the rule — the brief's Hebrew labels pull the
  // model. A wrong-script reply gets exactly one corrective retry; the
  // check is a character count, so it cannot be argued with.
  if (!replyLanguageOk(parsed.reply, language)) {
    const name = language === 'he' ? 'HEBREW' : 'ENGLISH';
    console.warn(`[otto] brainstorm reply came back in the wrong language (wanted ${name}) — retrying once`);
    parsed = await ask(`\n\n[CORRECTION: your previous reply was written in the wrong language. `
      + `The interface is set to ${name} — rewrite the SAME reply in ${name}. `
      + `Keep database values (store/product/supplier names) exactly as they are.]`);
  }

  return {
    reply: String(parsed.reply || '').trim(),
    readyToPlan: Boolean(parsed.readyToPlan),
    readySummary: String(parsed.readySummary || '').trim(),
    state: {
      en: String(parsed.state?.en || '').trim(),
      he: String(parsed.state?.he || '').trim(),
    },
    // Tap-to-answer chips under the reply — ephemeral, never persisted with
    // the transcript (a reopened draft simply has none).
    suggestions: Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map(s => String(s).trim()).filter(Boolean).slice(0, 3)
      : [],
  };
}

module.exports = { brainstorm, LANGUAGE_RULE, languageRule, extractJSON, transcriptOf };
