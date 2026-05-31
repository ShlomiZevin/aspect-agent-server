/**
 * Builder V2 — promptAssembler.
 *
 * SOURCE OF TRUTH for prompt assembly. MUST produce the **same
 * output string** as the client's
 * `aspect-react-client/src/builder/components/PromptTemplateModal/buildPromptPreview.ts`
 * given the same inputs. Drift = silent prompt divergence.
 *
 * Vocabulary lives in `aspect-agent-server/builder/promptPlaceholders.json`
 * — the same file Alfred reads. Tokens:
 *
 *   Whole sections (legacy structured behaviour, still supported until
 *   the Phase B template migration runs):
 *     {{prompt}}, {{persona}}, {{memory}}, {{thinking}}, {{triggered}}
 *
 *   Single-domain blocks (Phase B):
 *     {{memory:NAME}}, {{thinking:NAME}}
 *
 *   Single-value inline substitutions (Phase B):
 *     {{field:NAME}}    — current memory value of one field
 *     {{param:NAME}}    — static agent parameter value
 *
 *   Extractor-only:
 *     {{fields_schema}}, {{fields_current}}
 *
 * History is NOT a placeholder — it's a separate parameter to the
 * LLM. The runtime sends history as the message-history parameter,
 * not interpolated into the prompt string.
 */

/**
 * Substitute simple `{{name}}` placeholders from a flat values map.
 * Empty values collapse the placeholder AND any blank lines around it
 * so the output isn't gappy. Patterned tokens like `{{memory:domain}}`
 * are handled by `substituteParameterised` below, not here.
 */
function substitute(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    const placeholder = `{{${key}}}`;
    if (!result.includes(placeholder)) continue;
    if (value === '') {
      const re = new RegExp(`\\n*${placeholder.replace(/[{}]/g, '\\$&')}\\n*`, 'g');
      result = result.replace(re, '\n\n');
    } else {
      result = result.split(placeholder).join(value);
    }
  }
  return result;
}

/**
 * Substitute parameterised tokens of the form `{{prefix:NAME}}`. The
 * supplied `resolve(name)` callback returns either:
 *   - a string (the substitution; empty string collapses the token)
 *   - null/undefined (token is left in place — the unresolved form
 *     surfaces in the prompt so the user sees the mistake instead of
 *     silently getting an empty hole)
 *
 * `inline` controls how empty values are handled: inline tokens
 * collapse to an empty string (so prose stays intact); block tokens
 * collapse surrounding blank lines (so the prompt doesn't gap).
 */
function substituteParameterised(template, prefix, resolve, inline) {
  const re = new RegExp(`\\{\\{${prefix}:([^}\\s]+)\\}\\}`, 'g');
  return template.replace(re, (match, name) => {
    const value = resolve(name);
    if (value === null || value === undefined) return match;
    if (value === '' && !inline) return '\n\n';
    return value;
  });
}

/**
 * Phase B note: persona is now placed by the user via `{{persona}}` in
 * the template, not toggled in structured context. Same for memory and
 * thinking sections. The persona block has no "enabled" flag — the
 * template's presence is the signal.
 */
function buildPersonaBlock(personaText) {
  const text = (personaText || '').trim();
  if (!text) return '';
  return `## Persona\n${text}`;
}

/**
 * `## Memory` block — every domain that holds any value, rendered as a
 * `### NAME` sub-block of JSON. Phase B: the runtime no longer takes a
 * per-addon `memoryReads` list; instead the addon's template uses
 * `{{memory}}` for "all" or `{{memory:NAME}}` for a single domain.
 * Runtime contract: include only fields with VALUES, never nulls.
 *
 * @param {() => Array<string|null>} domainList
 *        — returns the names of every memory domain that currently
 *          holds at least one value. `null` is the no-domain bucket.
 * @param {(domain: string|null) => Record<string, unknown>} valuesByDomain
 *        — given a domain name (or null), return its key→value map.
 */
function buildMemoryBlock(domainList, valuesByDomain) {
  const domains = (typeof domainList === 'function' ? domainList() : []) || [];
  if (domains.length === 0) return '';
  const sections = domains.map(d => {
    const label = d === null ? 'general' : d;
    const map = valuesByDomain(d) || {};
    return `### ${label}\n${JSON.stringify(map, null, 2)}`;
  });
  return `## Memory\n${sections.join('\n\n')}`;
}

