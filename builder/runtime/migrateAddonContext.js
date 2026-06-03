/**
 * One-shot migration from the Phase A "structured context" addon shape
 * to the Phase B "template owns placement" shape.
 *
 * Old shape:
 *   - addon.context.persona       (boolean)
 *   - addon.context.memoryReads   (string|null[])
 *   - addon.context.thinkingReads (string|null[])
 *
 * The promptTemplate carries bare `{{persona}}` / `{{memory}}` /
 * `{{thinking}}` tokens whose rendering was gated by those flags. In
 * the new model the flags are gone and the tokens render whenever
 * they appear in the template. To preserve the old behaviour we
 * rewrite the template at read time:
 *
 *   - `context.persona === false`        → strip `{{persona}}`
 *   - `context.memoryReads === []`       → strip `{{memory}}`
 *   - `context.memoryReads === ['a','b']`→ replace `{{memory}}` with
 *                                          `{{memory:a}}\n\n{{memory:b}}`
 *   - `context.thinkingReads` same as memoryReads
 *
 * Then we drop the dead fields. `context.history` and
 * `context.history` stays alive — see the AddonContext docstring
 * in builder/types/index.ts for the rationale.
 *
 * Pure. Returns a new instance if anything changed; otherwise the
 * original reference. Used by:
 *   - hydrateProject (client doc shape)
 *   - resolveRunnable (runtime read)
 *
 * Idempotent: a second pass over a migrated instance is a no-op.
 */

function rewriteSectionToken(template, token, selectedDomains) {
  if (!template.includes(`{{${token}}}`)) return template;
  if (!Array.isArray(selectedDomains) || selectedDomains.length === 0) {
    // Strip the token + its surrounding blank lines.
    const re = new RegExp(`\\n*\\{\\{${token}\\}\\}\\n*`, 'g');
    return template.replace(re, '\n\n');
  }
  // Explicit list — expand to one `{{token:NAME}}` per domain. `null`
  // (the no-domain bucket) maps to `general` so it renders the same
  // section the assembler used to emit under `### general`.
  const expansion = selectedDomains
    .map(d => `{{${token}:${d === null ? 'general' : d}}}`)
    .join('\n\n');
  return template.split(`{{${token}}}`).join(expansion);
}

/**
 * Fold any pre-Phase-B context flags into the template, then collapse
 * the template + `config.prompt` into a single user-owned string that
 * lives in `config.prompt`. The new `promptTemplate` is always just
 * `{{prompt}}` — the assembler still uses it as the entry point but it
 * delegates everything else to whatever the user types in config.prompt.
 *
 * Idempotent: an addon that's already in the new shape passes through
 * unchanged.
 */
function migrateAddonInstance(addon) {
  if (!addon || typeof addon !== 'object') return addon;
  const ctx = addon.context;

  const hasPersona       = ctx && 'persona'        in ctx;
  const hasMemoryReads   = ctx && 'memoryReads'    in ctx;
  const hasThinkingReads = ctx && 'thinkingReads'  in ctx;
  const oldTemplate      = typeof addon.promptTemplate === 'string' ? addon.promptTemplate : '';
  const oldPrompt        = (addon.config && typeof addon.config.prompt === 'string')
    ? addon.config.prompt : '';
  // Already in the new shape (template just `{{prompt}}` and no dead
  // context flags) — nothing to do.
  const templateIsJustPrompt =
    oldTemplate.trim() === '{{prompt}}' &&
    !hasPersona && !hasMemoryReads && !hasThinkingReads;
  if (templateIsJustPrompt) return addon;

  // 1. Rewrite section tokens based on the old context flags.
  let merged = oldTemplate;
  if (hasPersona && ctx.persona === false) {
    merged = merged.replace(/\n*\{\{persona\}\}\n*/g, '\n\n');
  }
  if (hasMemoryReads) {
    merged = rewriteSectionToken(merged, 'memory', ctx.memoryReads);
  }
  if (hasThinkingReads) {
    merged = rewriteSectionToken(merged, 'thinking', ctx.thinkingReads);
  }

  // 2. Substitute the user's old `config.prompt` into the {{prompt}} slot.
  if (merged.includes('{{prompt}}')) {
    merged = merged.split('{{prompt}}').join(oldPrompt);
  } else if (oldPrompt) {
    // Edge case: template never referenced {{prompt}} but the user had
    // prose anyway. Append it so nothing's lost.
    merged = `${merged}\n\n${oldPrompt}`;
  }
  merged = merged.replace(/\n{3,}/g, '\n\n').trim();

  // 3. Strip dead context fields. Only `history` stays alive — Dynamic
  // Context replaced the Triggered Context addon, so `triggeredReads`
  // is no longer carried even when legacy bodies still mention it.
  const nextCtx = { history: ctx ? ctx.history : { mode: 'last_n', n: 5 } };

  // 4. The new template is the minimal `{{prompt}}` wrapper. The user
  // controls everything via `config.prompt` now.
  const nextConfig = { ...(addon.config || {}), prompt: merged };

  return {
    ...addon,
    promptTemplate: '{{prompt}}',
    context: nextCtx,
    config:  nextConfig,
  };
}

function migrateCrewBody(crewBody) {
  if (!crewBody || typeof crewBody !== 'object') return crewBody;
  if (!Array.isArray(crewBody.addons)) return crewBody;
  let changed = false;
  const addons = crewBody.addons.map(a => {
    const migrated = migrateAddonInstance(a);
    if (migrated !== a) changed = true;
    return migrated;
  });
  return changed ? { ...crewBody, addons } : crewBody;
}

module.exports = { migrateAddonInstance, migrateCrewBody };
