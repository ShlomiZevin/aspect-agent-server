/**
 * Error center — the handling rules (task #903, step 7).
 *
 * For each kind of error, written down once, what the platform does when
 * it happens. Applied in code here:
 *
 *   retry        services/llm.js — a model call that hit this kind is tried
 *                again `times` more, waiting `waitMs[i]` before try i+1.
 *                A streamed reply is retried only if nothing reached the
 *                user yet. Every try that failed is still recorded.
 *   userMessage  builder/routes/runtimeRoute.js — what a CUSTOMER (the
 *                outside chat) sees instead of a broken reply. The Builder
 *                test chat and simulations keep the technical message.
 *   alert        builder/services/errorAlerts.js — email Shlomi the first
 *                time a group of this kind appears (or comes back after
 *                being marked handled) in a customer conversation or in
 *                the server itself. Builder / simulation errors only show
 *                in the list — their author is looking at the screen.
 *   fallback     not yet: switching to a backup model is task #574.
 *
 * Ignoring a known, harmless group is done per group in Admin → Errors
 * (status "Ignored"), not per kind.
 *
 * Start small and grow from what the list shows — every rule here is a
 * decision; change them here, nowhere else.
 */

const DEFAULT_USER_MESSAGE = 'Sorry — something went wrong on my side. Please send that again.';

const RULES = {
  model_rate_limit: {
    retry: { times: 2, waitMs: [2000, 6000] },
    alert: false,
    userMessage: 'I\'m getting a lot of messages right now — please send that again in a moment.',
  },
  model_timeout: {
    alert: false,
    userMessage: 'That took too long on my side — please send it again.',
  },
  model_refusal: { alert: false },
  model_bad_answer: { alert: false },
  model_other: { alert: true },
  database: { alert: true },
  external: { alert: true },
  server_unavailable: {
    alert: true,
    userMessage: 'I\'m very busy right now — please try again in a minute.',
  },
  user_input: { alert: false },
  code: { alert: true },
};

function ruleFor(kind) {
  return RULES[kind] || {};
}

/** What a customer sees when a turn fails with this kind of error. */
function userMessageFor(kind) {
  return ruleFor(kind).userMessage || DEFAULT_USER_MESSAGE;
}

module.exports = { RULES, ruleFor, userMessageFor, DEFAULT_USER_MESSAGE };