/**
 * `## Thinking` block — same shape as `## Memory`. Enumerates every
 * thinking domain with values.
 */
function buildThinkingBlock(domainList, valuesByDomain) {
  const domains = (typeof domainList === 'function' ? domainList() : []) || [];
  if (domains.length === 0) return '';
  const sections = domains.map(d => {
    const label = d === null ? 'general' : d;
    const map = valuesByDomain(d) || {};
    return `### ${label}\n${JSON.stringify(map, null, 2)}`;
  });
  return `## Thinking\n${sections.join('\n\n')}`;
}

/**
 * `## Triggered` block. Same shape as `## Memory` and `## Thinking`
 * but pulls from the brain's `triggered` section — where the
 * Triggered Context addon's matched-rule texts land. Byte-equal to
 * the client preview.
 */
function buildTriggeredBlock(selectedDomains, valuesByDomain) {
  if (!selectedDomains || selectedDomains.length === 0) return '';
  const sections = selectedDomains.map(d => {
    const label = d === null ? 'general' : d;
    const map = valuesByDomain(d) || {};
    return `### ${label}\n${JSON.stringify(map, null, 2)}`;
  });
  return `## Triggered\n${sections.join('\n\n')}`;
}

/**
 * Render ONE memory or thinking domain as a `### NAME` block of JSON.
 * Used by `{{memory:NAME}}` and `{{thinking:NAME}}`. Returns an empty
 * string when the domain has no values — the caller's substitute
 * handler collapses the surrounding whitespace.
 */
function buildSingleDomainBlock(domainName, valuesByDomain) {
  const map = (valuesByDomain && valuesByDomain(domainName)) || {};
  if (!map || Object.keys(map).length === 0) return '';
  const label = domainName === null || domainName === undefined ? 'general' : domainName;
  return `### ${label}\n${JSON.stringify(map, null, 2)}`;
}

/**
 * Resolve one field's current memory value for `{{field:NAME}}`. The
 * value is rendered inline (bare), so strings come through as-is and
 * non-strings get JSON-stringified. Missing values resolve to an
 * empty string — the caller treats that as "collapse but keep going",
 * not as "leave the token in place".
 */
