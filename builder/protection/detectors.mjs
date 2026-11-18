/**
 * Data protection detectors (task #986) — THE one list, shared by the
 * server (builder/protection/index.js loads it with `import()`) and the
 * browser (the client imports it through the `@protection` alias, the
 * same one-source trick as @addons / @triggers). Pure ES module, no
 * dependencies, no I/O — so the same rules run on both sides.
 *
 * Code only, no model: fast and deterministic. A detector finds sensitive
 * personal data in what a CUSTOMER writes, so the message can be stopped
 * before it is saved or reaches any model.
 *
 * Nothing here ever returns the matched text — only which detectors fired
 * and how many times. Callers must keep it that way (the block record
 * stores detector ids only, never the value or a hash of it).
 *
 * Adding a detector = one entry in DETECTORS below (+ its validator). It
 * then appears in the Builder settings, the MCP catalog and the report.
 *
 * Settings live in the agent body (`dataProtection`) and a crew may
 * override detector switches (`crew.dataProtection.detectors`) — see
 * `resolveSettings`. Types: builder/types/index.ts (DataProtectionSettings).
 */

// ─── Normalisation ───────────────────────────────────────────────────

/** Invisible characters people (and Hebrew keyboards) put between digits:
 *  zero-width, bidi marks/embeddings/isolates, soft hyphen, BOM. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** Spaces of every kind → a plain space. */
const SPACES = /[   -   　\t]/g;
/** Dashes of every kind, incl. the Hebrew maqaf (U+05BE) → '-'. */
const DASHES = /[־‐-―−﹘﹣－]/g;

/** Arabic-Indic, Extended Arabic-Indic (Persian) and full-width digits → ASCII. */
function asciiDigits(s) {
  return s.replace(/[٠-٩۰-۹０-９]/g, ch => {
    const c = ch.charCodeAt(0);
    if (c >= 0xFF10) return String(c - 0xFF10);
    if (c >= 0x06F0) return String(c - 0x06F0);
    return String(c - 0x0660);
  });
}

/** The text every detector reads. Same length rules both sides. */
export function normalize(text) {
  return asciiDigits(String(text ?? ''))
    .replace(INVISIBLE, '')
    .replace(SPACES, ' ')
    .replace(DASHES, '-');
}

// ─── Validators ──────────────────────────────────────────────────────

/** Israeli ID (teudat zehut): 9 digits, the last is a check digit. */
function israeliIdValid(d) {
  if (!/^\d{9}$/.test(d) || /^(\d)\1{8}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let v = Number(d[i]) * (i % 2 === 0 ? 1 : 2);
    if (v > 9) v -= 9;
    sum += v;
  }
  return sum % 10 === 0;
}

