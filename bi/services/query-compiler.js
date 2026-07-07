/**
 * Aspect BI query compiler.
 *
 * Turns a structured query spec into parameterized PostgreSQL. There is no
 * free-text SQL anywhere in the BI API: clients reference whitelisted field
 * ids, and every literal value travels as a bind parameter. SQL fragments come
 * only from the dataset definition (trusted code).
 *
 * Spec shape:
 * {
 *   dimensions: ['store', 'date_month'],          // 0..3 dimension ids
 *   measures:   ['revenue', 'profit'],            // 1..8 measure ids
 *   filters:    [{ field, op, values: [...] }],   // dimension filters
 *   sort:       { field: 'revenue', dir: 'desc' },
 *   limit:      100
 * }
 */

const FIELD_ID_RE = /^[a-z0-9_]+$/;
const MAX_DIMENSIONS = 3;
const MAX_MEASURES = 8;
const MAX_FILTER_VALUES = 200;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

const OPS = {
  eq:       (col, p) => `${col} = ${p(0)}`,
  neq:      (col, p) => `${col} <> ${p(0)}`,
  in:       (col, p) => `${col} = ANY(${p('all')})`,
  not_in:   (col, p) => `${col} <> ALL(${p('all')})`,
  contains: (col, p) => `${col}::text ILIKE '%' || ${p(0)} || '%'`,
  gte:      (col, p) => `${col} >= ${p(0)}`,
  lte:      (col, p) => `${col} <= ${p(0)}`,
  between:  (col, p) => `${col} BETWEEN ${p(0)} AND ${p(1)}`,
  is_null:  (col)    => `${col} IS NULL`,
  not_null: (col)    => `${col} IS NOT NULL`,
};

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function findField(dataset, id, kind) {
  if (typeof id !== 'string' || !FIELD_ID_RE.test(id)) throw fail(`Invalid field id: ${JSON.stringify(id)}`);
  const list = kind === 'measure' ? dataset.measures : dataset.dimensions;
  const field = list.find(f => f.id === id);
  if (!field) throw fail(`Unknown ${kind}: ${id}`);
  return field;
}

/**
 * Compile a query spec against a dataset.
 * @returns {{ sql: string, params: any[] }}
 */
