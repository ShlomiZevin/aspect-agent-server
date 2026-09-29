/**
 * Builder V2 — promptAssembler.
 *
 * SOURCE OF TRUTH for prompt assembly. The Builder's prompt preview
 * (`aspect-react-client/src/builder/components/PromptPreview/previewSegments.ts`)
 * mirrors its BEHAVIOUR — which tokens resolve, nesting, the self-
 * reference stop, disabled values — as a tree rather than a string, with
 * live-memory tokens shown as chips. Change one, change the other.
 *
 * Vocabulary lives in `aspect-agent-server/builder/promptPlaceholders.json`
 * — the same file Alfred reads. Tokens:
 *
 *   Whole sections:
 *     {{prompt}}, {{persona}}, {{memory}}, {{thinking}}, {{summary}}
 *
 *   Single-domain blocks:
 *     {{memory:NAME}}, {{thinking:NAME}}, {{summary:NAME}}
 *
 *   Single-value inline substitutions:
 *     {{field:NAME}}    — current memory value of one field
 *     {{param:NAME}}    — static agent parameter value
 *
 *   Enum bible:
 *     {{enum:NAME}}            — aggregate of every value's umbrella
 *     {{enum:NAME:SECTION}}    — aggregate of one section across every value
 *     {{dc:FIELD}}             — current matched value's umbrella
 *     {{dc:FIELD:SECTION}}     — current matched value's section body
 *     {{dc:FIELD:*}}           — every authored section under matched value
 *
 *   Snippets (agent-level reusable content, optionally gated):
 *     {{snippet:NAME}}
 *
 *   Extractor-only:
 *     {{fields_schema}}, {{fields_current}},
 *     {{this_field}}    — literal NAME of the (first) extracted field
 *     {{enum_values}}   — comma-separated values of that field's enum
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
 * Personas applicable to an addon via the bare `{{persona}}` token: a
 * persona applies when its `appliesTo` includes the addon's pluginId or
 * the `'*'` wildcard. Order follows the personas array (the Personas
 * page's list order).
 */
function applicablePersonas(personas, pluginId) {
  const list = Array.isArray(personas) ? personas : [];
  return list.filter(p => {
    const a = Array.isArray(p?.appliesTo) ? p.appliesTo : [];
    return a.includes('*') || a.includes(pluginId);
  });
}

/** Find one persona by name (for `{{persona:NAME}}`). */
function findPersonaByName(personas, name) {
  const list = Array.isArray(personas) ? personas : [];
  return list.find(p => p && p.name === name) || null;
}

/**
 * Build the `## Persona` block for the bare `{{persona}}` token from the
 * applicable personas. Empty/blank personas are dropped.
 *   - 0 → '' (token collapses).
 *   - 1 → `## Persona\n<content>`  (unchanged from the single-persona era).
 *   - ≥2 → each as `## Persona: <name>\n<content>`, blank-line separated,
 *          so the LLM can tell them apart.
 */
function buildPersonaBlock(personas) {
  const list = (Array.isArray(personas) ? personas : [])
    .map(p => ({ name: p && p.name, content: ((p && p.content) || '').trim() }))
    .filter(p => p.content);
  if (list.length === 0) return '';
  if (list.length === 1) return `## Persona\n${list[0].content}`;
  return list.map(p => `## Persona: ${p.name}\n${p.content}`).join('\n\n');
}

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

function buildSummaryBlock(summaries) {
  if (!summaries || typeof summaries !== 'object') return '';
  const entries = Object.entries(summaries).filter(
    ([, slot]) => slot && typeof slot.text === 'string' && slot.text.length > 0,
  );
  if (entries.length === 0) return '';
  const sections = entries.map(([name, slot]) => `### ${name}\n${slot.text}`);
  return `## Summary\n${sections.join('\n\n')}`;
}

function resolveSummaryInline(name, summaries) {
  if (!summaries || typeof summaries !== 'object') return '';
  const slot = summaries[name];
  if (!slot || typeof slot.text !== 'string') return '';
  return slot.text;
}

