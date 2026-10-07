/**
 * Query a spreadsheet the user attached in chat (task #100) — over ALL of its
 * rows, exactly. The model cannot add up 99 rows × 33 columns by eye, and a
 * big file does not fit its context at all, so anything counted, totalled,
 * filtered or calculated from the file goes through here.
 *
 * Structured on purpose (no SQL, no eval): filters, computed columns from a
 * small arithmetic grammar over [Column] references, group-by + aggregates,
 * sort, limit. The data is the file's own — nothing here touches a client DB.
 */
const XLSX = require('xlsx');
const db = require('../../services/db.pg');

const MAX_ROWS_OUT = 5000;
const CACHE_SIZE = 20;
const cache = new Map(); // `${id}:${sheet}` -> { columns, rows, sheet }

const norm = s => String(s ?? '').replace(/["'`״׳]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** "4,709" -> 4709, "(173)" -> -173, "12%" -> 12; anything else -> null. */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[,\s₪%]/g, '');
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

async function loadSheet(attachmentId, sheetName) {
  const key = `${attachmentId}:${sheetName || ''}`;
  if (cache.has(key)) return cache.get(key);

  const { rows: found } = await db.query(`SELECT kind, meta, content FROM chat_attachments WHERE id = $1`, [attachmentId]);
  const att = found[0];
  if (!att) throw Object.assign(new Error(`No attached file with id ${attachmentId}`), { status: 404 });
  if (att.kind !== 'spreadsheet' || !att.meta) throw Object.assign(new Error('Only spreadsheet files can be queried this way'), { status: 400 });

  const sheetMeta = sheetName
    ? att.meta.sheets.find(s => norm(s.name) === norm(sheetName))
    : att.meta.sheets.find(s => s.name === att.meta.mainSheet);
  if (!sheetMeta) {
    throw Object.assign(new Error(`No sheet "${sheetName}". Sheets: ${att.meta.sheets.map(s => s.name).join(', ')}`), { status: 400 });
  }

  const wb = XLSX.read(att.content, { type: 'buffer', cellFormula: false });
  const ws = wb.Sheets[sheetMeta.name];
  // raw values: numbers as numbers, and a formula cell's last computed value.
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const columns = sheetMeta.columns.map(c => c.label);
  const rows = [];
  for (let r = sheetMeta.dataStartIndex; r < sheetMeta.dataStartIndex + sheetMeta.dataRowCount; r++) {
    const line = grid[r] || [];
    const row = {};
    for (const c of sheetMeta.columns) {
      const v = line[c.index];
      row[c.label] = typeof v === 'string' ? v.trim() : v;
    }
    rows.push(row);
  }

  const entry = { sheet: sheetMeta.name, columns, letters: Object.fromEntries(sheetMeta.columns.map(c => [c.letter, c.label])), rows };
  cache.set(key, entry);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return entry;
}

// ── Column resolution ────────────────────────────────────────────────────────

function resolver(sheet, extra = []) {
  const all = [...sheet.columns, ...extra];
  return name => {
    if (all.includes(name)) return name;
    const n = norm(name);
    const hit = all.find(c => norm(c) === n) || (sheet.letters[String(name).toUpperCase()] ?? null);
    if (!hit) throw Object.assign(new Error(`Unknown column "${name}". Columns: ${all.join(' | ')}`), { status: 400 });
    return hit;
  };
}

// ── Computed columns: + - * / ( ), numbers, [Column], abs/round/min/max ─────

function compile(expr, resolve) {
  const src = String(expr);
  let i = 0;
  const peek = () => { while (src[i] === ' ') i++; return src[i]; };
  const fail = msg => { throw Object.assign(new Error(`Bad expression "${src}": ${msg}`), { status: 400 }); };

  function primary() {
    const ch = peek();
    if (ch === '(') { i++; const e = sum(); if (peek() !== ')') fail('missing )'); i++; return e; }
    if (ch === '-') { i++; const e = primary(); return row => { const v = e(row); return v == null ? null : -v; }; }
    if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) fail('missing ]');
      const col = resolve(src.slice(i + 1, end));
      i = end + 1;
      return row => toNumber(row[col]);
    }
    const num = /^\d*\.?\d+/.exec(src.slice(i));
    if (num) { i += num[0].length; const n = Number(num[0]); return () => n; }
    const fn = /^(abs|round|min|max)\s*\(/i.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      const args = [sum()];
      while (peek() === ',') { i++; args.push(sum()); }
      if (peek() !== ')') fail('missing ) after function arguments');
      i++;
      const name = fn[1].toLowerCase();
      return row => {
        const vals = args.map(a => a(row));
        if (vals.some(v => v == null)) return null;
        if (name === 'abs') return Math.abs(vals[0]);
        if (name === 'round') { const p = 10 ** (vals[1] || 0); return Math.round(vals[0] * p) / p; }
        return name === 'min' ? Math.min(...vals) : Math.max(...vals);
      };
    }
    fail(`unexpected "${src.slice(i, i + 10)}" — reference columns as [Column name]`);
  }
  function product() {
    let left = primary();
    for (let op = peek(); op === '*' || op === '/'; op = peek()) {
      i++;
      const l = left, r = primary();
      left = op === '*'
        ? row => { const a = l(row), b = r(row); return a == null || b == null ? null : a * b; }
        : row => { const a = l(row), b = r(row); return a == null || b == null || b === 0 ? null : a / b; };
    }
    return left;
  }
  function sum() {
    let left = product();
    for (let op = peek(); op === '+' || op === '-'; op = peek()) {
      i++;
      const l = left, r = product();
      // In a sum an empty cell counts as 0 (an empty "open orders" is none),
      // matching how a spreadsheet's own =K3+J3 treats a blank.
      left = op === '+'
        ? row => { const a = l(row), b = r(row); return a == null && b == null ? null : (a || 0) + (b || 0); }
        : row => { const a = l(row), b = r(row); return a == null && b == null ? null : (a || 0) - (b || 0); };
    }
    return left;
  }

  const fnc = sum();
  if (peek() !== undefined) fail(`unexpected "${src.slice(i, i + 10)}"`);
  return fnc;
}