/** Credit / debit card: 13–19 digits passing the Luhn check. */
function luhnValid(d) {
  if (!/^\d{13,19}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let v = Number(d[i]);
    if (dbl) { v *= 2; if (v > 9) v -= 9; }
    sum += v;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** IBAN: country code + 2 check digits + up to 30 letters/digits, mod-97 == 1. */
function ibanValid(raw) {
  const s = raw.replace(/[ -]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const n = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of n) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

/** Israeli phone: mobile 05X / 07X + 7 digits, landline 02/03/04/08/09 + 7,
 *  with 0 or the 972 country code in front. */
function israeliPhoneValid(d) {
  return /^(?:0|972)(?:5\d|7\d|[23489])\d{7}$/.test(d);
}

// ─── Digit runs ──────────────────────────────────────────────────────
//
// A "run" is a maximal stretch of digits joined only by single spaces or
// dashes, not touching a Latin letter or another digit. Candidates are
// the consecutive GROUPS of a run (split at the separators), never a
// window cut through the middle of a group. So "4580 1234 5678 9012" is
// one card, "123456782 0521234567" is an ID and a phone, and no random
// 9 digits are pulled out of the middle of a long reference number.

const RUN = /(?<![A-Za-z0-9])\+?\d(?:[ -]?\d)*(?![A-Za-z0-9])/g;

function digitRuns(text) {
  const runs = [];
  for (const m of text.matchAll(RUN)) {
    const groups = [];
    const re = /\d+/g;
    let g;
    while ((g = re.exec(m[0])) !== null) groups.push({ digits: g[0], at: m.index + g.index });
    runs.push({ start: m.index, plus: m[0].startsWith('+'), groups });
  }
  return runs;
}

/**
 * Non-overlapping matches over consecutive groups of every run, longest
 * first. `test(digits, {start, plusFirst})` decides a candidate.
 * `maxJoinedGroup`: when a candidate joins several groups, each group may
 * be at most this long (cards are written 4-4-4-4 / 4-6-5 — so an ID and
 * a phone side by side never read as one 19-digit card).
 */
function matchGroups(runs, minLen, maxLen, test, maxJoinedGroup = Infinity) {
  let count = 0;
  for (const run of runs) {
    const n = run.groups.length;
    const used = new Array(n).fill(false);
    // Longest spans first, so a card is never counted as a shorter number.
    for (let span = n; span >= 1; span--) {
      for (let i = 0; i + span <= n; i++) {
        if (used.slice(i, i + span).some(Boolean)) continue;
        if (span > 1 && run.groups.slice(i, i + span).some(g => g.digits.length > maxJoinedGroup)) continue;
        const digits = run.groups.slice(i, i + span).map(g => g.digits).join('');
        if (digits.length < minLen || digits.length > maxLen) continue;
        if (!test(digits, { start: run.groups[i].at, plusFirst: i === 0 && run.plus })) continue;
        for (let k = i; k < i + span; k++) used[k] = true;
        count++;
      }
    }
  }
  return count;
}

/** True when one of `words` appears in the 30 characters before `at`. */
function contextBefore(text, at, words) {
  const window = text.slice(Math.max(0, at - 30), at);
  return words.test(window);
}

const PASSPORT_WORDS = /דרכו[נן]|passport/i;
// Hebrew final nun: "חשבון" (singular, final ן) and "חשבונות" (regular נ).
const ACCOUNT_WORDS = /חשבו[נן]|ח-ן|ח"ן|ח״ן|account|acct|a\/c/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])/g;

// ─── The list ────────────────────────────────────────────────────────

/**
 * Every detector. `defaultOn` = switched on when an author turns data
 * protection on for an agent and has not set that detector yet.
 * `check` gets the normalized text + its digit runs and returns a count.
 */
export const DETECTORS = [
  {
    id: 'il_id',
    name: { en: 'Israeli ID number', he: 'מספר תעודת זהות' },
    matches: {
      en: '9 digits whose last digit is a valid Israeli ID check digit.',
      he: '9 ספרות שהספרה האחרונה בהן היא ספרת ביקורת תקינה של תעודת זהות.',
    },
    defaultOn: true,
    check: (_text, runs) => matchGroups(runs, 9, 9, d => israeliIdValid(d)),
  },
  {
    id: 'credit_card',
    name: { en: 'Credit card number', he: 'מספר כרטיס אשראי' },
    matches: {
      en: '13–19 digits (spaces or dashes allowed) that pass the Luhn check.',
      he: '13–19 ספרות (מותר עם רווחים או מקפים) שעוברות את בדיקת לון.',
    },
    defaultOn: true,
    check: (_text, runs) => matchGroups(runs, 13, 19, d => luhnValid(d), 6),
  },
  {
    id: 'iban',
    name: { en: 'IBAN', he: 'מספר IBAN' },
    matches: {
      en: 'A country code, 2 check digits and the account (e.g. IL62 0108 …), passing the IBAN mod-97 check.',
      he: 'קוד מדינה, 2 ספרות ביקורת ומספר החשבון (למשל IL62 0108 …) שעוברים את בדיקת ה-IBAN.',
    },
    defaultOn: true,
    check: text => [...text.matchAll(IBAN)].filter(m => ibanValid(m[0])).length,
  },
  {
    id: 'bank_account',
    name: { en: 'Bank account number', he: 'מספר חשבון בנק' },
    matches: {
      en: '6–13 digits right after a word such as "account" / "חשבון" (Israeli account numbers have no check digit).',
      he: '6–13 ספרות מיד אחרי מילה כמו "חשבון" / "account" (למספרי חשבון בישראל אין ספרת ביקורת).',
    },
    defaultOn: false,
    check: (text, runs) => matchGroups(runs, 6, 13, (_d, { start }) => contextBefore(text, start, ACCOUNT_WORDS)),
  },
  {
    id: 'passport',
    name: { en: 'Passport number', he: 'מספר דרכון' },
    matches: {
      en: '6–9 digits right after the word "passport" / "דרכון" (passports have no check digit).',
      he: '6–9 ספרות מיד אחרי המילה "דרכון" / "passport" (לדרכון אין ספרת ביקורת).',
    },
    defaultOn: false,
    check: (text, runs) => matchGroups(runs, 6, 9, (_d, { start }) => contextBefore(text, start, PASSPORT_WORDS)),
  },
  {
    id: 'phone',
    name: { en: 'Phone number', he: 'מספר טלפון' },
    matches: {
      en: 'An Israeli mobile or landline number (05X / 07X / 02–09, or +972), or any number written with + and a country code.',
      he: 'מספר נייד או קווי ישראלי (05X / 07X / 02–09, או 972+), או כל מספר שנכתב עם + וקידומת מדינה.',
    },
    defaultOn: false,
    check: (_text, runs) => matchGroups(runs, 8, 15, (d, { plusFirst }) => israeliPhoneValid(d) || (plusFirst && d.length >= 8)),
  },
  {
    id: 'email',
    name: { en: 'Email address', he: 'כתובת מייל' },
    matches: { en: 'An email address.', he: 'כתובת מייל.' },
    defaultOn: false,
    check: text => [...text.matchAll(EMAIL)].length,
  },
];

export const DETECTOR_IDS = DETECTORS.map(d => d.id);

/** The fixed message a customer sees when a message is stopped — used when
 *  the agent has not written its own. */
export const DEFAULT_BLOCKED_MESSAGE = {
  he: 'לא נוכל לעבד את ההודעה כי היא כוללת מידע אישי רגיש (כמו מספר זהות או כרטיס אשראי). אפשר לנסח אותה בלי המידע הזה.',
  en: 'We can\'t process this message because it includes sensitive personal information (such as an ID or credit card number). Please write it again without that information.',
};

/** Longest blocked-message text we accept per language. */
export const MAX_MESSAGE_LENGTH = 600;

// ─── Detection ───────────────────────────────────────────────────────

/**
 * Which of `detectorIds` fire on `text`.
 * @returns {{ id: string, count: number }[]} in catalog order; [] = clean.
 *          Never the matched text.
 */
export function detect(text, detectorIds) {
  const want = new Set(detectorIds || []);
  if (want.size === 0) return [];
  const norm = normalize(text);
  if (!/[0-9@]/.test(norm)) return []; // every detector needs a digit or an @
  const runs = digitRuns(norm);
  const hits = [];
  for (const det of DETECTORS) {
    if (!want.has(det.id)) continue;
    const count = det.check(norm, runs);
    if (count > 0) hits.push({ id: det.id, count });
  }
  return hits;
}

// ─── Settings ────────────────────────────────────────────────────────

/**
 * The settings that apply to ONE message: the agent's, with the current
 * crew's detector switches laid over them (a crew that has to collect,
 * say, the ID turns `il_id` off for itself). A crew can't turn protection
 * on for an agent that has it off.
 *
 * @param {object|undefined} agentDp  agent body `dataProtection`
 * @param {object|undefined} crewDp   crew body `dataProtection`
 * @returns {{ enabled: boolean, detectorIds: string[], blockedMessage: {he: string, en: string},
 *             crewOverrides: string[] }}
 */
export function resolveSettings(agentDp, crewDp) {
  const enabled = !!(agentDp && agentDp.enabled === true);
  const agentSwitches = (agentDp && isPlainObject(agentDp.detectors)) ? agentDp.detectors : {};
  const crewSwitches = (crewDp && isPlainObject(crewDp.detectors)) ? crewDp.detectors : {};
  const detectorIds = [];
  const crewOverrides = [];
  for (const det of DETECTORS) {
    let on = typeof agentSwitches[det.id] === 'boolean' ? agentSwitches[det.id] : det.defaultOn;
    if (typeof crewSwitches[det.id] === 'boolean') {
      if (crewSwitches[det.id] !== on) crewOverrides.push(det.id);
      on = crewSwitches[det.id];
    }
    if (on) detectorIds.push(det.id);
  }
  const msg = (agentDp && isPlainObject(agentDp.blockedMessage)) ? agentDp.blockedMessage : {};
  return {
    enabled,
    detectorIds: enabled ? detectorIds : [],
    blockedMessage: {
      he: nonEmpty(msg.he) || DEFAULT_BLOCKED_MESSAGE.he,
      en: nonEmpty(msg.en) || DEFAULT_BLOCKED_MESSAGE.en,
    },
    crewOverrides,
  };
}

/** The message in the customer's language ('he' | 'en'; anything else → he). */
export function messageFor(settings, lang) {
  return lang === 'en' ? settings.blockedMessage.en : settings.blockedMessage.he;
}

/**
 * Check one message against an agent body + crew body.
 * @returns {null | { detectors: string[], message: string }}  null = let it through.
 */
export function checkMessage(text, agentBody, crewBody, lang) {
  const settings = resolveSettings(agentBody && agentBody.dataProtection, crewBody && crewBody.dataProtection);
  if (!settings.enabled) return null;
  const hits = detect(text, settings.detectorIds);
  if (hits.length === 0) return null;
  return { detectors: hits.map(h => h.id), message: messageFor(settings, lang) };
}

/**
 * Problems in an agent-level `dataProtection` value (empty array = fine).
 * Shape: { enabled?: boolean, detectors?: {id: boolean}, blockedMessage?: {he?, en?} }.
 */
export function agentSettingsProblems(dp) {
  if (!isPlainObject(dp)) return ['dataProtection must be an object'];
  const problems = [];
  for (const k of Object.keys(dp)) {
    if (!['enabled', 'detectors', 'blockedMessage'].includes(k)) problems.push(`unknown key "${k}" (allowed: enabled, detectors, blockedMessage)`);
  }
  if ('enabled' in dp && typeof dp.enabled !== 'boolean') problems.push('enabled must be true or false');
  problems.push(...switchProblems(dp.detectors));
  if ('blockedMessage' in dp) {
    const m = dp.blockedMessage;
    if (!isPlainObject(m)) problems.push('blockedMessage must be { "he": "...", "en": "..." }');
    else {
      for (const k of Object.keys(m)) {
        if (k !== 'he' && k !== 'en') problems.push(`blockedMessage has unknown language "${k}" (he, en)`);
        else if (typeof m[k] !== 'string') problems.push(`blockedMessage.${k} must be text`);
        else if (m[k].length > MAX_MESSAGE_LENGTH) problems.push(`blockedMessage.${k} is longer than ${MAX_MESSAGE_LENGTH} characters`);
      }
    }
  }
  return problems;
}

/** Problems in a crew-level override: { detectors: {id: boolean} } only. */
export function crewSettingsProblems(dp) {
  if (!isPlainObject(dp)) return ['a crew dataProtection must be an object'];
  const problems = [];
  for (const k of Object.keys(dp)) {
    if (k !== 'detectors') problems.push(`unknown key "${k}" — a crew can only override detectors`);
  }
  problems.push(...switchProblems(dp.detectors));
  return problems;
}

function switchProblems(sw) {
  if (sw === undefined) return [];
  if (!isPlainObject(sw)) return ['detectors must be { "<detector id>": true | false }'];
  const problems = [];
  for (const [k, v] of Object.entries(sw)) {
    if (!DETECTOR_IDS.includes(k)) problems.push(`unknown detector "${k}" (known: ${DETECTOR_IDS.join(', ')})`);
    else if (typeof v !== 'boolean') problems.push(`detectors.${k} must be true or false`);
  }
  return problems;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(s) {
  return typeof s === 'string' && s.trim() ? s : '';
}
