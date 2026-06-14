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
 *     {{prompt}}, {{persona}}, {{memory}}, {{thinking}}
 *
 *   Single-domain blocks (Phase B):
 *     {{memory:NAME}}, {{thinking:NAME}}
 *
 *   Single-value inline substitutions (Phase B):
 *     {{field:NAME}}    — current memory value of one field
 *     {{param:NAME}}    — static agent parameter value
 *
 *   Extractor-only:
 *     {{fields_schema}}, {{fields_current}},
 *     {{this_field}}    — literal NAME of the (first) extracted field
 *     {{enum_values}}   — comma-separated `enumValues` of that field
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
 * `## Summary` block — joins every declared summarizer's current text
 * under a `### NAME` heading. Used by `{{summary}}`. Returns empty
 * when no summarizer has fired yet — the caller's whitespace-collapse
 * handler keeps the prompt tidy.
 */
function buildSummaryBlock(summaries) {
  if (!summaries || typeof summaries !== 'object') return '';
  const entries = Object.entries(summaries).filter(
    ([, slot]) => slot && typeof slot.text === 'string' && slot.text.length > 0,
  );
  if (entries.length === 0) return '';
  const sections = entries.map(([name, slot]) => `### ${name}\n${slot.text}`);
  return `## Summary\n${sections.join('\n\n')}`;
}

/**
 * Render ONE summarizer slot for `{{summary:NAME}}`. Inline (bare text
 * — no `### NAME` heading), since the author typically wraps it in
 * their own copy. Missing slot → empty string.
 */
