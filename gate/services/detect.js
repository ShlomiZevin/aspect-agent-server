/**
 * Lybi Gate — what a field is, and what "convert" makes of it.
 *
 * Detection runs the platform's own data-protection detectors (task #986,
 * builder/protection/detectors.mjs — imported read-only through
 * builder/protection/index.js) over the field's values: ID, card, IBAN,
 * passport, bank account, phone, email. Those carry check digits / formats,
 * so a detector hit is real evidence ("by: detector").
 *
 * Name, birth date, amounts, address and the bank's internal fields have no
 * detector yet — they are recognised by the field's name ("by: name"), and
 * the UI says so.
 *
 * Free text: every number / email / IBAN inside it is checked by the same
 * detectors (with the 30 characters before it, for "passport 12345678") and
 * replaced by its token.
 */

const protection = require('../../builder/protection');
const { token } = require('./crypto');

/** detected type → default action and whether "convert" exists for it. */
const TYPES = {
  il_id:        { by: 'detector', def: 'token' },
  passport:     { by: 'detector', def: 'token' },
  credit_card:  { by: 'detector', def: 'hide' },
  iban:         { by: 'detector', def: 'enc' },
  bank_account: { by: 'detector', def: 'enc' },
  phone:        { by: 'detector', def: 'token' },
  email:        { by: 'detector', def: 'hide' },
  freetext:     { by: 'detector', def: 'conv' },
  fullname:     { by: 'name', def: 'conv' },
  dob:          { by: 'name', def: 'conv' },
  amount:       { by: 'name', def: 'conv' },
  address:      { by: 'name', def: 'conv' },
  internal:     { by: 'name', def: 'hide' },
  plain:        { by: 'none', def: 'pass' },
};
const ACTIONS = ['pass', 'hide', 'token', 'enc', 'conv'];
const CONTEXT_DET = new Set(['passport', 'bank_account']); // the field name is the word before the number

function age(v) {
  let m = String(v).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/); let d;
  if (m) d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  else if ((m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

function band(v) {
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  if (!n) return '0';
  if (n < 6000) return 'עד 6,000 ₪';
  if (n < 9000) return '6,000–9,000 ₪';
  if (n < 12000) return '9,000–12,000 ₪';
  return 'מעל 12,000 ₪';
}

/** The reduced form per type; null = this type has no "convert". */
const CONVERT = {
  credit_card: v => `כרטיס שמסתיים ב־${String(v).replace(/\D/g, '').slice(-4)}`,
  iban: v => `חשבון בבנק ${Number(String(v).replace(/\s/g, '').slice(4, 7))}`,
  phone: v => `מסתיים ב־${String(v).replace(/\D/g, '').slice(-4)}`,
  email: v => `@${String(v).split('@')[1] || ''}`,
  fullname: v => String(v).trim().split(/\s+/)[0],
  dob: v => { const a = age(v); return a == null ? '—' : `גיל ${a}`; },
  amount: v => band(v),
  address: v => { const p = String(v).split(','); return p[p.length - 1].trim(); },
};
const canConvert = type => type === 'freetext' || !!CONVERT[type];

/**
 * Classify one field from its name and a sample of its values.
 * @returns {Promise<{ detected: string, by: string, action: string }>}
 */
async function classify(field, values) {
  const m = await protection.load();
  const ids = m.DETECTOR_IDS;
  const vals = values.map(v => (v == null ? '' : String(v))).filter(v => v.trim() !== '').slice(0, 100);
  const pick = type => ({ detected: type, by: TYPES[type].by, action: TYPES[type].def });
  if (!vals.length) return pick('plain');

  const avgLen = vals.reduce((s, v) => s + v.length, 0) / vals.length;
  const inText = vals.filter(v => m.detect(v, ids).length).length;
  if (inText > 0 && (avgLen > 32 || /note|comment|message|text|הערות|הודעה|תיאור/i.test(field))) return pick('freetext');

  let best = null;
  for (const id of ids) {
    const hit = vals.filter(v => m.detect(CONTEXT_DET.has(id) ? `${field} ${v}` : v, [id]).length).length / vals.length;
    if (hit >= 0.6 && (!best || hit > best.hit)) best = { id, hit };
  }
  if (best) return pick(best.id);

  const h = field.toLowerCase();
  if (/risk|score|internal|סיכון|פנימי/.test(h)) return pick('internal');
  if (/employer|company|branch|status|existing|country|language|מעסיק|סניף|סטטוס|מדינה|שפה/.test(h)) return pick('plain');
  if (/birth|dob|לידה/.test(h)) return pick('dob');
  if (/income|salary|limit|amount|הכנסה|שכר|מסגרת|סכום/.test(h)) return pick('amount');
  if (/address|street|כתובת|רחוב/.test(h)) return pick('address');
  if (/(^|[^a-z])name|fullname|שם/.test(h)) return pick('fullname');
  return pick('plain');
}

const CAND = /(?<![A-Za-z0-9])\+?\d(?:[ -]?\d)*(?![A-Za-z0-9])|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])/g;

/** Free text with every detected item replaced by its token. */
async function scrub(text) {
  const m = await protection.load();
  text = String(text);
  let out = ''; let last = 0;
  for (const c of text.matchAll(CAND)) {
    const before = text.slice(Math.max(0, c.index - 30), c.index).replace(/\d/g, '');
    const hits = m.detect(before + c[0], m.DETECTOR_IDS);
    if (!hits.length) continue;
    out += text.slice(last, c.index) + token(hits[0].id, c[0]);
    last = c.index + c[0].length;
  }
  return out + text.slice(last);
}

/** The converted value of one field (free text → scrubbed). */
async function convert(type, value) {
  if (type === 'freetext') return scrub(value);
  const fn = CONVERT[type];
  return fn ? fn(value) : null;
}

module.exports = { TYPES, ACTIONS, classify, convert, canConvert, scrub };
