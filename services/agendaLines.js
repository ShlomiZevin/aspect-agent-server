/**
 * Agenda topics' checklist lines — pure text functions, no database.
 *
 * An agenda topic (board task, type 'agenda') keeps its points in the
 * description as markdown checklist lines:
 *   - [ ] a point                     (a line; its position = its index)
 *     > החלטה (17.11): …              (quotes under it)
 *     > הערה: Shlomi's note            (the note under it)
 *     - a detail                      (indented details)
 *
 * A line that people comment on (/tasks/actions) carries a stable id at its
 * end, as an HTML comment — invisible wherever the description is rendered:
 *   - [ ] a point <!-- line:3fa9c1 -->
 * The id is stamped by the server the first time someone comments on the
 * line (stampAgendaLineKey). Comments (table agenda_line_comments) point at
 * that id, so they stay with their line through ticks, notes, text edits and
 * lines added before it. Whoever edits a description keeps the marker at the
 * end of its line.
 *
 * A line's `text` never includes the marker: callers address lines by index
 * AND text without it.
 */
const crypto = require('crypto');

const CHECK_RE = /^(\s*)[-*] \[( |x|X)\] ?(.*)$/;
const QUOTE_RE = /^\s*>/;
const NOTE_RE = /^\s*>\s*הערה:/;
const NOTE_PREFIX = '  > הערה: ';
const INDENTED_RE = /^\s+\S/; // a point's indented "  - detail" lines
const ANCHOR_RE = /\s*<!--\s*line:([a-z0-9]{4,16})\s*-->\s*$/i;

/** "a point <!-- line:3fa9c1 -->" → { text: 'a point', key: '3fa9c1' } */
function splitAnchor(rest) {
  const m = rest.match(ANCHOR_RE);
  if (!m) return { text: rest.trim(), key: null };
  return { text: rest.slice(0, m.index).trim(), key: m[1].toLowerCase() };
}

/** Every checklist line, in order: { lineNo, text, key, checked }. */
function listAgendaItems(description) {
  const items = [];
  (description || '').split(/\r?\n/).forEach((line, lineNo) => {
    const m = line.match(CHECK_RE);
    if (!m) return;
    const { text, key } = splitAnchor(m[3]);
    items.push({ lineNo, text, key, checked: m[2] !== ' ' });
  });
  return items;
}

/**
 * The line at `index` if it carries `text`; otherwise the one line with that
 * text. null when the text is gone or ambiguous — never guess.
 */
function findAgendaItem(items, { index, text }) {
  const want = String(text || '').trim();
  if (items[index] && items[index].text === want) return items[index];
  const same = items.filter(it => it.text === want);
  return same.length === 1 ? same[0] : null;
}

function lineGone() {
  const err = new Error('That line moved or changed — reload the agenda');
  err.status = 409;
  return err;
}

/**
 * Returns the new description with one checklist line changed (tick and / or
 * note). Throws { status: 409 } when the line can't be found safely.
 */
function applyAgendaLineChange(description, { index, text, checked, note }) {
  const eol = description.includes('\r\n') ? '\r\n' : '\n';
  const lines = description.split(/\r?\n/);
  const target = findAgendaItem(listAgendaItems(description), { index, text });
  if (!target) throw lineGone();

  const out = lines.slice();
  if (checked !== undefined) {
    out[target.lineNo] = out[target.lineNo].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
  }

  if (note !== undefined) {
    // New notes go right after the quotes under the point (before its
    // indented "  - " detail lines); an existing note is found anywhere in the
    // point's own block (quotes + indented lines that are not checklist lines).
    let end = target.lineNo + 1;
    while (end < out.length && QUOTE_RE.test(out[end])) end++;
    let blockEnd = target.lineNo + 1;
    while (blockEnd < out.length && (QUOTE_RE.test(out[blockEnd]) || (INDENTED_RE.test(out[blockEnd]) && !CHECK_RE.test(out[blockEnd])))) blockEnd++;
    let noteAt = -1;
    for (let i = target.lineNo + 1; i < blockEnd; i++) {
      if (NOTE_RE.test(out[i])) { noteAt = i; break; }
    }
    const clean = typeof note === 'string' ? note.replace(/\s*\r?\n\s*/g, ' ').trim() : '';
    if (clean) {
      const noteLine = NOTE_PREFIX + clean;
      if (noteAt >= 0) out[noteAt] = noteLine;
      else out.splice(end, 0, noteLine);
    } else if (noteAt >= 0) {
      out.splice(noteAt, 1);
    }
  }

  return out.join(eol);
}

/**
 * Makes sure one checklist line carries a stable id. Returns
 * { description, key, text } — `description` unchanged when the line already
 * had one. Throws { status: 409 } when the line can't be found safely.
 * `newKey` is injectable for tests.
 */
function stampAgendaLineKey(description, { index, text }, newKey = () => crypto.randomBytes(3).toString('hex')) {
  const items = listAgendaItems(description);
  const target = findAgendaItem(items, { index, text });
  if (!target) throw lineGone();
  if (target.key) return { description, key: target.key, text: target.text };

  const used = new Set(items.map(it => it.key).filter(Boolean));
  let key = newKey();
  for (let i = 0; used.has(key) && i < 20; i++) key = newKey();
  if (used.has(key)) throw new Error('Could not make a unique line id');

  const eol = description.includes('\r\n') ? '\r\n' : '\n';
  const lines = description.split(/\r?\n/);
  lines[target.lineNo] = `${lines[target.lineNo].replace(/\s+$/, '')} <!-- line:${key} -->`;
  return { description: lines.join(eol), key, text: target.text };
}

module.exports = {
  ANCHOR_RE,
  splitAnchor,
  listAgendaItems,
  findAgendaItem,
  applyAgendaLineChange,
  stampAgendaLineKey,
};