function buildSingleDomainBlock(domainName, valuesByDomain) {
  const map = (valuesByDomain && valuesByDomain(domainName)) || {};
  if (!map || Object.keys(map).length === 0) return '';
  const label = domainName === null || domainName === undefined ? 'general' : domainName;
  return `### ${label}\n${JSON.stringify(map, null, 2)}`;
}

/**
 * Resolve `{{snippet:NAME}}` against the agent's `snippets[]` list.
 * See SnippetDef in types. Mirrors the per-addon Run Filter shape.
 */
function resolveSnippetInline(name, snippets, brain) {
  if (!Array.isArray(snippets) || snippets.length === 0) return '';
  const snip = snippets.find(s => s && s.name === name);
  if (!snip) return '';
  const filter = snip.filter;
  if (filter && Array.isArray(filter.conditions) && filter.conditions.length > 0) {
    const { evaluateConditions } = require('./conditionMatcher');
    const result = evaluateConditions(brain || {}, filter.conditions);
    const mode = filter.mode === 'exclude' ? 'exclude' : 'include';
    const shouldRender = mode === 'include' ? result.ok : !result.ok;
    if (!shouldRender) return '';
  }
  return typeof snip.content === 'string' ? snip.content : '';
}

/**
 * Resolve the `{{tag:NAME}}` family against the agent's field pool.
 * Three shapes share the same prefix:
 *
 *   {{tag:NAME}}           — block: labeled list of "field — howToExtract"
 *                            for every field tagged NAME. Used to say
 *                            "pay attention to these fields" in a prompt.
 *   {{tag:NAME:values}}    — inline: "field_a: <value>, field_b: <value>"
 *                            pairs. Skips fields with null/undefined
 *                            current values. Always includes the field
 *                            name so the values can't be misread.
 *   {{tag:NAME:names}}     — inline: "field_a, field_b" bare comma-
 *                            separated names. The variables themselves.
 *
 * Unknown tag (no field carries it) → `''` so the token collapses
 * cleanly. Unknown shape (typo on the suffix) → `null` so the original
 * token survives and the author sees the typo.
 *
 * `rawName` is whatever followed `tag:` in the token. The resolver
 * splits on `:` to separate tag name from the optional shape suffix.
 */
function resolveTagToken(rawName, { fieldsForDc, fieldValueOf }) {
  if (!rawName) return '';
  const segments = String(rawName).split(':');
  const tagName = segments[0];
  const shape   = segments[1] || null; // 'values' | 'names' | null
  if (!tagName) return '';

  const pool = Array.isArray(fieldsForDc) ? fieldsForDc : [];
  const tagged = pool.filter(f =>
    f && Array.isArray(f.tags) && f.tags.includes(tagName),
  );
  if (tagged.length === 0) return '';

  if (shape === null) {
    // Block form: schema-style "field — howToExtract" list. Wrapped
    // in a labeled header so a Talker prompt knows what it's looking
    // at. Markdown-flavoured to mirror the enum/domain blocks.
    const lines = tagged.map(f => {
      const how = (typeof f.howToExtract === 'string' && f.howToExtract.trim())
        ? f.howToExtract.trim()
        : (typeof f.definition === 'string' ? f.definition.trim() : '');
      return how ? `- ${f.name} — ${how}` : `- ${f.name}`;
    });
    return `### tag — ${tagName}\n${lines.join('\n')}`;
  }

  if (shape === 'values') {
    if (typeof fieldValueOf !== 'function') return '';
    const parts = [];
    for (const f of tagged) {
      const v = fieldValueOf(f.name);
      if (v === null || v === undefined) continue;
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(`${f.name}: ${text}`);
    }
    return parts.join(', ');
  }

  if (shape === 'names') {
    return tagged.map(f => f.name).join(', ');
  }

  // Unknown shape — leave the token in place so the typo is visible.
  return null;
}

