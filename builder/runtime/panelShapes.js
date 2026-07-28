/**
 * panelShapes — turn a Live Brain panel's raw LLM output into CLEANED
 * render values, or null. Strict: if anything is off (bad JSON, wrong
 * shape, missing numbers) we return null and the caller simply DOESN'T
 * show the panel this turn. No fallbacks, no guessing.
 *
 * For `tags` and `fields` the author can PREDEFINE the fixed part; the
 * `cfg` argument carries it, and the LLM only supplies the dynamic part:
 *   tags  (predefined) → cfg.labels are the labels; LLM returns { active }
 *   tags  (generated)  → LLM returns { tags: [...], active }
 *   fields(predefined) → cfg.keys are the keys;   LLM returns { values: {k:v} }
 *   fields(no keys)    → LLM returns { pairs: [{k,v}] }
 *   bars               → LLM returns { bars:  [{label,value}] }
 *   cards              → LLM returns { cards: [{title,body}] }
 *
 * Each returned object mirrors the client `PanelRuntime` shape:
 *   tags   → { tags: string[], active: string[] }
 *   fields → { pairs: [{ k, v }] }
 *   bars   → { bars:  [{ label, value, color? }] }   value 0–100
 *   cards  → { cards: [{ title, body }] }
 *
 * `text` / `html` renders are handled by the caller (plain strings).
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp01to100(n) {
  return Math.max(0, Math.min(100, n));
}
function toStr(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return String(v);
}
/** Only allow hex colors so a stray string can never do anything odd in
 *  an inline style. Anything else → drop the color (renderer defaults). */
function safeColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : undefined;
}
/** Normalise an `active` value (string | string[]) to a clean string[]. */
function toActiveList(v) {
  if (Array.isArray(v)) return v.map(toStr).filter(Boolean);
  if (v === null || v === undefined || v === '') return [];
  return [toStr(v)];
}

/**
 * @param {string} render
 * @param {*} parsed  the LLM's parsed JSON (or a token-resolved object)
 * @param {{labels?:string[], mode?:string, keys?:string[]}} [cfg] predefined config
 */
function validatePanelValues(render, parsed, cfg = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  switch (render) {
    case 'tags': {
      const predefined = Array.isArray(cfg.labels) && cfg.labels.length > 0
        && cfg.mode !== 'generated';
      let tags;
      if (predefined) {
        tags = cfg.labels.map(toStr).filter(Boolean);
      } else {
        // Generated: prefer an explicit `tags` list; if the model only
        // returned `active`, treat those AS the tags (all shown, none
        // highlighted) so the panel never renders empty.
        if (Array.isArray(parsed.tags)) {
          tags = parsed.tags.map(toStr).filter(Boolean);
        } else {
          const onlyActive = toActiveList(parsed.active);
          if (onlyActive.length === 0) return null;
          return { tags: onlyActive, active: [] };
        }
      }
      if (tags.length === 0) return null;
      // Keep only active values that actually exist in the label set.
      const active = toActiveList(parsed.active).filter(a => tags.includes(a));
      return { tags, active };
    }

    case 'fields': {
      const keys = Array.isArray(cfg.keys) ? cfg.keys.map(toStr).filter(Boolean) : [];
      // Preferred (simple) form is a flat { key: value } object. Also
      // accept a { values: {...} } wrapper or a { pairs: [...] } array.
      const flat = parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values)
        ? parsed.values : parsed;
      let pairs;
      if (keys.length > 0) {
        pairs = keys.map(k => ({ k, v: toStr(flat[k]) }));
      } else if (Array.isArray(parsed.pairs)) {
        pairs = parsed.pairs
          .filter(p => p && typeof p === 'object' && p.k !== undefined && p.k !== null)
          .map(p => ({ k: toStr(p.k), v: toStr(p.v), ...(p.tag ? { tag: true } : {}) }));
      } else {
        pairs = Object.entries(flat)
          .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
          .map(([k, v]) => ({ k: toStr(k), v: toStr(v) }));
      }
      return pairs.length ? { pairs } : null;
    }

    case 'bars': {
      // Preferred (simple) form is a flat { label: number } object. Also
      // accept a { bars: [{label,value}] } array.
      const arr = Array.isArray(parsed.bars)
        ? parsed.bars
        : Object.entries(parsed)
            .filter(([, v]) => toNum(v) !== null)
            .map(([label, value]) => ({ label, value }));
      const bars = arr
        .map(b => {
          if (!b || typeof b !== 'object') return null;
          const value = toNum(b.value);
          if (value === null) return null;
          const color = safeColor(b.color);
          const caption = b.caption != null ? toStr(b.caption) : '';
          return { label: toStr(b.label), value: clamp01to100(value), ...(color ? { color } : {}), ...(caption ? { caption } : {}) };
        })
        .filter(Boolean);
      return bars.length ? { bars } : null;
    }

    case 'cards': {
      // Preferred (simple) form is a flat { title: body } object. Also
      // accept a { cards: [{title,body}] } array.
      const arr = Array.isArray(parsed.cards)
        ? parsed.cards
        : Object.entries(parsed)
            .filter(([, v]) => typeof v === 'string')
            .map(([title, body]) => ({ title, body }));
      const cards = arr
        .filter(c => c && typeof c === 'object' && (c.title !== undefined || c.body !== undefined))
        .map(c => ({ title: toStr(c.title), body: toStr(c.body), ...(c.tag != null && toStr(c.tag) ? { tag: toStr(c.tag) } : {}) }))
        .filter(c => c.title || c.body);
      return cards.length ? { cards } : null;
    }

    case 'journey': {
      // PREFERRED simple/flat form (like the other panels) — status labels
      // as key→value, plus two reserved keys:
      //   { "Current stage":"Trust building", "Missing":"…", "readiness":60, "next":"…" }
      // Also accepts the structured { rows:[{k,v,pill?}], readiness:{value}, next }.
      const RESERVED = new Set(['readiness', 'next', 'rows']);
      let rows;
      if (Array.isArray(parsed.rows)) {
        rows = parsed.rows
          .map(r => (r && typeof r === 'object')
            ? { k: toStr(r.k), v: toStr(r.v), ...(r.pill ? { pill: true } : {}) }
            : null)
          .filter(r => r && (r.k || r.v));
      } else {
        rows = Object.entries(parsed)
          .filter(([k, v]) => !RESERVED.has(k) && String(k).trim() && toStr(v))
          .map(([k, v]) => ({ k: toStr(k), v: toStr(v) }));
      }
      // readiness: a plain number (flat) or { value } (structured).
      const rRaw = parsed.readiness;
      const rNum = (rRaw && typeof rRaw === 'object') ? toNum(rRaw.value) : toNum(rRaw);
      const readiness = rNum !== null
        ? { value: clamp01to100(rNum), ...(rRaw && typeof rRaw === 'object' && rRaw.label ? { label: toStr(rRaw.label) } : {}) }
        : null;
      const next = parsed.next != null ? toStr(parsed.next) : '';
      if (!rows.length && !readiness && !next) return null;
      return { journey: { rows, ...(readiness ? { readiness } : {}), ...(next ? { next } : {}) } };
    }

    default:
      return null;
  }
}

module.exports = { validatePanelValues };
