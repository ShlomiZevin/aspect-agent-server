/**
 * Visual-order Hebrew → logical order.
 *
 * Some Qlik exports write Hebrew text in VISUAL order: the characters are
 * stored in the order they appear on screen left-to-right, reversed relative
 * to how Hebrew is typed, and the whole value is wrapped in a Left-to-Right
 * Override (U+202D … U+202C) so a renderer shows it unchanged. Every consumer
 * that does not honour the override — Postgres string matching, the LLM, a
 * table in the chat — sees the words backwards: TheStock's catalogue arrived
 * with all 61,183 item descriptions like 'יללכ רצומ' for 'מוצר כללי'
 * (found 2026-09-25 in a replay of real customer questions).
 *
 * The conversion is the inverse of what produced it. In the visual string,
 * left-to-right runs (Latin, digits, "1.50", "8B OZ", "WATER 31/32") are in
 * their natural order and everything else is mirrored. So:
 *   1. drop the directional formatting characters;
 *   2. find the left-to-right runs in the VISUAL string;
 *   3. emit the segments in reverse order — a run as-is, any other segment
 *      character-reversed with its paired brackets mirrored back.
 *
 * Visual order is lossy: it cannot always tell which of two adjacent runs
 * came first logically. The grouping follows the Unicode bidi rules for the
 * common shapes (see groupRuns) and is checked against real catalogue names
 * in scripts/test-visual-rtl-unit.js.
 *
 * Only values carrying the override marker are touched, so the function is
 * idempotent: a value already converted (or never visual) passes unchanged,
 * and a re-run of the fix migration is harmless.
 */

const LRO = '‭';
const DIRECTIONAL_MARKS = /[‎‏‪-‮⁦-⁩]/g;

// One left-to-right atom: letters/digits/percent with the separators that live
// INSIDE such a token ("1.50", "10-20", "31/32", "M&B"). Spaces between atoms
// are decided by groupRuns(), because whether a space joins two atoms depends
// on direction, not on the characters themselves.
const LTR_ATOM = /[%A-Za-z0-9]+(?:[.,:\/\-+'×&_]*[%A-Za-z0-9]+)*/g;
const LATIN = /[A-Za-z]/;
// What may sit between two atoms of one Latin run: anything but a Hebrew
// letter, which would be a strong right-to-left break.
const NEUTRAL_GAP = /^[^֐-׿]+$/;

const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

function reverse(str) {
  return Array.from(str).reverse().join('');
}

function mirrorBrackets(segment) {
  return segment.replace(/[()[\]{}<>]/g, ch => MIRROR[ch]);
}

/**
 * Left-to-right runs in the VISUAL string, where a run reads in its natural
 * order. An atom joins the run to its left across a neutral gap when that run
 * already holds a Latin letter: after a Latin word the bidi rules make the
 * following digits and the neutrals between them left-to-right ("8B OZ",
 * "HAV. KIDS", "WATER 31/32"). Two bare numbers stay separate: after a Hebrew
 * word the space between them resolves right-to-left and a renderer swapped
 * them ("נשים 3 23225" holds two runs, not one).
 */
function groupRuns(str) {
  const runs = [];
  for (const m of str.matchAll(LTR_ATOM)) {
    const atom = { start: m.index, end: m.index + m[0].length, latin: LATIN.test(m[0]) };
    const prev = runs[runs.length - 1];
    if (prev && prev.latin && NEUTRAL_GAP.test(str.slice(prev.end, atom.start))) {
      prev.end = atom.end;
    } else {
      runs.push(atom);
    }
  }
  return runs;
}

function visualToLogical(value) {
  if (typeof value !== 'string' || !value.includes(LRO)) return value;

  const visual = value.replace(DIRECTIONAL_MARKS, '');

  // Split into alternating segments, in visual order.
  const segments = [];
  let last = 0;
  for (const run of groupRuns(visual)) {
    if (run.start > last) segments.push({ text: visual.slice(last, run.start), ltr: false });
    segments.push({ text: visual.slice(run.start, run.end), ltr: true });
    last = run.end;
  }
  if (last < visual.length) segments.push({ text: visual.slice(last), ltr: false });

  return segments
    .reverse()
    .map(s => (s.ltr ? s.text : mirrorBrackets(reverse(s.text))))
    .join('');
}

module.exports = { visualToLogical };
