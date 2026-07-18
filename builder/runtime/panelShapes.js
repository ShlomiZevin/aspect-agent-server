/**
 * panelShapes — validate a Live Brain panel's raw output against the
 * shape its render type expects, returning CLEANED values or null.
 *
 * The rule (per product decision): if anything is off — bad JSON, wrong
 * shape, missing numbers — we return null and the caller simply DOESN'T
 * show the panel that turn. No fallbacks, no guessing. So this module is
 * strict: it only returns a value object when the output genuinely fits.
 *
 * Each returned object mirrors the `PanelRuntime` shape the client
 * renderer consumes (see LiveBrainScreen/panelRenderers.tsx):
 *   keyvalue → { pairs:  [{ k, v, tag? }] }
 *   goals    → { goals:  [{ label, state, done }] }
 *   bars     → { bars:   [{ label, value, color? }] }   value 0–100
 *   donut    → { donut:  { value, label, items:[{ label, value }] } }
 *
 * `text` render is handled by the caller (it's a plain string, not JSON).
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

function validatePanelValues(render, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  switch (render) {
    case 'keyvalue': {
      if (!Array.isArray(parsed.pairs)) return null;
      const pairs = parsed.pairs
        .filter(p => p && typeof p === 'object' && p.k !== undefined && p.k !== null)
        .map(p => ({ k: toStr(p.k), v: toStr(p.v), ...(p.tag ? { tag: true } : {}) }));
      return pairs.length ? { pairs } : null;
    }

    case 'goals': {
      if (!Array.isArray(parsed.goals)) return null;
      const goals = parsed.goals
        .filter(g => g && typeof g === 'object' && g.label !== undefined && g.label !== null)
        .map(g => ({ label: toStr(g.label), state: toStr(g.state || ''), done: !!g.done }));
      return goals.length ? { goals } : null;
    }

    case 'bars': {
      if (!Array.isArray(parsed.bars)) return null;
      const bars = parsed.bars
        .map(b => {
          if (!b || typeof b !== 'object') return null;
          const value = toNum(b.value);
          if (value === null) return null;
          const color = safeColor(b.color);
          return { label: toStr(b.label), value: clamp01to100(value), ...(color ? { color } : {}) };
        })
        .filter(Boolean);
      return bars.length ? { bars } : null;
    }

    case 'donut': {
      const d = parsed.donut && typeof parsed.donut === 'object' && !Array.isArray(parsed.donut)
        ? parsed.donut : null;
      if (!d) return null;
      const value = toNum(d.value);
      if (value === null) return null;
      const items = (Array.isArray(d.items) ? d.items : [])
        .map(it => {
          if (!it || typeof it !== 'object') return null;
          const v = toNum(it.value);
          if (v === null) return null;
          return { label: toStr(it.label), value: clamp01to100(v) };
        })
        .filter(Boolean);
      return { donut: { value: clamp01to100(value), label: toStr(d.label || ''), items } };
    }

    default:
      return null;
  }
}

module.exports = { validatePanelValues };
