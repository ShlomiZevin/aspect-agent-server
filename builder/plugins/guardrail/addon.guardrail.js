/**
 * Guardrail plugin — server-side (task #963).
 *
 * One model call that returns a VERDICT on the reply (`{{reply}}`, this
 * turn's reply so far) or on the customer's message. Everything is in the
 * add-on's config and visible in the Builder; the verdict lands on the run
 * card (`guardrail` on addon.output / addon_runs).
 *
 *   holdReply OFF (default), or the offline lane → FLAG ONLY: the verdict is
 *     recorded; nothing the customer sees changes.
 *   holdReply ON, main lane → the verdict APPLIES (the Talker before it ran
 *     held — BuilderRunner): approve | replace (actions.replace) | block
 *     (actions.block: blockMessage, stop the chain, escalateTo next turn).
 *     A failed run (no valid verdict) is handled by BuilderRunner with
 *     config.onError — fail closed by default (`blockOutcome` below).
 *
 * Output: guardrail-verdict (a JSON object; bad / empty JSON fails the run).
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');
const descriptor = require('../../addons/guardrail.addon.json');

const GUARDRAIL_PLUGIN_ID = descriptor.pluginId;

/** Shown to the customer when a block has no message of its own. */
const DEFAULT_BLOCK_MESSAGE = 'מצטערים, לא נוכל לענות על זה כאן. נציג מטעמנו ימשיך איתך.';

/** The config with every default filled in — the one reading of it. */
function settingsOf(instance) {
  const cfg = (instance && instance.config) || {};
  const actions = cfg.actions && typeof cfg.actions === 'object' ? cfg.actions : {};
  return {
    holdReply: cfg.holdReply === true,
    replace: actions.replace !== false,
    block: actions.block !== false,
    blockMessage: typeof cfg.blockMessage === 'string' && cfg.blockMessage.trim() ? cfg.blockMessage : DEFAULT_BLOCK_MESSAGE,
    escalateTo: typeof cfg.escalateTo === 'string' && cfg.escalateTo.trim() ? cfg.escalateTo.trim() : null,
    onError: cfg.onError === 'approve' ? 'approve' : 'block',
  };
}

/** True when this run's verdict changes the reply (hold ON in the main lane). */
function acts(instance) {
  return settingsOf(instance).holdReply && (instance.lane || 'main') === 'main';
}

/**
 * The "Your verdict" section the runtime appends to the prompt (addonRunner,
 * so the run card shows exactly what the model got). Lists only the verdicts
 * this Guardrail may return. Adds the reply when the prompt doesn't use
 * {{reply}} and there is one.
 */
function promptSuffix({ instance, reply }) {
  const s = settingsOf(instance);
  const lines = [];
  const usesReply = /\{\{reply\}\}/.test(String(instance?.config?.prompt || ''));
  if (!usesReply && reply) {
    lines.push('## The reply to check', reply, '');
  }
  lines.push('## Your verdict');
  if (acts(instance)) {
    const options = ['"approve"'];
    if (s.replace) options.push('"replace"');
    if (s.block) options.push('"block"');
    lines.push(
      `Return JSON only: {"verdict": ${options.join(' | ')}, "reason": "<one short sentence>"${s.replace ? ', "replacement": "<the full corrected reply — only with replace>"' : ''}}.`,
      '- approve: it passes your rules as it is.',
    );
    if (s.replace) lines.push('- replace: it breaks a rule but can be fixed — write the whole corrected reply, in the same language and voice, in "replacement".');
    if (s.block) lines.push('- block: it must not be sent at all.');
  } else {
    lines.push(
      'Return JSON only: {"verdict": "approve" | "flag", "reason": "<one short sentence>"}.',
      '- approve: it passes your rules.',
      '- flag: it breaks a rule (this is recorded for review; it does not change the reply).',
    );
  }
  return lines.join('\n');
}

/** What a block does — also used by BuilderRunner when the run failed (fail closed). */
function blockOutcome(instance) {
  const s = settingsOf(instance);
  return {
    assistantText: s.blockMessage,
    breakChain: true,
    ...(s.escalateTo ? { transition: { to: s.escalateTo, reason: 'guardrail block', fireImmediately: false } } : {}),
  };
}

async function run(ctx) {
  const {
    instance, prompt, modelString, userMessage, conversationId,
    agentNameForLogs, ownerUserId, historyMessages, llm, usageProcess, usageCrew,
    reply,
  } = ctx;
  const start = Date.now();
  const s = settingsOf(instance);
  const applies = acts(instance);

  const raw = await llm.sendOneShot(prompt, userMessage, {
    model: modelString,
    jsonOutput: true,
    historyMessages,
    context: usageProcess,
    agentName: agentNameForLogs,
    crewMember: usageCrew,
    conversationId: String(conversationId),
    userId: ownerUserId,
  });
  const text = typeof raw === 'string' ? raw : (raw?.text || '');
  const { parsed, error } = parseOutput('json-to-memory', text);
  const base = {
    rawOutput: text,
    parsedOutput: parsed,
    memoryWrites: [],
    parseError: error || undefined,
    durationMs: Date.now() - start,
    tokens: { input: 0, output: 0, total: 0 },
  };

  const verdict = parsed && typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : null;
  const reason = parsed && typeof parsed.reason === 'string' ? parsed.reason : '';
  const known = applies ? ['approve', 'replace', 'block'] : ['approve', 'flag'];
  if (!parsed || !known.includes(verdict)) {
    // No valid verdict = a failed run (fail closed is BuilderRunner's call).
    return { ...base, parseError: error || `verdict must be one of ${known.join(' / ')}`, parsedOutput: null };
  }

  if (!applies) {
    return { ...base, guardrail: { verdict, applied: 'flag', reason, held: false } };
  }

  // Hold ON, main lane — the verdict applies.
  const replacement = parsed && typeof parsed.replacement === 'string' ? parsed.replacement.trim() : '';
  if (verdict === 'replace' && s.replace && replacement && reply) {
    return { ...base, assistantText: replacement, guardrail: { verdict, applied: 'replace', reason, held: true } };
  }
  if (verdict === 'block' && s.block) {
    return {
      ...base,
      ...blockOutcome(instance),
      guardrail: { verdict, applied: 'block', reason, held: true, ...(s.escalateTo ? { escalateTo: s.escalateTo } : {}) },
    };
  }
  // approve — or an action this Guardrail may not take, or a replace with
  // nothing to replace: the reply goes out as it is, and the card says why.
  const applied = 'approve';
  const note = verdict === 'approve' ? undefined
    : verdict === 'replace' && !reply ? 'replace before any reply — nothing to replace'
      : verdict === 'replace' && !replacement ? 'replace without a replacement'
        : `${verdict} is not allowed on this Guardrail`;
  return { ...base, guardrail: { verdict, applied, reason, held: true, ...(note ? { note } : {}) } };
}

registerPlugin({
  id: descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  promptSuffix,
  run,
});

module.exports = { GUARDRAIL_PLUGIN_ID, settingsOf, acts, blockOutcome, promptSuffix, DEFAULT_BLOCK_MESSAGE };