function resolveFieldInline(name, fieldValueOf) {
  if (!fieldValueOf) return '';
  const v = fieldValueOf(name);
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Resolve a `{{param:NAME}}` from the agent's parameter list. Same
 * inline semantics as `{{field:NAME}}`: missing → empty string.
 */
function resolveParamInline(name, parameters) {
  if (!Array.isArray(parameters)) return '';
  const found = parameters.find(p => p && p.name === name);
  if (!found) return '';
  const v = found.value;
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * `## Field schema` block — one line per field.
 *
 * Format uses explicit `key=value` props inside the parens so the
 * LLM can't confuse the source ("explicit" / "inferred") with an
 * enum value. Mirrors the client byte-for-byte.
 *
 *   - <name> (type=<type>, [values=[a, b, c],] source=<source>): <how>
 *
 * - `values=[...]` only appears for enum fields that have enumValues.
 * - The trailing `: <how>` is omitted when howToExtract is empty.
 */
function buildFieldsSchemaBlock(fields) {
  if (!fields || fields.length === 0) return '';
  const lines = fields.map(f => {
    const props = [`type=${f.type}`];
    if (f.type === 'enum' && Array.isArray(f.enumValues) && f.enumValues.length > 0) {
      props.push(`values=[${f.enumValues.join(', ')}]`);
    }
    props.push(`source=${f.source}`);
    const head = `- ${f.name} (${props.join(', ')})`;
    const how = (f.howToExtract || '').trim();
    return how ? `${head}: ${how}` : head;
  });
  return lines.join('\n');
}

/**
 * `## Already collected` block — JSON of fields that have a value.
 * Runtime contract: ONLY fields with values. No nulls.
 *
 * @param {(fieldName: string) => unknown | undefined} valueOf
 *        — return the current value of a field by name, or
 *          undefined if the field has no value yet. Undefined
 *          values are skipped.
 * @param {FieldDef[]} fields — the extractor's own fields.
 */
function buildFieldsCurrentBlock(fields, valueOf) {
  if (!fields || fields.length === 0) return '{}';
  const out = {};
  for (const f of fields) {
    const v = valueOf ? valueOf(f.name) : undefined;
    if (v !== undefined && v !== null) {
      out[f.name] = v;
    }
  }
  return JSON.stringify(out, null, 2);
}

/**
 * Assemble the prompt for an addon instance.
 *
 * @param {object} args
 * @param {object} args.instance       — AddonInstance (has promptTemplate, context, config)
 * @param {string} args.agentPersona   — agent's persona text (used by {{persona}} and {{persona}}-bearing templates)
 * @param {function} args.memoryValuesByDomain    — (domain) → memory values map
 * @param {function} args.thinkingValuesByDomain  — (domain) → thinking values map
 * @param {function} args.triggeredValuesByDomain — (domain) → triggered values map
 * @param {function} args.fieldValueOf — (fieldName) → captured value or undefined
 * @param {Array}    [args.extractorFields] — field defs this extractor extracts
 *        (already resolved by the caller from agent.fields ∪ crew.fields
 *        against instance.config.extractsFields). Empty for non-extractor
 *        plugins.
 * @param {Array}    [args.parameters] — agent.parameters used by `{{param:NAME}}` substitutions.
 * @returns {string} the assembled prompt
 */
function assemblePrompt({
  instance,
  agentPersona,
  memoryValuesByDomain,
  memoryDomainList,
  thinkingValuesByDomain,
  thinkingDomainList,
  triggeredValuesByDomain,
  fieldValueOf,
  extractorFields,
  parameters,
}) {
  let template = instance.promptTemplate || '';
  const cfg = instance.config || {};
  const fields = Array.isArray(extractorFields) ? extractorFields : [];

  // Treat as extractor if either: caller supplied field defs OR the
  // template references the extractor placeholders. Keeps the
  // template-driven nature intact while letting non-extractor
  // plugins (Talker, etc.) skip the schema/current blocks.
  const isExtractor = fields.length > 0 || /\{\{fields_(schema|current)\}\}/.test(template);

  const memoryReader   = memoryValuesByDomain   || (() => ({}));
  const thinkingReader = thinkingValuesByDomain || (() => ({}));

  // Phase B note: Talker's `config.prompt` may itself contain
  // placeholders (e.g. the user typed `@customer_age` which inserted
  // `{{field:customer_age}}`). So we substitute `{{prompt}}` FIRST,
  // then run the section + parameterised passes on the expanded
  // template — that way any token introduced by `config.prompt`
  // becomes visible to the resolvers below.
  template = template.split('{{prompt}}').join(cfg.prompt || '');

  // Flat whole-section tokens — persona, memory, thinking, triggered,
  // and the extractor-only schema/current blocks.
  template = substitute(template, {
    persona:        buildPersonaBlock(agentPersona),
    memory:         buildMemoryBlock(memoryDomainList   || (() => []), memoryReader),
    thinking:       buildThinkingBlock(thinkingDomainList || (() => []), thinkingReader),
    triggered:      buildTriggeredBlock(instance.context?.triggeredReads || [], triggeredValuesByDomain || (() => ({}))),
    fields_schema:  isExtractor ? buildFieldsSchemaBlock(fields) : '',
    fields_current: isExtractor ? buildFieldsCurrentBlock(fields, fieldValueOf) : '',
  });

  // Parameterised tokens last so anything introduced by the
  // {{prompt}} or section substitutions can still resolve.
  template = substituteParameterised(
    template,
    'memory',
    name => buildSingleDomainBlock(name, memoryReader),
    /* inline */ false,
  );
  template = substituteParameterised(
    template,
    'thinking',
    name => buildSingleDomainBlock(name, thinkingReader),
    /* inline */ false,
  );
  template = substituteParameterised(
    template,
    'field',
    name => resolveFieldInline(name, fieldValueOf),
    /* inline */ true,
  );
  template = substituteParameterised(
    template,
    'param',
    name => resolveParamInline(name, parameters),
    /* inline */ true,
  );

  return template.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { assemblePrompt };
