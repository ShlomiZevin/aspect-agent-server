/**
 * Builder V2 — promptAssembler.
 *
 * SOURCE OF TRUTH for prompt assembly. MUST produce the **same
 * output string** as the client's
 * `aspect-react-client/src/builder/components/PromptTemplateModal/buildPromptPreview.ts`
 * given the same inputs. Drift = silent prompt divergence.
 *
 * Substitutes placeholders from `KNOWN_PROMPT_PLACEHOLDERS`:
 *   {{prompt}}, {{persona}}, {{memory}},
 *   {{fields_schema}}, {{fields_current}}
 *
 * History is NOT a placeholder — it's a separate parameter to the
 * LLM. The runtime sends history as the message-history parameter,
 * not interpolated into the prompt string.
 */

/**
 * Substitute placeholders. Empty values collapse the placeholder
 * AND any blank lines around it so the output isn't gappy.
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
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function buildPersonaBlock(personaText, enabled) {
  if (!enabled) return '';
  const text = (personaText || '').trim();
  if (!text) return '';
  return `## Persona\n${text}`;
}

/**
 * `## Memory` block. Runtime contract: include only fields with
 * VALUES, never nulls. Mirrors the client preview.
 *
 * @param {Array<string|null>} selectedDomains — null = "(ungrouped)"
 * @param {(domain: string|null) => Record<string, unknown>} valuesByDomain
 *        — given a domain name (or null), return a key→value map of
 *          fields that have values in that domain. Empty map → empty
 *          JSON object in the block.
 */
function buildMemoryBlock(selectedDomains, valuesByDomain) {
  if (!selectedDomains || selectedDomains.length === 0) return '';
  const sections = selectedDomains.map(d => {
    const label = d === null ? '(ungrouped)' : d;
    const map = valuesByDomain(d) || {};
    return `### ${label}\n${JSON.stringify(map, null, 2)}`;
  });
  return `## Memory\n${sections.join('\n\n')}`;
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
 * @param {object} args.instance     — AddonInstance (has promptTemplate, context, config)
 * @param {string} args.agentPersona — agent's persona text (only used if context.persona)
 * @param {function} args.memoryValuesByDomain — (domain) → map of values for that domain
 * @param {function} args.fieldValueOf — (fieldName) → captured value or undefined
 * @param {Array} [args.extractorFields] — field defs this extractor extracts
 *        (already resolved by the caller from agent.fields ∪ crew.fields
 *        against instance.config.extractsFields). Empty for non-extractor
 *        plugins.
 * @returns {string} the assembled prompt
 */
function assemblePrompt({ instance, agentPersona, memoryValuesByDomain, fieldValueOf, extractorFields }) {
  const template = instance.promptTemplate || '';
  const cfg = instance.config || {};
  const fields = Array.isArray(extractorFields) ? extractorFields : [];

  // Treat as extractor if either: caller supplied field defs OR the
  // template references the extractor placeholders. Keeps the
  // template-driven nature intact while letting non-extractor
  // plugins (Talker, etc.) skip the schema/current blocks.
  const isExtractor = fields.length > 0 || /\{\{fields_(schema|current)\}\}/.test(template);

  return substitute(template, {
    prompt:         cfg.prompt || '',
    persona:        buildPersonaBlock(agentPersona, !!instance.context?.persona),
    memory:         buildMemoryBlock(instance.context?.memoryReads || [], memoryValuesByDomain),
    fields_schema:  isExtractor ? buildFieldsSchemaBlock(fields) : '',
    fields_current: isExtractor ? buildFieldsCurrentBlock(fields, fieldValueOf) : '',
  });
}

module.exports = { assemblePrompt };
