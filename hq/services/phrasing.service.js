/**
 * HQ — the phrasing step.
 *
 * Claude decides, another model writes. They are genuinely different jobs:
 * Claude plans, uses tools and reasons about what a piece of work needs, but
 * its Hebrew copy reads translated. OpenAI's Hebrew is markedly better, and
 * writing a headline needs none of the reasoning that picked it.
 *
 * So the worker's brain stays Claude and the *words* come from whichever model
 * is configured. Swapping that model is a settings change and nothing else —
 * every caller goes through here, and here goes through the platform router, so
 * a different provider needs no code and still lands in llm_usage.
 *
 * Anything user-facing should come through this: headlines, body copy, CTAs,
 * captions, subject lines. Internal reasoning should not.
 */

const llm = require('../../services/llm');

/** Sensible default. Overridden per worker via settings.phrasingModel. */
const DEFAULT_PHRASING_MODEL = process.env.HQ_PHRASING_MODEL || 'gpt-5.6';

/**
 * Models offered for phrasing, and why you'd pick one.
 *
 * Not a hard allowlist — any id the platform router knows will work — but this
 * is what the UI offers, so it stays short and opinionated rather than being
 * the full model list.
 */
const PHRASING_MODELS = [
  { id: 'gpt-5.6',       label: 'GPT-5.6 Sol',   about: 'Best Hebrew. The default.' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', about: 'Nearly as good, half the price.' },
  { id: 'gpt-4o',        label: 'GPT-4o',        about: 'Solid and cheap.' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', about: 'Use if you want one model for everything.' },
];

/**
 * The house style. Kept here rather than in each worker's prompt because it is
 * about WRITING, not about marketing — a second employee that writes anything
 * gets the same rules for free.
 */
const HOUSE_STYLE = `You are a copywriter. You write finished copy, nothing else.

Rules:
- Return ONLY the copy. No preamble, no options, no explanation, no quote marks
  around it unless they belong in the text.
- Write in the language you are asked for. Hebrew must read as though written by
  a native speaker, not translated — natural word order, real idiom, no
  translationese.
- Be concrete. Say what the thing does. Never "revolutionary", never "unlock the
  power of", never three adjectives in a row.
- Respect any length limit exactly. A headline asked for in 5 words is 5 words.
- If a line could belong to any company, it is the wrong line.`;

function modelFor(worker) {
  return worker?.settings?.phrasingModel || DEFAULT_PHRASING_MODEL;
}

/**
 * Turn a brief into finished copy.
 *
 * @param {Object} opts
 * @param {string} opts.brief     - what the copy is for, and any constraints
 * @param {string} [opts.context] - facts it must be accurate to (from HQ, a proposal…)
 * @param {string} [opts.language]
 * @param {string} [opts.tone]
 * @param {Object} opts.worker    - whose settings decide the model
 */
async function write({ brief, context = null, language = 'Hebrew', tone = null, worker = null, conversationId = null } = {}) {
  if (!brief || !brief.trim()) throw new Error('Phrasing needs a brief');

  const model = modelFor(worker);
  const instructions = [
    HOUSE_STYLE,
    tone ? `\nTone for this piece: ${tone}` : '',
    `\nWrite in: ${language}`,
  ].join('');

  const message = [
    brief.trim(),
    context ? `\n\nFacts this must be accurate to:\n${context}` : '',
  ].join('');

  const text = await llm.sendOneShot(instructions, message, {
    model,
    maxTokens: 1200,
    // Copy wants some spread; this is not a single-correct-answer task.
    temperature: 0.8,
    // Attribution, so phrasing shows up in llm_usage next to everything else
    // the worker spends. The router logs it for us.
    context: 'hq_phrasing',
    agentName: 'hq',
    crewMember: worker?.slug || 'hq-worker',
    conversationId,
  });

  return { text: (text || '').trim(), model };
}

module.exports = { write, modelFor, PHRASING_MODELS, DEFAULT_PHRASING_MODEL, HOUSE_STYLE };
