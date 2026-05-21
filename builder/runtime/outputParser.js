/**
 * Builder V2 — output parser.
 *
 * Parses raw LLM output by the addon's `outputType`:
 *   - 'text-to-user'   → keep as text. parsed = null.
 *   - 'json-to-memory' → lenient JSON extract. parsed = object|null.
 *
 * Lenient extract: tolerates code fences, leading text, trailing
 * commentary. Returns the first parseable JSON object/array. On
 * total failure: parsed = null + error string.
 */

/**
 * Try to find a JSON object/array in a string and parse it.
 * Returns { value, error } — exactly one of them is set.
 */
function extractJSON(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { value: null, error: 'empty output' };
  }

  // Strip common code-fence wrappers.
  let cleaned = text.trim();
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fenced) cleaned = fenced[1].trim();

  // Fast path: the whole thing is JSON.
  try {
    return { value: JSON.parse(cleaned) };
  } catch { /* fall through */ }

  // Slow path: find the first balanced { … } or [ … ].
  const openers = ['{', '['];
  const closers = { '{': '}', '[': ']' };
  for (let start = 0; start < cleaned.length; start++) {
    const c = cleaned[start];
    if (!openers.includes(c)) continue;
    const close = closers[c];
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === c) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const slice = cleaned.slice(start, i + 1);
          try {
            return { value: JSON.parse(slice) };
          } catch (err) {
            return { value: null, error: `JSON parse failed: ${err.message}` };
          }
        }
      }
    }
  }
  return { value: null, error: 'no JSON object/array found in output' };
}

/**
 * Parse output by output type.
 * @param {string} outputType
 * @param {string} rawOutput
 * @returns {{ parsed: any|null, error: string|null }}
 */
function parseOutput(outputType, rawOutput) {
  if (outputType === 'text-to-user') {
    return { parsed: null, error: null };
  }
  if (outputType === 'json-to-memory') {
    const { value, error } = extractJSON(rawOutput);
    return { parsed: value, error: error || null };
  }
  return { parsed: null, error: null };
}

module.exports = { parseOutput, extractJSON };