function resolveFieldInline(name, fieldValueOf) {
  if (!fieldValueOf) return '';
  const v = fieldValueOf(name);
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function resolveParamInline(name, parameters) {
  if (!Array.isArray(parameters)) return '';
  const found = parameters.find(p => p && p.name === name);
  if (!found) return '';
  const v = found.value;
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Look up an EnumTypeDef by id from the agent's `enums[]`. Helper kept
 * tight because both the schema-block builder and the {{enum:}} / {{dc:}}
 * resolvers want it.
 */
function findEnumById(enums, id) {
  if (!Array.isArray(enums) || !id) return null;
  return enums.find(e => e && e.id === id) || null;
}

function findEnumByName(enums, name) {
  if (!Array.isArray(enums) || !name) return null;
  return enums.find(e => e && e.name === name) || null;
}

/**
 * `## Field schema` block — one line per field.
 *
 *   - <name> (type=<type>, [values=[a, b, c],] source=<source>): <how>
 *
 * For enum-typed fields the values list is resolved by following
 * `field.enumType` → matching `EnumTypeDef.values[].value`. Fields whose
 * enumType points at a missing / empty enum render without the values
 * clause (no crash; just incomplete schema — the validator surfaces it).
 */
function buildFieldsSchemaBlock(fields, enums) {
  if (!fields || fields.length === 0) return '';
  const lines = fields.map(f => {
    const props = [`type=${f.type}`];
    if (f.type === 'enum') {
      const enumDef = findEnumById(enums, f.enumType);
      // Skip values with `enabled === false` — same narrowing the
      // aggregate resolver applies. The extractor should never be
      // asked to classify to a value the author has hidden.
      const vals = enumDef && Array.isArray(enumDef.values)
        ? enumDef.values
            .filter(v => v && v.enabled !== false)
            .map(v => v && v.value)
            .filter(Boolean)
        : [];
      if (vals.length > 0) {
        props.push(`values=[${vals.join(', ')}]`);
      }
    }
    props.push(`source=${f.source}`);
    const head = `- ${f.name} (${props.join(', ')})`;
    const how = (f.howToExtract || '').trim();
    return how ? `${head}: ${how}` : head;
  });
  return lines.join('\n');
}

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

/** Reserved second segment of `{{enum:NAME:…}}` — surfaces the
 *  enum's values list inline. Section names are linted to not collide
 *  with this on the editor side. */
const ENUM_VALUES_KEYWORD = 'values';

/**
 * Resolve `{{enum:NAME}}`, `{{enum:NAME:SECTION}}`, and the reserved
 * `{{enum:NAME:values}}` — STATIC, no brain lookup.
 *
 *   {{enum:NAME}}           → ## NAME ··· every value's umbrella as `### v` blocks
 *   {{enum:NAME:SECTION}}   → ## NAME — SECTION ··· every value's body as `### v` blocks
 *   {{enum:NAME:values}}    → INLINE comma-separated list of the enum's value names
 *
 * Headed-block forms omit values with empty content for the requested
 * slot (no noisy empty `###` blocks).
 *
 * Returns:
 *   - null  when the enum name doesn't exist (token stays literal so a
 *           typo surfaces loudly)
 *   - ''    when the enum exists but has nothing to render
 *   - the rendered text otherwise
 */
function resolveEnumAggregate(rawName, { enums, onEnumResolved }) {
  const colonIdx = rawName.indexOf(':');
  const enumName    = colonIdx === -1 ? rawName : rawName.slice(0, colonIdx);
  const sectionPart = colonIdx === -1 ? null    : rawName.slice(colonIdx + 1);

  const enumDef = findEnumByName(enums, enumName);
  if (!enumDef) return null;

  // Filter out values with `enabled === false` — the per-value master
  // switch. Applied ONCE here so every downstream branch (`:values`
  // inline list, umbrella aggregate, section aggregate) sees the same
  // narrowed set. Undefined `enabled` counts as on, so pre-flag KBs
  // behave identically to before.
  const allValues = Array.isArray(enumDef.values) ? enumDef.values : [];
  const values = allValues.filter(v => !v || v.enabled !== false);

  // Reserved: `{{enum:NAME:values}}` → comma-separated values list.
  // Rendered inline (no headers, no block whitespace) so it slots into
  // prose like: `Allowed values: {{enum:motive:values}}`.
  if (sectionPart === ENUM_VALUES_KEYWORD) {
    const list = values
      .map(v => v && typeof v.value === 'string' ? v.value : null)
      .filter(Boolean)
      .join(', ');
    if (onEnumResolved) onEnumResolved({ enumName, section: ENUM_VALUES_KEYWORD, count: values.length, text: list });
    return list;
  }

  const blocks = [];
  for (const v of values) {
    if (!v || typeof v.value !== 'string') continue;
    let body;
    if (sectionPart === null) {
      body = (v.umbrellaText || '').trim();
    } else {
      const texts = v.sectionTexts || {};
      const raw = texts[sectionPart];
      body = typeof raw === 'string' ? raw.trim() : '';
    }
    if (body.length === 0) continue;
    blocks.push(`### ${v.value}\n${body}`);
  }

  if (blocks.length === 0) {
    if (onEnumResolved) onEnumResolved({ enumName, section: sectionPart, count: 0, text: '' });
    return '';
  }

  const header = sectionPart === null
    ? `## ${enumDef.name}`
    : `## ${enumDef.name} — ${sectionPart}`;
  const text = `${header}\n\n${blocks.join('\n\n')}`;

  if (onEnumResolved) onEnumResolved({ enumName, section: sectionPart, count: blocks.length, text });
  return text;
}

/**
 * Resolve `{{dc:FIELD}}` / `{{dc:FIELD:SECTION}}` / `{{dc:FIELD:*}}` —
 * LIVE lookup against memory.
 *
 * Steps:
 *   1. Look up FieldDef by `name === FIELD` across agent + crew scope.
 *      Missing → return null so the token stays literal (loud miss).
 *   2. Field must be `type === 'enum'` with `enumType` set. Otherwise
 *      → '' (silent — the field exists but isn't an enum field, so
 *      there's nothing to switch on).
 *   3. Find the enum by id on `agent.enums[]`. Missing → ''.
 *   4. Read the field's live memory value via `fieldValueOf`. Find the
 *      value record whose `value === String(live)`. Missing → ''.
 *   5. Render based on form:
 *        FIELD              → matched value's `umbrellaText`, bare
 *        FIELD:SECTION      → matched value's `sectionTexts[SECTION]`, bare
 *        FIELD:*            → every section under the matched value as
 *                             `### name\n<body>` blocks (sections with
 *                             empty bodies omitted)
 *
 * No fallback concept — unmatched / missing → empty string. The author
 * wraps the token in their own fallback prose if needed.
 *
 * Side-effect: fires `onDcResolved({ fieldName, section, matched, text })`
 * if supplied — runtime emits SSE events for the chat trail.
 */
function resolveDcInline(rawName, { enums, fieldsForDc, fieldValueOf, onDcResolved }) {
  const colonIdx = rawName.indexOf(':');
  const fieldName   = colonIdx === -1 ? rawName : rawName.slice(0, colonIdx);
  const sectionPart = colonIdx === -1 ? null    : rawName.slice(colonIdx + 1);

  const field = (fieldsForDc || []).find(f => f && f.name === fieldName);
  if (!field) return null;                             // typo — stay literal

  if (field.type !== 'enum' || !field.enumType) {
    if (onDcResolved) onDcResolved({ fieldName, section: sectionPart, matched: null, text: '' });
    return '';
  }

  const enumDef = findEnumById(enums, field.enumType);
  if (!enumDef || !Array.isArray(enumDef.values)) {
    if (onDcResolved) onDcResolved({ fieldName, section: sectionPart, matched: null, text: '' });
    return '';
  }

  const live = fieldValueOf ? fieldValueOf(fieldName) : undefined;
  const liveStr = live === undefined || live === null ? null : String(live);

  const matchedValue = liveStr === null
    ? null
    : enumDef.values.find(v => v && String(v.value) === liveStr) || null;

  let text = '';
  if (!matchedValue) {
    if (onDcResolved) onDcResolved({ fieldName, section: sectionPart, matched: null, text: '' });
    return '';
  }
  // Disabled value: memory holds it, but no prompt content should
  // reference it. Treat as no-match so the token cleanly collapses.
  if (matchedValue.enabled === false) {
    if (onDcResolved) onDcResolved({ fieldName, section: sectionPart, matched: null, text: '' });
    return '';
  }

  if (sectionPart === null) {
    text = (matchedValue.umbrellaText || '').trim();
  } else if (sectionPart === '*') {
    const declared = Array.isArray(enumDef.sections) ? enumDef.sections : [];
    const texts = matchedValue.sectionTexts || {};
    const parts = declared
      .filter(s => s && typeof s.name === 'string')
      .map(s => ({ name: s.name, body: (texts[s.name] || '').trim() }))
      .filter(p => p.body.length > 0)
      .map(p => `### ${p.name}\n${p.body}`);
    text = parts.join('\n\n');
  } else {
    const raw = matchedValue.sectionTexts && matchedValue.sectionTexts[sectionPart];
    text = typeof raw === 'string' ? raw.trim() : '';
  }

  if (onDcResolved) {
    onDcResolved({ fieldName, section: sectionPart, matched: liveStr, text });
  }
  return text;
}

// `{{# note }}` — builder-only comments inside prompts, never sent to the
// LLM (task #831). The space after `#` is required: `{{#name}}` without a
// space is a parameter reference in rule formulas, never a comment. The
// body may span lines but can't contain `}}`, so a comment never swallows
// a real token that follows it. Whole-line comments take their newline.
const COMMENT_LINE_RE = /^[ \t]*\{\{#\s(?:(?!\}\})[\s\S])*\}\}[ \t]*(?:\r?\n|$)/gm;
const COMMENT_RE = /\{\{#\s(?:(?!\}\})[\s\S])*\}\}/g;

function stripPromptComments(text) {
  if (typeof text !== 'string' || !text.includes('{{#')) return text;
  return text.replace(COMMENT_LINE_RE, '').replace(COMMENT_RE, '');
}

/**
 * How deep inserted content is itself resolved (task #867). A Targeted KB
 * value can pull in another value, which can pull in a snippet… four
 * levels is far past any sane authoring and still stops a runaway.
 */
const MAX_NEST_DEPTH = 4;

/**
 * `{{targetedkb:NAME=VALUE}}` / `{{targetedkb:NAME=VALUE:SECTION}}` (and the
 * `enum:` spelling) — ONE specific value, statically (task #867). The
 * colon forms can't do this: `NAME:SECTION` already means "that section
 * across every value". Bare content, like `{{dc:…}}`.
 *
 * Returns null (token stays literal, so a typo is visible) for an unknown
 * KB or value; '' for a disabled value or an empty body.
 */
function resolveEnumValue(enumName, valueName, sectionPart, { enums, onEnumResolved }) {
  const enumDef = findEnumByName(enums, enumName);
  if (!enumDef || !Array.isArray(enumDef.values)) return null;
  const v = enumDef.values.find(x => x && String(x.value) === valueName);
  if (!v) return null;
  let text = '';
  if (v.enabled !== false) {
    const raw = sectionPart ? (v.sectionTexts || {})[sectionPart] : v.umbrellaText;
    text = typeof raw === 'string' ? raw.trim() : '';
  }
  if (onEnumResolved) {
    onEnumResolved({ enumName, section: sectionPart ? `${valueName}:${sectionPart}` : valueName, count: text ? 1 : 0, text });
  }
  return text;
}

// Value names may contain spaces, so this form gets its own pattern
// rather than the generic `[^}\s]+` one.
const ENUM_VALUE_RE = /\{\{(?:enum|targetedkb):([^:=}\s]+)=([^:}]+?)(?::([^:}\s]+))?\}\}/g;

/**
 * Assemble the prompt for an addon instance.
 *
 * @param {object} args
 * @param {object} args.instance       — AddonInstance
 * @param {Array}  args.personas — agent personas ({id,name,content,appliesTo}); `{{persona}}` uses those applicable to this addon, `{{persona:NAME}}` picks one by name
 * @param {function} args.memoryValuesByDomain
 * @param {function} args.thinkingValuesByDomain
 * @param {function} args.fieldValueOf
 * @param {Array}    [args.extractorFields] — field defs this extractor extracts
 * @param {Array}    [args.parameters]      — agent.parameters
 * @param {Array}    [args.enums]           — agent.enums[] — drives both
 *        `{{enum:...}}` (aggregate) and `{{dc:...}}` (live-value lookup).
 * @param {Array}    [args.fieldsForDc] — agent + crew field defs in scope
 *        for `{{dc:FIELD...}}` lookups (we resolve fieldId by name from this).
 * @param {function} [args.onEnumResolved] — `({ enumName, section, count, text }) => void`.
 * @param {function} [args.onDcResolved]   — `({ fieldName, section, matched, text }) => void`.
 * @param {object}   [args.summaries]
 * @param {Array}    [args.snippets]
 * @param {object}   [args.brain] — needed by snippet filter evaluation
 * @returns {string} the assembled prompt
 */
function assemblePrompt({
  instance,
  personas,
  memoryValuesByDomain,
  memoryDomainList,
  thinkingValuesByDomain,
  thinkingDomainList,
  retrievalValueOf,
  fieldValueOf,
  extractorFields,
  parameters,
  enums,
  fieldsForDc,
  onEnumResolved,
  onDcResolved,
  summaries,
  snippets,
  brain,
}) {
  let template = instance.promptTemplate || '';
  const cfg = instance.config || {};
  const fields = Array.isArray(extractorFields) ? extractorFields : [];

  const ctx = {
    pluginId:       instance.pluginId,
    personas,
    memoryReader:   memoryValuesByDomain   || (() => ({})),
    thinkingReader: thinkingValuesByDomain || (() => ({})),
    memoryDomainList,
    thinkingDomainList,
    retrievalValueOf,
    fieldValueOf,
    fields,
    // Decided on the addon's OWN template, before anything is inserted.
    isExtractor:    fields.length > 0 || /\{\{fields_(schema|current)\}\}/.test(template),
    parameters,
    enumsList:      Array.isArray(enums) ? enums : [],
    fieldsForDc:    fieldsForDc || [],
    onEnumResolved,
    onDcResolved,
    summaries,
    snippets,
    brain,
    kbSlots:        [],   // retrieved KB text, restored after every pass
  };

  // {{prompt}} expands first so any token the user authored inside
  // `config.prompt` (e.g. `@customer_age` → `{{field:customer_age}}`)
  // becomes visible to the passes below. Top level only — a value that
  // contains {{prompt}} does not re-insert the addon's prompt.
  template = template.split('{{prompt}}').join(cfg.prompt || '');
  template = resolveTokens(template, ctx, 0, []);
  template = template.replace(/\u0000KB(\d+)\u0000/g, (_, i) => ctx.kbSlots[Number(i)]);

  return template.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Every token pass, in order, over one piece of text.
 *
 * Task #867: text INSERTED by a snippet, persona, Targeted KB (`enum:` /
 * `targetedkb:`) or `dc:` token is run through this same function before
 * it lands (`nest` below), so every syntax works inside inserted content —
 * a value pulling in another value included. It used to be one
 * `String.replace` per prefix, and replace never rescans what it just
 * inserted: a token inside a value resolved only if its pass happened to
 * run later, so `{{dc:…}}` / `{{targetedkb:…}}` inside a value stayed raw.
 *
 * Guards: depth (MAX_NEST_DEPTH), and a token already being expanded
 * higher up the chain is left as written instead of looping. Retrieved KB
 * text (`{{kb:…}}`) is NEVER re-resolved — it is document content.
 */
function resolveTokens(template, c, depth, stack) {
  // `guard` runs a resolver unless its token is already being expanded
  // higher up the chain — then the token stays exactly as written (null =
  // leave literal). `nest` then resolves whatever the resolver inserted.
  const guard = (key, resolve) => (stack.includes(key) ? null : nest(key, resolve()));
  const nest = (key, body) => {
    if (typeof body !== 'string' || !body.includes('{{')) return body;
    if (depth >= MAX_NEST_DEPTH) return body;
    return resolveTokens(body, c, depth + 1, [...stack, key]);
  };
  const { fields, enumsList, fieldsForDc, fieldValueOf } = c;

  // Comments go before any token resolves, so a token inside a comment
  // never runs (no DC/enum resolution events for commented-out text).
  template = stripPromptComments(template);

  // Snippet pass FIRST — see resolveSnippetInline.
  template = substituteParameterised(
    template,
    'snippet',
    name => guard(`snippet:${name}`, () => resolveSnippetInline(name, c.snippets, c.brain)),
    /* inline */ true,
  );
  template = stripPromptComments(template); // comments written inside snippet bodies

  // Named-persona tokens `{{persona:NAME}}` — resolve to that persona's
  // raw content (composable inline). Unknown name → left in place so the
  // author sees the typo.
  template = substituteParameterised(
    template,
    'persona',
    name => {
      const p = findPersonaByName(c.personas, name);
      if (!p) return null;
      return guard(`persona:${name}`, () => (p.content || '').trim());
    },
    /* inline */ true,
  );

  // Flat whole-section tokens.
  template = substitute(template, {
    persona:        nest('persona', buildPersonaBlock(applicablePersonas(c.personas, c.pluginId))),
    memory:         buildMemoryBlock(c.memoryDomainList   || (() => []), c.memoryReader),
    thinking:       buildThinkingBlock(c.thinkingDomainList || (() => []), c.thinkingReader),
    summary:        buildSummaryBlock(c.summaries),
    fields_schema:  c.isExtractor ? buildFieldsSchemaBlock(fields, enumsList) : '',
    fields_current: c.isExtractor ? buildFieldsCurrentBlock(fields, fieldValueOf) : '',
  });

  // Single-field inline tokens — `{{this_field}}` and `{{enum_values}}`
  // are tied to the FIRST extractor field (Field Reasoner constrains to
  // one; multi-field extractors still resolve to their first).
  const thisField = c.isExtractor && fields.length > 0 ? fields[0] : null;
  const thisFieldName  = thisField ? thisField.name : '';
  let enumValuesText = '';
  if (thisField && thisField.type === 'enum') {
    const enumDef = findEnumById(enumsList, thisField.enumType);
    if (enumDef && Array.isArray(enumDef.values)) {
      enumValuesText = enumDef.values
        .filter(v => v && v.enabled !== false)  // Skip disabled values.
        .map(v => v && v.value)
        .filter(Boolean)
        .join(', ');
    }
  }
  template = template.split('{{this_field}}').join(thisFieldName);
  template = template.split('{{enum_values}}').join(enumValuesText);

  // Multi-field inline counterpart — comma-separated list of wired
  // field NAMES.
  const theseFieldsText = c.isExtractor
    ? fields.map(f => f && f.name).filter(Boolean).join(', ')
    : '';
  template = template.split('{{these_fields}}').join(theseFieldsText);

  // Parameterised tokens — same order as before.
  template = substituteParameterised(
    template,
    'memory',
    name => buildSingleDomainBlock(name, c.memoryReader),
    /* inline */ false,
  );
  template = substituteParameterised(
    template,
    'thinking',
    name => buildSingleDomainBlock(name, c.thinkingReader),
    /* inline */ false,
  );
  template = substituteParameterised(
    template,
    'summary',
    name => resolveSummaryInline(name, c.summaries),
    /* inline */ true,
  );
  template = substituteParameterised(
    template,
    'field',
    name => resolveFieldInline(name, fieldValueOf),
    /* inline */ true,
  );
  // {{fieldname:NAME}} — literal field NAME (not value). Unknown names
  // stay literal (token survives in the prompt) so typos surface loudly.
  template = substituteParameterised(
    template,
    'fieldname',
    name => {
      const field = fieldsForDc.find(f => f && f.name === name);
      return field ? field.name : null;
    },
    /* inline */ true,
  );
  template = substituteParameterised(
    template,
    'param',
    name => resolveParamInline(name, c.parameters),
    /* inline */ true,
  );

  // One specific Targeted KB value — `{{targetedkb:NAME=VALUE[:SECTION]}}`.
  // Before the aggregate passes, whose patterns would otherwise read the
  // `=` form as a name.
  template = template.replace(ENUM_VALUE_RE, (match, enumName, valueName, section) => {
    const out = guard(`tkb:${enumName}=${valueName.trim()}:${section || ''}`, () => resolveEnumValue(
      enumName, valueName.trim(), section || null, { enums: enumsList, onEnumResolved: c.onEnumResolved },
    ));
    return out === null || out === undefined ? match : out;
  });

  // Enum aggregate — static, no field lookup.
  //   • {{enum:NAME:values}} — inline values list (slots into prose).
  //   • {{enum:NAME[:SECTION]}} — headed block (`## NAME[ — SECTION]`).
  // `targetedkb:` is the same resolver under the name the UI uses.
  template = template.replace(/\{\{(?:enum|targetedkb):([^:}\s]+):values\}\}/g, (match, name) => {
    const out = resolveEnumAggregate(`${name}:values`, { enums: enumsList, onEnumResolved: c.onEnumResolved });
    return out === null || out === undefined ? match : out;
  });
  template = substituteParameterised(
    template,
    'enum',
    name => guard(`tkb:${name}`, () => resolveEnumAggregate(name, { enums: enumsList, onEnumResolved: c.onEnumResolved })),
    /* inline */ false,
  );
  template = substituteParameterised(
    template,
    'targetedkb',
    name => guard(`tkb:${name}`, () => resolveEnumAggregate(name, { enums: enumsList, onEnumResolved: c.onEnumResolved })),
    /* inline */ false,
  );

  // DC live-value lookup — follows field.enumType → enum → matched value.
  template = substituteParameterised(
    template,
    'dc',
    name => guard(`dc:${name}`, () => resolveDcInline(name, {
      enums:        enumsList,
      fieldsForDc,
      fieldValueOf,
      onDcResolved: c.onDcResolved,
    })),
    /* inline */ false,
  );

  // Tag aggregate — `{{tag:NAME[:values|:names]}}`. Inline variants run
  // first so the bare block pass below doesn't consume their suffixes.
  template = template.replace(/\{\{tag:([^:}\s]+):values\}\}/g, (match, name) => {
    const out = resolveTagToken(`${name}:values`, { fieldsForDc, fieldValueOf });
    return out === null || out === undefined ? match : out;
  });
  template = template.replace(/\{\{tag:([^:}\s]+):names\}\}/g, (match, name) => {
    const out = resolveTagToken(`${name}:names`, { fieldsForDc, fieldValueOf });
    return out === null || out === undefined ? match : out;
  });
  template = substituteParameterised(
    template,
    'tag',
    name => resolveTagToken(name, { fieldsForDc, fieldValueOf }),
    /* inline */ false,
  );

  // KB Retriever injection — `{{kb:NAME}}` renders the slot a KB Retriever
  // wrote upstream this turn. Never blank.
  //
  // Retrieved text is DOCUMENT content: a `{{` inside a document must never
  // run. It is held aside as an opaque placeholder and put back only by
  // assemblePrompt at the very end, so no pass — here or in an outer
  // nested call — can see it. (The second pass below used to turn
  // `{{param:…}}` inside retrieved chunks into values.)
  const retrievalReader = c.retrievalValueOf || (() => undefined);
  template = substituteParameterised(
    template,
    'kb',
    name => {
      const v = retrievalReader(name);
      const text = (v && String(v).trim())
        ? String(v)
        : 'No relevant information was found in the knowledge base.';
      c.kbSlots.push(text);
      return `\u0000KB${c.kbSlots.length - 1}\u0000`;
    },
    /* inline */ true,
  );

  // Second pass for inline tokens INLINED above by a resolver that does
  // not nest (tag bodies, field-schema text). Nested bodies arrive fully
  // resolved already, so for them this is a no-op.
  template = substituteParameterised(
    template,
    'field',
    name => resolveFieldInline(name, fieldValueOf),
    /* inline */ true,
  );
  template = substituteParameterised(
    template,
    'fieldname',
    name => {
      const field = fieldsForDc.find(f => f && f.name === name);
      return field ? field.name : null;
    },
    /* inline */ true,
  );
  template = substituteParameterised(
    template,
    'param',
    name => resolveParamInline(name, c.parameters),
    /* inline */ true,
  );
  template = substituteParameterised(
    template,
    'summary',
    name => resolveSummaryInline(name, c.summaries),
    /* inline */ true,
  );

  // Last sweep: comments inside inlined bodies.
  return stripPromptComments(template);
}

module.exports = { assemblePrompt, stripPromptComments };
