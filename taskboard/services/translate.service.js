/**
 * Hebrew <-> English translation for task text.
 *
 * These tasks get written in whichever language the person was thinking in, and
 * often mix both in one sentence. Reading someone else's is the friction this
 * removes.
 *
 * The direction is decided here rather than asked of the model: whether a string
 * contains Hebrew letters is a fact, and spending a model call to establish it
 * would be slower and less reliable than one regex.
 */
const llmService = require('../../services/llm');

// Hebrew letters, including the five final forms. A single one is enough:
// mixed text is the normal case here, not the exception.
const HEBREW = /[֐-׿]/;

const MODEL = 'claude-haiku-4-5';
const MAX_CHARS = 8000;

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

/** @returns {'he'|'en'} the language to translate INTO. */
function targetFor(text) {
  return HEBREW.test(text) ? 'en' : 'he';
}

const SYSTEM = `You translate task-tracker text between Hebrew and English.

Rules:
- Output ONLY the translation. No preamble, no quotes, no notes, no explanation.
- Preserve the HTML structure exactly as given: the same tags, the same order,
  the same attributes. Translate only the text between them.
- Do NOT translate: code, identifiers, file paths, URLs, product and company
  names, crew member names, or anything inside <pre> or <code>.
- Keep task references such as #412 and @names exactly as they are.
- Mixed-language input is normal. Translate the parts that are in the source
  language and leave the rest alone rather than round-tripping it.
- If the text is already entirely in the target language, return it unchanged.`;

/**
 * Translates one piece of task text.
 *
 * @param {string} text  plain text or the HTML a description holds
 * @returns {Promise<{ translated: string, to: 'he'|'en' }>}
 */
async function translate(text) {
  const input = String(text ?? '');
  if (!input.trim()) throw new ValidationError('Nothing to translate');
  if (input.length > MAX_CHARS) {
    // A description can hold pasted base64 images, which are megabytes of no
    // linguistic content at all and would be billed as tokens.
    throw new ValidationError(`Text is too long to translate (${input.length} characters, limit ${MAX_CHARS})`);
  }

  const to = targetFor(input);

  const translated = await llmService.sendOneShot(
    SYSTEM,
    `Translate into ${to === 'he' ? 'Hebrew' : 'English'}:\n\n${input}`,
    {
      model: MODEL,
      maxTokens: 4096,
      // Translation has a single right answer, so the provider default of 1.0
      // would only add variation between two runs of the same text.
      temperature: 0,
      context: 'taskboard_translate',
    },
  );

  return { translated: String(translated ?? '').trim(), to };
}

module.exports = { translate, targetFor, ValidationError, MAX_CHARS };
