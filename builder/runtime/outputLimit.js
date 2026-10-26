/**
 * Builder V2 — the output limit of an addon's model call (tasks #889, #920).
 *
 * Every addon used to call its model with no limit, so each provider's
 * default applied: Anthropic 4,096 tokens, Gemini 2,048, OpenAI 8,192
 * (2,048 when streaming). A thinker writing Hebrew JSON needs ~4,000, and
 * models that think first (Claude Opus 5 / Sonnet 5, GPT-5.x, Gemini 3)
 * spend part of the SAME budget on thinking — so answers came back cut or
 * empty, and were saved as success.
 *
 * Now: `config.maxOutputTokens` on the addon (the Builder's "Max output"),
 * else DEFAULT. It caps what the model may write including its thinking;
 * a run that hits it is a failure (see addonRunner), never a partial
 * success. The limit is a ceiling, not a cost — an answer that needs
 * 2,000 tokens costs 2,000 tokens whatever the limit.
 *
 * Mirrored in the client: src/builder/registry/outputLimit.ts.
 */

const DEFAULT_OUTPUT_TOKENS = 16000;
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 64000;

/**
 * Above this, a non-streaming Anthropic call is refused by the SDK as
 * "may take longer than 10 minutes" (~21K). One-shot calls over it stream
 * (llm.claude.js `stream`), which returns the identical result.
 */
const STREAM_ABOVE = 16000;

/** The addon's chosen limit, or null when it never chose one. */
function chosenLimitOf(instance) {
  const n = Number(instance?.config?.maxOutputTokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(Math.round(n), MIN_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS);
}

/** The limit an addon's model calls run with. */
function outputLimitOf(instance) {
  return chosenLimitOf(instance) ?? DEFAULT_OUTPUT_TOKENS;
}

module.exports = {
  DEFAULT_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, STREAM_ABOVE,
  chosenLimitOf, outputLimitOf,
};