function compileQuery(dataset, spec = {}) {
  const dimensionIds = Array.isArray(spec.dimensions) ? spec.dimensions : [];
  const measureIds = Array.isArray(spec.measures) ? spec.measures : [];
  const filters = Array.isArray(spec.filters) ? spec.filters : [];

  if (measureIds.length < 1) throw fail('At least one measure is required');
  if (measureIds.length > MAX_MEASURES) throw fail(`At most ${MAX_MEASURES} measures allowed`);
  if (dimensionIds.length > MAX_DIMENSIONS) throw fail(`At most ${MAX_DIMENSIONS} dimensions allowed`);
  if (filters.length > 20) throw fail('At most 20 filters allowed');

  const dims = dimensionIds.map(id => findField(dataset, id, 'dimension'));
  const measures = measureIds.map(id => findField(dataset, id, 'measure'));

  const params = [];
  const bind = (value) => { params.push(value); return `$${params.length}`; };
  // Per-measure record_type gate, e.g. FILTER (WHERE f.record_type = $1)
  const rt = (recordType) => `FILTER (WHERE ${dataset.recordTypeColumn} = ${bind(recordType)})`;

  // SELECT list — every output column aliased by its field id
  const selectParts = [];
  for (const d of dims) selectParts.push(`${d.sql} AS "${d.id}"`);
  for (const m of measures) {
    const body = m.expr
      ? m.expr({ rt })
      : `${m.agg}(${m.column}) ${rt(m.recordTypes[0])}`;
    selectParts.push(`${body} AS "${m.id}"`);
  }

  // Joins — union of joins needed by selected dims + filtered dims
  const neededJoins = new Set();
  const collectJoins = (field) => (field.joins || []).forEach(j => neededJoins.add(j));
  dims.forEach(collectJoins);

  // WHERE — narrow the facts scan to only the record types any measure needs
  const whereParts = [];
  const recordTypes = [...new Set(measures.flatMap(m => m.recordTypes))];
  whereParts.push(`${dataset.recordTypeColumn} = ANY(${bind(recordTypes)})`);

  for (const f of filters) {
    if (!f || typeof f !== 'object') throw fail('Invalid filter');
    const dim = findField(dataset, f.field, 'dimension');
    const op = OPS[f.op];
    if (!op) throw fail(`Unknown filter op: ${JSON.stringify(f.op)}`);
    const values = Array.isArray(f.values) ? f.values : [];
    if (values.length > MAX_FILTER_VALUES) throw fail(`At most ${MAX_FILTER_VALUES} filter values allowed`);
    if (!values.every(v => ['string', 'number', 'boolean'].includes(typeof v))) throw fail('Filter values must be scalars');
    const needsValue = !['is_null', 'not_null'].includes(f.op);
    if (needsValue && values.length === 0) throw fail(`Filter on ${dim.id} needs a value`);
    if (f.op === 'between' && values.length !== 2) throw fail('between needs exactly 2 values');

    collectJoins(dim);
    const p = (which) => (which === 'all' ? bind(values) : bind(values[which]));
    whereParts.push(op(dim.sql, p));
  }

  const fromParts = [`${dataset.schema}.${dataset.baseTable} ${dataset.baseAlias}`];
  for (const key of neededJoins) {
    const j = dataset.joins[key];
    if (!j) throw fail(`Dataset misconfiguration: unknown join ${key}`);
    fromParts.push(`LEFT JOIN ${dataset.schema}.${j.table} ${j.alias} ON ${j.on}`);
  }

  // ORDER BY — must reference a selected field; default: first measure DESC
  let orderBy = '';
  const selectedIds = new Set([...dimensionIds, ...measureIds]);
  if (spec.sort && spec.sort.field) {
    if (!selectedIds.has(spec.sort.field)) throw fail('sort.field must be a selected dimension or measure');
    const dir = spec.sort.dir === 'asc' ? 'ASC' : 'DESC';
    orderBy = `ORDER BY "${spec.sort.field}" ${dir} NULLS LAST`;
  } else if (dims.length > 0) {
    orderBy = `ORDER BY "${measures[0].id}" DESC NULLS LAST`;
  }

  const limit = Math.min(Math.max(parseInt(spec.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const sql = [
    `SELECT ${selectParts.join(',\n       ')}`,
    `FROM ${fromParts.join('\n')}`,
    `WHERE ${whereParts.join('\n  AND ')}`,
    dims.length ? `GROUP BY ${dims.map((_, i) => i + 1).join(', ')}` : '',
    orderBy,
    `LIMIT ${limit}`,
  ].filter(Boolean).join('\n');

  return { sql, params };
}

/**
 * Compile a distinct-values query for a dimension (filter pickers).
 * Uses the dimension's small source table when declared (valuesFrom),
 * otherwise scans the base table.
 */
function compileValuesQuery(dataset, fieldId, search) {
  const dim = findField(dataset, fieldId, 'dimension');
  const params = [];

  let from, expr;
  if (dim.valuesFrom) {
    from = `${dataset.schema}.${dim.valuesFrom.from}`;
    expr = dim.valuesFrom.expr;
  } else {
    from = `${dataset.schema}.${dataset.baseTable} ${dataset.baseAlias}`;
    expr = dim.sql;
  }

  const whereParts = [`${expr} IS NOT NULL`, `${expr}::text <> ''`];
  if (search && typeof search === 'string' && search.trim()) {
    params.push(search.trim());
    whereParts.push(`${expr}::text ILIKE '%' || $${params.length} || '%'`);
  }

  const sql = [
    `SELECT DISTINCT ${expr} AS value`,
    `FROM ${from}`,
    `WHERE ${whereParts.join(' AND ')}`,
    'ORDER BY 1',
    'LIMIT 200',
  ].join('\n');

  return { sql, params };
}

module.exports = { compileQuery, compileValuesQuery };
