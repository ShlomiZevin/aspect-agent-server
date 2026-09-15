/**
 * Result-set declaration → SQL. The server writes every query; the model
 * only ever chose ids that validation already checked against the brief.
 *
 * Guard rails, in the SQL itself:
 *   - identifiers are always double-quoted and always schema-qualified
 *     (CLAUDE.md: an unqualified name can hit the wrong tenant);
 *   - LIMIT is capped at MAX_LIMIT no matter what the spec says;
 *   - division renders as NULLIF so a zero divisor cannot abort the set;
 *   - execution (data.service) wraps every query in a transaction with a
 *     statement_timeout — the compiler emits, the executor caps.
 *
 * The browser never sees any of this: a screen receives rows, not a query
 * surface, which is the structural answer to "a client freezes the DB".
 */

const { parseExpr, parseCondition, toSQL, conditionToSQL } = require('./expressions');
const { resultSetColumns, MAX_LIMIT, DEFAULT_LIMIT } = require('./spec.contract');

/** Quote an identifier. Ids passed validation ([a-z][a-z0-9_]*) but quoting
 *  is cheap insurance against a reserved word ("order", "user"). */
function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Compile one result set against the brief.
 * @returns {{sql: string, columns: string[]}} — columns in output order.
 */
function compileResultSet(rs, brief, schemaName) {
  const source = brief.sources.find(s => s.id === rs.source);
  if (!source) throw new Error(`compile: unknown source '${rs.source}'`);
  const from = `${q(schemaName)}.${q(source.relation)}`;

  const sourceFields = new Map(brief.fields
    .filter(f => f.sourceId === source.id).map(f => [f.id, f]));

  // Resolves a field id to its raw column reference. Only brief fields —
  // computed/measure ids resolve at the layers that define them.
  const rawCol = (fid) => {
    const f = sourceFields.get(fid);
    return f ? q(f.column) : null;
  };

  const selectParts = [];
  const columns = [];

  if (rs.aggregate) {
    for (const g of rs.aggregate.groupBy) {
      selectParts.push(`${rawCol(g)} AS ${q(g)}`);
      columns.push(g);
    }
    for (const m of rs.aggregate.measures) {
      const inner = m.agg === 'count' ? '*' : rawCol(m.field);
      selectParts.push(`${m.agg.toUpperCase()}(${inner})::float8 AS ${q(m.id)}`);
      columns.push(m.id);
    }
  } else {
    for (const fid of rs.select) {
      selectParts.push(`${rawCol(fid)} AS ${q(fid)}`);
      columns.push(fid);
    }
  }

  // Computed columns are expressions over the row the set already produces —
  // inline them over the base expressions (raw columns / aggregates), so one
  // SELECT does the whole job and ORDER BY can reference them by alias.
  const baseExpr = (fid) => {
    if (!rs.aggregate) return rawCol(fid);
    const m = rs.aggregate.measures.find(x => x.id === fid);
    if (m) return `${m.agg.toUpperCase()}(${m.agg === 'count' ? '*' : rawCol(m.field)})::float8`;
    return rs.aggregate.groupBy.includes(fid) ? rawCol(fid) : null;
  };
  for (const c of rs.computed || []) {
    const ast = parseExpr(c.expr);
    selectParts.push(`(${toSQL(ast, baseExpr)}) AS ${q(c.id)}`);
    columns.push(c.id);
  }

  // The row filter. Over raw columns for plain sets; for aggregates it can
  // only reference group-by fields (a measure filter would be HAVING, which
  // the catalog does not offer — a screen that needs it needs a view).
  let whereSql = '';
  if (rs.where) {
    const cond = parseCondition(rs.where);
    const resolveForWhere = (fid) => {
      if (rs.aggregate) return rs.aggregate.groupBy.includes(fid) ? rawCol(fid) : null;
      if (sourceFields.has(fid)) return rawCol(fid);
      const c = (rs.computed || []).find(x => x.id === fid);
      return c ? `(${toSQL(parseExpr(c.expr), baseExpr)})` : null;
    };
    whereSql = ` WHERE ${conditionToSQL(cond, resolveForWhere)}`;
  }

  let groupSql = '';
  if (rs.aggregate) {
    groupSql = ` GROUP BY ${rs.aggregate.groupBy.map(g => rawCol(g)).join(', ')}`;
  }

  let orderSql = '';
  if (rs.orderBy?.field) {
    orderSql = ` ORDER BY ${q(rs.orderBy.field)} ${rs.orderBy.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
  }

  const limit = Math.min(rs.limit || DEFAULT_LIMIT, MAX_LIMIT);
  const sql = `SELECT ${selectParts.join(', ')} FROM ${from}${whereSql}${groupSql}${orderSql} LIMIT ${limit}`;
  return { sql, columns, limit };
}

/**
 * An independent SQL aggregate for one KPI card — the verification side of
 * the cross-check, and the AUTHORITATIVE value delivered to the screen: it
 * runs over the FULL filtered set, not the LIMITed rows the table shows.
 */
function compileKpi(card, rs, brief, schemaName) {
  const source = brief.sources.find(s => s.id === rs.source);
  const from = `${q(schemaName)}.${q(source.relation)}`;
  const sourceFields = new Map(brief.fields
    .filter(f => f.sourceId === source.id).map(f => [f.id, f]));

  if (rs.aggregate) {
    // KPI over an aggregated set: aggregate the aggregate via a subquery on
    // the compiled set itself (without its LIMIT — the KPI covers everything).
    const inner = compileResultSet({ ...rs, limit: MAX_LIMIT }, brief, schemaName).sql;
    return compileKpiOverRows(card, `(${inner}) AS t`, (fid) => q(fid));
  }

  const resolve = (fid) => {
    if (sourceFields.has(fid)) return q(sourceFields.get(fid).column);
    const c = (rs.computed || []).find(x => x.id === fid);
    return c ? `(${toSQL(parseExpr(c.expr), (f) => (sourceFields.has(f) ? q(sourceFields.get(f).column) : null))})` : null;
  };

  let baseWhere = '';
  if (rs.where) baseWhere = conditionToSQL(parseCondition(rs.where), resolve);
  return compileKpiOverRows(card, from, resolve, baseWhere);
}

function compileKpiOverRows(card, from, resolve, baseWhere = '') {
  const clauses = [];
  if (baseWhere) clauses.push(baseWhere);
  if (card.where) clauses.push(conditionToSQL(parseCondition(card.where), resolve));
  const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

  let sel;
  switch (card.agg) {
    case 'count':
    case 'countWhere':
      sel = 'COUNT(*)::float8';
      break;
    case 'sum': sel = `COALESCE(SUM(${resolve(card.field)}), 0)::float8`; break;
    case 'avg': sel = `AVG(${resolve(card.field)})::float8`; break;
    case 'min': sel = `MIN(${resolve(card.field)})::float8`; break;
    case 'max': sel = `MAX(${resolve(card.field)})::float8`; break;
    default: throw new Error(`compileKpi: unknown agg '${card.agg}'`);
  }
  return { sql: `SELECT ${sel} AS value FROM ${from}${whereSql}` };
}

/** Compile everything a spec needs: each result set + each KPI card. */
function compileSpec(spec, brief, schemaName) {
  const resultSets = {};
  for (const rs of spec.resultSets) {
    resultSets[rs.id] = compileResultSet(rs, brief, schemaName);
  }
  const kpis = [];
  for (const block of spec.blocks) {
    if (block.kind !== 'kpiCards') continue;
    const rs = spec.resultSets.find(r => r.id === block.from);
    for (const card of block.cards) {
      kpis.push({ cardId: card.id, ...compileKpi(card, rs, brief, schemaName) });
    }
  }
  return { resultSets, kpis };
}

module.exports = { compileResultSet, compileKpi, compileSpec, q };
