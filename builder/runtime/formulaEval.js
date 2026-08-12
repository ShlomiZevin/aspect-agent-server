/**
 * Builder V2 — formula evaluator (Rules addon).
 *
 * Real JavaScript, deliberately fenced to a SINGLE EXPRESSION:
 *   - `{{field}}` tokens are substituted with the field's actual value
 *     BEFORE evaluation (numeric-looking strings become numbers, so
 *     `{{a}} + {{b}}` is math, not string concat; missing fields
 *     become null).
 *   - A lint pass rejects statements/loops/definitions up front with
 *     a plain-language error (`for`, `while`, `function`, `=>`, `;`,
 *     assignment). Builders write conditions and calculations, not
 *     programs.
 *   - Evaluation runs in a bare `vm` context with a hard TIMEOUT —
 *     the backstop that guarantees a runaway formula can never stall
 *     the chain.
 *
 * Errors never throw out of `evaluate` — callers get { ok:false,
 * error } and surface it in the run card. A broken formula fails one
 * action/condition, never the turn.
 */

const vm = require('vm');

const TIMEOUT_MS = 50;
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

const FORBIDDEN = [
  { re: /\b(for|while|do)\b/,            msg: 'loops aren\'t allowed — a formula is a single expression' },
  { re: /\b(function|class)\b/,          msg: 'defining functions isn\'t allowed in a formula' },
  { re: /=>/,                            msg: 'arrow functions aren\'t allowed in a formula' },
  { re: /\b(var|let|const|return)\b/,    msg: 'statements aren\'t allowed — write a single expression' },
  { re: /\b(require|process|globalThis|eval|Function|import)\b/, msg: 'that isn\'t available in formulas' },
  { re: /;/,                             msg: 'a formula is a single expression — remove the ";"' },
  // Assignment (=) but not ==, ===, <=, >=, !=, =>.
  { re: /(^|[^=!<>+\-*/%&|^])=(?![=])/,  msg: 'assignment "=" isn\'t allowed — use "==" to compare' },
];

/** Fixed helpers available inside every formula. Plain JS utilities,
 *  not a language — pure convenience over new Date() arithmetic. */
function buildSandbox() {
  const MS_DAY = 24 * 60 * 60 * 1000;
  const toDate = (v) => {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return {
    Math, Number, String, Boolean, Date, JSON, parseInt, parseFloat, isNaN, isFinite,
    yearsSince: (v) => {
      const d = toDate(v);
      if (!d) throw new Error(`yearsSince: "${v}" is not a valid date`);
      return Math.floor((Date.now() - d.getTime()) / MS_DAY / 365.25);
    },
    daysSince: (v) => {
      const d = toDate(v);
      if (!d) throw new Error(`daysSince: "${v}" is not a valid date`);
      return Math.floor((Date.now() - d.getTime()) / MS_DAY);
    },
    today: () => new Date().toISOString().slice(0, 10),
  };
}

/** Substitute {{field}} tokens with JS literals via the caller's
 *  resolver. Numeric-looking strings become numbers; missing → null. */
function substituteTokens(expr, resolveField) {
  const parts = [];
  const substituted = String(expr).replace(TOKEN_RE, (_, name) => {
    const raw = resolveField(name);
    let literal;
    if (raw === undefined || raw === null || raw === '') {
      literal = 'null';
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      literal = JSON.stringify(raw);
    } else if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
      literal = raw.trim();
    } else {
      literal = JSON.stringify(String(raw));
    }
    parts.push({ token: name, value: literal });
    return literal;
  });
  return { substituted, parts };
}

/**
 * Evaluate a formula.
 * @param {string} expr — the authored formula, `{{field}}` tokens allowed
 * @param {(name: string) => unknown} resolveField — field value lookup
 * @returns {{ ok: boolean, value?: unknown, error?: string, substituted?: string }}
 */
function evaluate(expr, resolveField) {
  const text = String(expr ?? '').trim();
  if (!text) return { ok: false, error: 'empty formula' };

  for (const rule of FORBIDDEN) {
    if (rule.re.test(text)) return { ok: false, error: rule.msg, substituted: text };
  }

  const { substituted } = substituteTokens(text, resolveField);

  try {
    const value = vm.runInNewContext(`( ${substituted} )`, buildSandbox(), {
      timeout: TIMEOUT_MS,
      displayErrors: false,
    });
    if (typeof value === 'function' || (typeof value === 'object' && value !== null && !(value instanceof Date))) {
      return { ok: false, error: 'formula must produce a value (number, text, true/false)', substituted };
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { ok: false, error: 'formula produced an invalid number', substituted };
    }
    return { ok: true, value: value instanceof Date ? value.toISOString().slice(0, 10) : value, substituted };
  } catch (err) {
    const raw = (err && err.message) || 'evaluation failed';
    const friendly = /Script execution timed out/i.test(raw)
      ? `formula took too long (>${TIMEOUT_MS}ms) and was stopped`
      : raw;
    return { ok: false, error: friendly, substituted };
  }
}

module.exports = { evaluate, substituteTokens, TIMEOUT_MS };
