/**
 * Otto's expression grammar — the ONLY computation a screen spec may carry.
 *
 * Arithmetic over declared field ids plus a single comparison for
 * conditions. Deliberately tiny: no function calls, no strings, no boolean
 * chains — an expression that needs more than this belongs in a source view,
 * not in a spec. Never eval'd: parsed here, then either rendered to SQL
 * (compiler) or evaluated over a row (KPI computation and its independent
 * verification probe — two consumers of ONE parse, which is what makes the
 * cross-check meaningful).
 *
 *   expr      := term (('+'|'-') term)*
 *   term      := factor (('*'|'/') factor)*
 *   factor    := number | identifier | '(' expr ')' | '-' factor
 *   condition := expr ('='|'!='|'>'|'>='|'<'|'<=') expr
 */

const IDENT = /^[a-z][a-z0-9_]*$/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src || '');
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = s.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(num)) throw new Error(`bad number '${num}'`);
      tokens.push({ t: 'num', v: Number(num) });
      i = j;
      continue;
    }
    if (/[a-z_]/i.test(ch)) {
      let j = i;
      while (j < s.length && /[a-z0-9_]/i.test(s[j])) j++;
      const id = s.slice(i, j).toLowerCase();
      if (!IDENT.test(id)) throw new Error(`bad identifier '${id}'`);
      tokens.push({ t: 'id', v: id });
      i = j;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['>=', '<=', '!='].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/()=<>'.includes(ch)) { tokens.push({ t: 'op', v: ch }); i++; continue; }
    throw new Error(`unexpected character '${ch}'`);
  }
  return tokens;
}

function parser(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function factor() {
    const tok = peek();
    if (!tok) throw new Error('unexpected end of expression');
    if (tok.t === 'num') { take(); return { k: 'num', v: tok.v }; }
    if (tok.t === 'id') { take(); return { k: 'field', id: tok.v }; }
    if (tok.t === 'op' && tok.v === '-') { take(); return { k: 'neg', e: factor() }; }
    if (tok.t === 'op' && tok.v === '(') {
      take();
      const e = expr();
      const close = take();
      if (!close || close.v !== ')') throw new Error("missing ')'");
      return e;
    }
    throw new Error(`unexpected '${tok.v}'`);
  }

  function term() {
    let left = factor();
    while (peek()?.t === 'op' && ['*', '/'].includes(peek().v)) {
      const op = take().v;
      left = { k: 'bin', op, l: left, r: factor() };
    }
    return left;
  }

  function expr() {
    let left = term();
    while (peek()?.t === 'op' && ['+', '-'].includes(peek().v)) {
      const op = take().v;
      left = { k: 'bin', op, l: left, r: term() };
    }
    return left;
  }

  return { expr, peek, take, done: () => pos >= tokens.length };
}

/** @returns AST for an arithmetic expression. Throws with a named error. */
function parseExpr(src) {
  const p = parser(tokenize(src));
  const ast = p.expr();
  if (!p.done()) throw new Error(`unexpected trailing input in '${src}'`);
  return ast;
}

/** @returns {l, op, r} ASTs for a single comparison. */
function parseCondition(src) {
  const p = parser(tokenize(src));
  const l = p.expr();
  const cmp = p.take();
  if (!cmp || cmp.t !== 'op' || !['=', '!=', '>', '>=', '<', '<='].includes(cmp.v)) {
    throw new Error(`expected a comparison operator in '${src}'`);
  }
  const r = p.expr();
  if (!p.done()) throw new Error(`unexpected trailing input in '${src}'`);
  return { l, op: cmp.v, r };
}

/** Every field id an AST references — what validation checks the whitelist with. */
function fieldsOf(ast, acc = new Set()) {
  if (!ast) return acc;
  if (ast.k === 'field') acc.add(ast.id);
  if (ast.k === 'neg') fieldsOf(ast.e, acc);
  if (ast.k === 'bin') { fieldsOf(ast.l, acc); fieldsOf(ast.r, acc); }
  if (ast.l && ast.op) { fieldsOf(ast.l, acc); fieldsOf(ast.r, acc); }
  return acc;
}

/**
 * Render an AST to SQL. `resolve(fieldId)` returns the SQL expression for a
 * field (a quoted column or a computed sub-expression) — the caller owns the
 * whitelist; this function never sees a raw user string.
 */
function toSQL(ast, resolve) {
  if (ast.k === 'num') return String(ast.v);
  if (ast.k === 'field') {
    const sql = resolve(ast.id);
    if (!sql) throw new Error(`unknown field '${ast.id}'`);
    return sql;
  }
  if (ast.k === 'neg') return `(-${toSQL(ast.e, resolve)})`;
  if (ast.k === 'bin') {
    // NULLIF on the divisor: a zero-stock row must produce NULL, not abort
    // the whole result set with a division error.
    const l = toSQL(ast.l, resolve);
    const r = toSQL(ast.r, resolve);
    if (ast.op === '/') return `(${l} / NULLIF(${r}, 0))`;
    return `(${l} ${ast.op} ${r})`;
  }
  throw new Error('unknown AST node');
}

function conditionToSQL(cond, resolve) {
  const op = cond.op === '=' ? '=' : cond.op === '!=' ? '<>' : cond.op;
  return `(${toSQL(cond.l, resolve)} ${op} ${toSQL(cond.r, resolve)})`;
}

/** Evaluate an AST over one row object. Non-numeric values become NaN, and
 *  NaN propagates — the caller decides what a NaN aggregate means. */
function evalExpr(ast, row) {
  if (ast.k === 'num') return ast.v;
  if (ast.k === 'field') {
    const v = row[ast.id];
    return typeof v === 'number' ? v : Number(v);
  }
  if (ast.k === 'neg') return -evalExpr(ast.e, row);
  if (ast.k === 'bin') {
    const l = evalExpr(ast.l, row);
    const r = evalExpr(ast.r, row);
    switch (ast.op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return r === 0 ? NaN : l / r;
      default: throw new Error('unknown operator');
    }
  }
  throw new Error('unknown AST node');
}

function evalCondition(cond, row) {
  const l = evalExpr(cond.l, row);
  const r = evalExpr(cond.r, row);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  switch (cond.op) {
    case '=': return l === r;
    case '!=': return l !== r;
    case '>': return l > r;
    case '>=': return l >= r;
    case '<': return l < r;
    case '<=': return l <= r;
    default: throw new Error('unknown comparison');
  }
}

module.exports = {
  parseExpr,
  parseCondition,
  fieldsOf,
  toSQL,
  conditionToSQL,
  evalExpr,
  evalCondition,
};