// ── Filters ──────────────────────────────────────────────────────────────────

function matches(row, f, resolve) {
  const col = resolve(f.column);
  const v = row[col];
  const op = f.op || '=';
  if (op === 'is_empty') return v === null || v === undefined || String(v).trim() === '';
  if (op === 'not_empty') return !(v === null || v === undefined || String(v).trim() === '');
  if (op === 'contains') return String(v ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase());
  if (op === 'in') return (Array.isArray(f.value) ? f.value : String(f.value ?? '').split('|')).some(x => norm(x) === norm(v));
  const a = toNumber(v), b = toNumber(f.value);
  if (a !== null && b !== null) {
    if (op === '=') return a === b;
    if (op === '!=') return a !== b;
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
  }
  if (op === '=') return norm(v) === norm(f.value);
  if (op === '!=') return norm(v) !== norm(f.value);
  return false;
}

// ── The query ────────────────────────────────────────────────────────────────

/**
 * @param {object} spec
 *   sheet?, filters?: [{column, op, value}], computed?: [{as, expr}],
 *   group_by?: string[], aggregates?: [{fn, column?, as?}], select?: string[],
 *   sort?: [{column, dir}], limit?
 * @returns {Promise<{ sheet, columns, rows, matchedRows, totalRows }>}
 */
async function queryFile(attachmentId, spec = {}) {
  const sheet = await loadSheet(attachmentId, spec.sheet);
  const computed = Array.isArray(spec.computed) ? spec.computed : [];
  const resolve = resolver(sheet, computed.map(c => c.as));

  let rows = sheet.rows;
  for (const f of spec.filters || []) rows = rows.filter(r => matches(r, f, resolve));
  const matchedRows = rows.length;

  if (computed.length) {
    const fns = computed.map(c => {
      if (!c.as || !c.expr) throw Object.assign(new Error('Each computed column needs "as" and "expr"'), { status: 400 });
      return { as: c.as, fn: compile(c.expr, resolve) };
    });
    rows = rows.map(r => {
      const out = { ...r };
      for (const c of fns) out[c.as] = c.fn(out);
      return out;
    });
  }

  let columns;
  const groupBy = (spec.group_by || []).map(resolve);
  const aggregates = spec.aggregates || [];
  if (groupBy.length || aggregates.length) {
    const aggs = aggregates.map(a => {
      const fn = String(a.fn || 'sum').toLowerCase();
      const col = a.column ? resolve(a.column) : null;
      if (fn !== 'count' && !col) throw Object.assign(new Error(`Aggregate ${fn} needs a column`), { status: 400 });
      return { fn, col, as: a.as || (col ? `${fn} ${col}` : 'count') };
    });
    const groups = new Map();
    for (const r of rows) {
      const k = JSON.stringify(groupBy.map(g => r[g]));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    rows = [...groups.values()].map(members => {
      const out = {};
      for (const g of groupBy) out[g] = members[0][g];
      for (const a of aggs) {
        const nums = a.col ? members.map(m => toNumber(m[a.col])).filter(n => n !== null) : [];
        if (a.fn === 'count') out[a.as] = a.col ? members.filter(m => m[a.col] !== null && String(m[a.col]).trim() !== '').length : members.length;
        else if (a.fn === 'count_distinct') out[a.as] = new Set(members.map(m => norm(m[a.col]))).size;
        else if (a.fn === 'sum') out[a.as] = nums.reduce((s, n) => s + n, 0);
        else if (a.fn === 'avg') out[a.as] = nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
        else if (a.fn === 'min') out[a.as] = nums.length ? Math.min(...nums) : null;
        else if (a.fn === 'max') out[a.as] = nums.length ? Math.max(...nums) : null;
        else throw Object.assign(new Error(`Unknown aggregate "${a.fn}" (sum, avg, min, max, count, count_distinct)`), { status: 400 });
      }
      return out;
    });
    columns = [...groupBy, ...aggs.map(a => a.as)];
  } else {
    columns = spec.select?.length ? spec.select.map(resolve) : [...sheet.columns, ...computed.map(c => c.as)];
    rows = rows.map(r => Object.fromEntries(columns.map(c => [c, r[c] ?? null])));
  }

  // Sort by what the result HAS — aggregate names ("sold") included.
  const resolveOut = name => {
    const n = norm(name);
    return columns.find(c => c === name) || columns.find(c => norm(c) === n) || resolve(name);
  };
  for (const s of [...(spec.sort || [])].reverse()) {
    const col = resolveOut(s.column);
    const dir = String(s.dir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = toNumber(a[col]), y = toNumber(b[col]);
      if (x !== null && y !== null) return (x - y) * dir;
      return String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * dir;
    });
  }

  const limit = Math.min(Math.max(parseInt(spec.limit, 10) || MAX_ROWS_OUT, 1), MAX_ROWS_OUT);
  return { sheet: sheet.sheet, columns, rows: rows.slice(0, limit), matchedRows, totalRows: sheet.rows.length };
}

module.exports = { queryFile, toNumber, compile };