function resolveSummaryInline(name, summaries) {
  if (!summaries || typeof summaries !== 'object') return '';
  const slot = summaries[name];
  if (!slot || typeof slot.text !== 'string') return '';
  return slot.text;
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
 * Resolve `{{snippet:NAME}}` against the agent's `snippets[]` list.
 *
 * Resolution rules (mirrors the per-addon Run Filter — same shape):
 *   - Unknown name                              → ''
 *   - No filter / empty conditions              → snippet.content
 *   - mode='include' AND every condition matches → snippet.content
 *   - mode='include' AND any condition fails    → ''
 *   - mode='exclude' AND every condition matches → ''
 *   - mode='exclude' AND any condition fails    → snippet.content
 *
 * `brain` is the live memory blob (per-conversation) the engine
 * already passes around — the same shape `evaluateConditions`
 * expects. When `brain` is missing, every condition fails and
 * gated snippets resolve to empty (acceptable: it's a defensive
 * default; callers that care always pass it).
 */
function resolveSnippetInline(name, snippets, brain) {
  if (!Array.isArray(snippets) || snippets.length === 0) return '';
  const snip = snippets.find(s => s && s.name === name);
  if (!snip) return '';
  const filter = snip.filter;
  if (filter && Array.isArray(filter.conditions) && filter.conditions.length > 0) {
    // Lazy require avoids a top-of-file cycle (the matcher needs no
    // assembler internals, but loading both at module init can churn
    // require order across test harnesses).
    const { evaluateConditions } = require('./conditionMatcher');
    const result = evaluateConditions(brain || {}, filter.conditions);
    const mode = filter.mode === 'exclude' ? 'exclude' : 'include';
    const shouldRender = mode === 'include' ? result.ok : !result.ok;
    if (!shouldRender) return '';
  }
  return typeof snip.content === 'string' ? snip.content : '';
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
 * @param {function} args.memoryValuesByDomain   — (domain) → memory values map
 * @param {function} args.thinkingValuesByDomain — (domain) → thinking values map
 * @param {function} args.fieldValueOf — (fieldName) → captured value or undefined
 * @param {Array}    [args.extractorFields] — field defs this extractor extracts
 *        (already resolved by the caller from agent.fields ∪ crew.fields
 *        against instance.config.extractsFields). Empty for non-extractor
 *        plugins.
 * @param {Array}    [args.parameters] — agent.parameters used by `{{param:NAME}}` substitutions.
 * @param {Array}    [args.dynamicContexts] — agent.dynamicContexts used by
 *        `{{dynamic:NAME}}` / `{{dynamic:NAME:SECTION}}` / `{{dynamic:NAME:*}}`
 *        substitutions. Each DC carries `fieldId` + `cases` (each case has
 *        an optional umbrella `text` and an optional ordered `sections`
 *        list) + optional `fallback` (umbrella-only).
 * @param {Array}    [args.fieldsForDynamic] — agent + crew field defs in scope
 *        for resolving dynamic tokens (we look up fieldId by name).
 * @param {function} [args.onDynamicResolved] — callback
 *        `({ fieldName, section, matched, text }) => void` fired each
 *        time a dynamic token resolves. `section` is `null` for the
 *        umbrella form, the section name for `{{dynamic:F:S}}`, or
 *        `'*'` for the all-sections join. Used by the runtime to emit
 *        SSE events for the live chat trail.
 * @returns {string} the assembled prompt
 */
function assemblePrompt({
  instance,
  agentPersona,
  memoryValuesByDomain,
  memoryDomainList,
  thinkingValuesByDomain,
  thinkingDomainList,
  fieldValueOf,
  extractorFields,
  parameters,
  dynamicContexts,
  fieldsForDynamic,
  onDynamicResolved,
  // Summary slot map: `{ [name]: { text, watermark, ranAt } }` — the
  // shape stored in `brain.summary`. Passed by the caller so the
  // assembler doesn't reach into memory itself. Empty / missing →
  // `{{summary}}` collapses, `{{summary:NAME}}` resolves to ''.
  summaries,
  // Agent-level reusable snippets — `SnippetDef[]`. Inlined FIRST
  // (before sections / params / dynamic) so embedded tokens inside
  // snippet content resolve on the regular passes. Missing / empty
  // → every `{{snippet:NAME}}` resolves to ''.
  snippets,
  // Brain blob — needed by the snippet substitution pass so a
  // snippet's optional filter can be evaluated against current
  // memory. Same blob `addonRunner` already passes to the filter
  // gate at the addon level. Missing / undefined → snippet filters
  // evaluate as "no fields populated" (conditions effectively fail).
  brain,
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

  // Snippet pass — runs BEFORE every other parameterised resolver
  // so a snippet's `content` is inlined into the template and any
  // tokens inside it (`{{field:X}}`, `{{param:Y}}`, `{{memory}}`,
  // `{{dynamic:Z}}`, …) become visible to the subsequent passes.
  // Resolution rules:
  //   - Unknown name        → ''
  //   - Filter present and  → ''  (gate said skip)
  //     condition fails
  //   - Otherwise           → snippet.content (verbatim)
  // Nested `{{snippet:OTHER}}` inside the content is NOT recursively
  // expanded — v1 leaves it as literal text (validator warns).
  template = substituteParameterised(
    template,
    'snippet',
    (name) => resolveSnippetInline(name, snippets, brain),
    /* inline */ true,
  );

  // Flat whole-section tokens — persona, memory, thinking, summary,
  // and the extractor-only schema/current blocks.
  template = substitute(template, {
    persona:        buildPersonaBlock(agentPersona),
    memory:         buildMemoryBlock(memoryDomainList   || (() => []), memoryReader),
    thinking:       buildThinkingBlock(thinkingDomainList || (() => []), thinkingReader),
    summary:        buildSummaryBlock(summaries),
    fields_schema:  isExtractor ? buildFieldsSchemaBlock(fields) : '',
    fields_current: isExtractor ? buildFieldsCurrentBlock(fields, fieldValueOf) : '',
  });

  // Single-field INLINE tokens — the FIRST extractor field is "this
  // field" for the purposes of {{this_field}} / {{enum_values}}. Field
  // Reasoner is the primary consumer (UI constrains it to exactly one
  // field); multi-field extractors that include these tokens will
  // resolve to their first field, which is acceptable since the tokens
  // are semantically tied to single-field reasoning.
  //
  // Substituted inline (plain string replace, no surrounding-whitespace
  // collapse) because these are embedded in prose like
  //   `inferring the value of {{this_field}}`
  // rather than block boundaries.
  const thisField = isExtractor && fields.length > 0 ? fields[0] : null;
  const thisFieldName  = thisField ? thisField.name : '';
  const enumValuesText = thisField && Array.isArray(thisField.enumValues)
    ? thisField.enumValues.join(', ')
    : '';
  template = template.split('{{this_field}}').join(thisFieldName);
  template = template.split('{{enum_values}}').join(enumValuesText);

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
    'summary',
    name => resolveSummaryInline(name, summaries),
    /* inline */ true,
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
  template = substituteParameterised(
    template,
    'dynamic',
    name => resolveDynamicInline(name, {
      dynamicContexts:  dynamicContexts  || [],
      fieldsForDynamic: fieldsForDynamic || [],
      fieldValueOf,
      onDynamicResolved,
    }),
    /* inline */ false, // dynamic content can be multi-paragraph — treat as a block
  );

  return template.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Resolve a `{{dynamic:…}}` token against the supplied DC list.
 *
 * The token captured by `substituteParameterised` (regex `[^}\s]+`) is
 * either `FIELD`, `FIELD:SECTION`, or `FIELD:*` — we split on the first
 * `:` and dispatch accordingly.
 *
 * Common steps (every form):
 *   1. Look up the FieldDef whose `name === FIELD` (agent + crew scope).
 *      Missing → return null so the token stays literal — a typo
 *      surfaces loudly rather than silently collapsing.
 *   2. Find a DC whose `fieldId === field.id`. Missing → return ''
 *      (the field exists, just no DC attached).
 *   3. Read the live memory value for that field via `fieldValueOf`.
 *   4. Find the case whose `value === live`. Otherwise treat as a
 *      no-match (uses `dc.fallback` only for the umbrella form).
 *
 * Form-specific:
 *   • `FIELD`           → returns the matched case's `text` (umbrella).
 *                          Falls back to `dc.fallback` if no case matched.
 *   • `FIELD:SECTION`   → returns the matched case's `sections[SECTION].text`.
 *                          Empty when section missing or no case matched
 *                          (fallback is umbrella-only — sections don't
 *                          share a fallback by design).
 *   • `FIELD:*`         → joins every section in the matched case under
 *                          `### name` headings. Empty when no sections
 *                          or no case matched.
 *
 * Side-effect: when an `onDynamicResolved` callback is supplied, fire
 * it with `{ fieldName, section, matched, text }`. The runtime uses
 * this to emit an SSE event so the chat UI can show what was loaded.
 * `section` is `null` for umbrella, the section name for `FIELD:SECTION`,
 * or `'*'` for the all-sections form.
 */
function resolveDynamicInline(rawName, { dynamicContexts, fieldsForDynamic, fieldValueOf, onDynamicResolved }) {
  // Split on the FIRST colon — section names can't contain ':' (the
  // editor sanitises to snake_case) so this is unambiguous.
  const colonIdx = rawName.indexOf(':');
  const fieldName    = colonIdx === -1 ? rawName : rawName.slice(0, colonIdx);
  const sectionPart  = colonIdx === -1 ? null    : rawName.slice(colonIdx + 1);

  const field = fieldsForDynamic.find(f => f && f.name === fieldName);
  if (!field) return null; // leave token literal — loud miss

  const dc = dynamicContexts.find(d => d && d.fieldId === field.id);
  if (!dc) {
    if (onDynamicResolved) onDynamicResolved({ fieldName, section: sectionPart, matched: null, text: '' });
    return '';
  }

  const live = fieldValueOf ? fieldValueOf(fieldName) : undefined;
  const liveStr = live === undefined || live === null ? null : String(live);

  let matched = null;
  let matchedCase = null;
  if (liveStr !== null && Array.isArray(dc.cases)) {
    const hit = dc.cases.find(c => c && String(c.value) === liveStr);
    if (hit) {
      matched = liveStr;
      matchedCase = hit;
    }
  }

  let text = '';
  if (sectionPart === null) {
    // {{dynamic:FIELD}} — umbrella + dc.fallback semantics.
    if (matchedCase) {
      text = matchedCase.text || '';
    } else if (typeof dc.fallback === 'string') {
      text = dc.fallback;
    }
  } else if (sectionPart === '*') {
    // {{dynamic:FIELD:*}} — every section declared on the DC, joined
    // under `### name` headings. Section names live on `dc.sections`
    // (shared across cases); each body comes from
    // `matchedCase.sectionTexts[name]`. Sections with no authored body
    // for the matched case are skipped to keep the prompt clean —
    // empty `### name` blocks are noise the LLM doesn't need.
    if (matchedCase && Array.isArray(dc.sections)) {
      const texts = matchedCase.sectionTexts || {};
      const parts = dc.sections
        .filter(s => s && typeof s.name === 'string')
        .map(s => ({ name: s.name, body: texts[s.name] || '' }))
        .filter(p => p.body.length > 0)
        .map(p => `### ${p.name}\n${p.body}`);
      text = parts.join('\n\n');
    }
  } else {
    // {{dynamic:FIELD:SECTION}} — exact section body for the matched
    // case. Empty when the case has no body authored for it, or when
    // no case matched.
    if (matchedCase && matchedCase.sectionTexts && typeof matchedCase.sectionTexts[sectionPart] === 'string') {
      text = matchedCase.sectionTexts[sectionPart];
    }
  }

  if (onDynamicResolved) onDynamicResolved({ fieldName, section: sectionPart, matched, text });
  return text;
}

module.exports = { assemblePrompt };
