/**
 * HQ — the Scribe.
 *
 * Turns a meeting transcript into the things a company actually needs from it:
 * a summary, an explicit decision list (each with the quote it came from), and
 * action items with an owner. Open questions land separately.
 *
 * Runs as an LLM one-shot tagged `agentName: 'hq'` / `crewMember: 'scribe'`, so
 * its spend lands in `llm_usage` already attributed — no migration needed
 * (docs/guides/LYBI_HQ.md §7).
 */

const llmService = require('../../services/llm');
const budget = require('./budget.service');
const atomsService = require('./atoms.service');

const SCRIBE_MODEL = process.env.HQ_SCRIBE_MODEL || 'claude-sonnet-4-6';

// Long meetings blow past a comfortable context. We keep the head and the tail:
// decisions cluster at the end, framing at the start, and the middle is the
// most compressible part of any meeting.
const MAX_CHARS = 120_000;

function clampTranscript(text) {
  if (text.length <= MAX_CHARS) return text;
  const head = Math.floor(MAX_CHARS * 0.4);
  const tail = MAX_CHARS - head;
  return `${text.slice(0, head)}\n\n[... middle of the transcript omitted for length ...]\n\n${text.slice(-tail)}`;
}

const INSTRUCTIONS = `You are the Scribe for Lybi, a 3-person AI company (Shlomi, Noa, Hila).

You are given the transcript or notes of one internal meeting. Extract what the company needs to remember.

Return ONLY a JSON object, no prose, no markdown fences:

{
  "summary": "2-4 sentences. What this meeting was about and what came out of it.",
  "decisions": [
    { "text": "the decision, stated as a decision", "who": "who decided, or null", "quote": "the short verbatim line it came from, or null" }
  ],
  "actions": [
    { "text": "the action item", "owner": "who owns it, or null", "due": "YYYY-MM-DD or null" }
  ],
  "questions": [ "an open question left unresolved" ],
  "participants": ["names of people who actually spoke, if identifiable"],
  "topics": ["3-6 short topic tags"]
}

Rules:
- A DECISION is something settled ("we're going with X", "we're dropping Y"). Not a topic discussed, not an opinion. If nothing was decided, return an empty array — do not invent decisions.
- An ACTION is something someone will do. Always try to attach an owner; use null rather than guessing.
- Use the speaker labels if the transcript has them. If it does not, leave "who"/"owner" null instead of assuming.
- Write in the language the meeting was held in (Hebrew stays Hebrew).
- Keep quotes short — one line, verbatim.`;

function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).trim();

  // Models sometimes wrap JSON in fences despite being told not to.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try { return JSON.parse(s); } catch { /* fall through */ }

  // Last resort: the outermost {...} span.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Run the Scribe over one atom and persist the result.
 * Safe to re-run — it overwrites the previous pass, which is what you want when
 * the prompt improves.
 */
async function runScribe(atomId) {
  const atom = await atomsService.getAtom(atomId);
  if (!atom) throw new Error(`atom ${atomId} not found`);

  const body = (atom.body || '').trim();
  if (!body) {
    await atomsService.setScribeStatus(atomId, 'failed', 'nothing to summarise');
    return null;
  }

  await budget.assertWithinBudget(`the Scribe on "${atom.title.slice(0, 40)}"`);
  await atomsService.setScribeStatus(atomId, 'running');

  const header = [
    `Meeting: ${atom.title}`,
    atom.occurred_at ? `Date: ${new Date(atom.occurred_at).toISOString().slice(0, 10)}` : null,
  ].filter(Boolean).join('\n');

  const raw = await llmService.sendOneShot(
    INSTRUCTIONS,
    `${header}\n\n---\n\n${clampTranscript(body)}`,
    {
      model: SCRIBE_MODEL,
      maxTokens: 4000,
      context: 'hq-scribe',
      agentName: 'hq',
      crewMember: 'scribe',
    }
  );

  const parsed = parseJsonLoose(raw);
  if (!parsed) {
    await atomsService.setScribeStatus(atomId, 'failed', 'could not parse Scribe output');
    throw new Error('Scribe returned unparseable output');
  }

  const decisions = asArray(parsed.decisions)
    .map(d => (typeof d === 'string' ? { text: d, who: null, quote: null } : d))
    .filter(d => d && d.text);

  const actions = asArray(parsed.actions)
    .map(a => (typeof a === 'string' ? { text: a, owner: null, due: null } : a))
    .filter(a => a && a.text);

  const questions = asArray(parsed.questions)
    .map(q => (typeof q === 'string' ? q : q?.text))
    .filter(Boolean);

  const updated = await atomsService.setScribeResult(atomId, {
    summary: parsed.summary || null,
    decisions,
    actions,
    questions,
    status: 'done',
  });

  // Only fill participants/projects if the Scribe found something and the
  // source didn't already provide it — never overwrite better metadata.
  const patch = {};
  const foundParticipants = asArray(parsed.participants).filter(Boolean);
  const foundTopics = asArray(parsed.topics).filter(Boolean);

  if (foundParticipants.length && !(atom.participants || []).length) patch.participants = foundParticipants;
  if (foundTopics.length && !(atom.projects || []).length) patch.projects = foundTopics;
  if (Object.keys(patch).length) return atomsService.patchAtom(atomId, patch);

  return updated;
}

module.exports = { runScribe, SCRIBE_MODEL };
