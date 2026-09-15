/**
 * The screen-spec contract — Otto's replacement for generated HTML.
 *
 * A screen is a JSON document: declared result sets (compiled to SQL
 * server-side, never by the model) and a composition of catalog blocks
 * (rendered by the client's own components, never by the model). This file
 * is the validator both the plan step and the build step run behind — the
 * model's output is never stored or rendered until it passes here, and the
 * error strings are the retry feedback, so they name the exact field.
 *
 * Everything the model may reference is enumerable: brief field ids, block
 * kinds, aggregation ops, icons. Free text exists only in labels, and every
 * label carries both locales so one built screen renders in either language.
 */

const { parseExpr, parseCondition, fieldsOf } = require('./expressions');

const BLOCK_KINDS = ['kpiCards', 'filterBar', 'dataTable', 'actionsBar', 'noteLine', 'chart'];
const KPI_AGGS = ['sum', 'count', 'countWhere', 'avg', 'min', 'max'];
const MEASURE_AGGS = ['sum', 'count', 'avg', 'min', 'max'];
const ACTION_TYPES = ['exportCsv', 'stub'];
const TONES = ['normal', 'alarm', 'warn', 'good'];
const ICONS = ['grid', 'box', 'chart', 'truck', 'tag', 'alert', 'list', 'calendar'];
const FORMATS = ['money', 'int', 'decimal', 'percent', 'date', 'text'];
const CHART_VARIANTS = ['line', 'bar', 'pie'];

const MAX_RESULT_SETS = 4;
const MAX_BLOCKS = 10;
const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 500;

const ID_RE = /^[a-z][a-z0-9_]*$/;

function isBilingual(x) {
  return Boolean(x && typeof x.en === 'string' && x.en.trim()
    && typeof x.he === 'string' && x.he.trim());
}

// ── the plan (the human approval gate) ───────────────────────────────────

/**
 * Validate the structured plan the user approves (M3's card). Field
 * references must resolve against the brief; prose must be bilingual.
 * @returns {string[]} error strings — empty means valid.
 */
function validatePlan(plan, brief) {
  const errors = [];
  const fieldIds = new Set((brief?.fields || []).map(f => f.id));
  const sourceIds = new Set((brief?.sources || []).map(s => s.id));

  if (!plan || typeof plan !== 'object') return ['plan is not an object'];
  if (!isBilingual(plan.title)) errors.push('title must carry both en and he');
  if (!isBilingual(plan.summary)) errors.push('summary must carry both en and he');
  if (plan.icon !== undefined && !ICONS.includes(plan.icon)) {
    errors.push(`icon must be one of ${ICONS.join('/')}`);
  }
  if (!Array.isArray(plan.sources) || plan.sources.length === 0) {
    errors.push('sources must be a non-empty array');
  } else for (const s of plan.sources) {
    if (!s?.id || !sourceIds.has(s.id)) errors.push(`source '${s?.id ?? s}' is not in the brief`);
    if (!isBilingual(s?.label)) errors.push(`source '${s?.id}': label must carry both en and he`);
  }

  const refList = (name, arr, { requireField = true } = {}) => {
    if (arr === undefined) return;
    if (!Array.isArray(arr)) { errors.push(`${name} must be an array`); return; }
    arr.forEach((entry, i) => {
      if (!isBilingual(entry?.label)) errors.push(`${name}[${i}]: label must carry both en and he`);
      if (requireField && entry?.field !== undefined && !fieldIds.has(entry.field)) {
        errors.push(`${name}[${i}]: field '${entry.field}' is not in the brief`);
      }
    });
  };
  refList('columns', plan.columns);
  refList('filters', plan.filters);
  refList('kpis', plan.kpis, { requireField: false });
  refList('actions', plan.actions, { requireField: false });
  // Charts got their own plan section after the first manual E2E: a chart
  // asked for in chat had nowhere to live in the plan and was silently
  // dropped from the built screen — the exact omission the design forbids.
  refList('charts', plan.charts, { requireField: false });

  if (plan.notes !== undefined) {
    if (!Array.isArray(plan.notes)) errors.push('notes must be an array');
    else plan.notes.forEach((n, i) => { if (!isBilingual(n)) errors.push(`notes[${i}] must carry both en and he`); });
  }
  if (plan.changes !== undefined) {
    if (!Array.isArray(plan.changes)) errors.push('changes must be an array');
    else plan.changes.forEach((c, i) => { if (!isBilingual(c)) errors.push(`changes[${i}] must carry both en and he`); });
  }
  if (!Array.isArray(plan.columns) || plan.columns.length === 0) {
    errors.push('columns must name at least one field the screen shows');
  }
  return errors;
}

// ── the screen spec (the build artifact) ─────────────────────────────────

/**
 * Every column id a result set exposes to blocks: selected brief fields,
 * computed columns, aggregate group-bys and measures.
 */
function resultSetColumns(rs) {
  const cols = new Set();
  if (rs.aggregate) {
    for (const g of rs.aggregate.groupBy || []) cols.add(g);
    for (const m of rs.aggregate.measures || []) if (m?.id) cols.add(m.id);
  } else {
    for (const f of rs.select || []) cols.add(f);
  }
  for (const c of rs.computed || []) if (c?.id) cols.add(c.id);
  return cols;
}

function validateExprOver(expr, allowed, where, errors, { condition = false } = {}) {
  try {
    const ast = condition ? parseCondition(expr) : parseExpr(expr);
    for (const id of fieldsOf(ast)) {
      if (!allowed.has(id)) errors.push(`${where}: references unknown column '${id}'`);
    }
    return ast;
  } catch (e) {
    errors.push(`${where}: ${e.message}`);
    return null;
  }
}

function validateResultSet(rs, brief, errors) {
  const where = `resultSet '${rs?.id || '(no id)'}'`;
  if (!rs?.id || !ID_RE.test(rs.id)) errors.push(`${where}: id must be a lowercase identifier`);

  const source = (brief.sources || []).find(s => s.id === rs.source);
  if (!source) { errors.push(`${where}: source '${rs?.source}' is not in the brief`); return; }

  const sourceFields = new Map((brief.fields || [])
    .filter(f => f.sourceId === source.id).map(f => [f.id, f]));

  const checkFieldRef = (fid, ctx) => {
    if (!sourceFields.has(fid)) {
      errors.push(`${where}: ${ctx} '${fid}' is not a field of source '${source.id}' — its fields are: ${[...sourceFields.keys()].join(', ')}`);
    }
  };

  if (rs.aggregate) {
    const agg = rs.aggregate;
    if (!Array.isArray(agg.groupBy) || agg.groupBy.length === 0) {
      errors.push(`${where}: aggregate.groupBy must be a non-empty array`);
    } else agg.groupBy.forEach(g => checkFieldRef(g, 'groupBy field'));
    if (!Array.isArray(agg.measures) || agg.measures.length === 0) {
      errors.push(`${where}: aggregate.measures must be a non-empty array`);
    } else for (const m of agg.measures) {
      const mw = `${where} measure '${m?.id || '(no id)'}'`;
      if (!m?.id || !ID_RE.test(m.id)) errors.push(`${mw}: id must be a lowercase identifier`);
      if (!MEASURE_AGGS.includes(m?.agg)) errors.push(`${mw}: agg must be one of ${MEASURE_AGGS.join('/')}`);
      if (m?.agg !== 'count') {
        if (!m?.field) errors.push(`${mw}: field is required for agg '${m?.agg}'`);
        else checkFieldRef(m.field, 'measure field');
      }
      if (!isBilingual(m?.label)) errors.push(`${mw}: label must carry both en and he`);
      if (m?.format !== undefined && !FORMATS.includes(m.format)) errors.push(`${mw}: bad format`);
    }
    if (rs.select?.length) errors.push(`${where}: select and aggregate are mutually exclusive — groupBy IS the row identity`);
  } else {
    if (!Array.isArray(rs.select) || rs.select.length === 0) {
      errors.push(`${where}: select must be a non-empty array of field ids`);
    } else rs.select.forEach(f => checkFieldRef(f, 'selected field'));
  }

  // Computed columns run over the row the set already produces; they may not
  // reference each other (no ordering ambiguity, no cycles by construction).
  const baseCols = new Set(rs.aggregate
    ? [...(rs.aggregate.groupBy || []), ...(rs.aggregate.measures || []).map(m => m?.id)]
    : (rs.select || []));
  if (rs.computed !== undefined) {
    if (!Array.isArray(rs.computed)) errors.push(`${where}: computed must be an array`);
    else for (const c of rs.computed) {
      const cw = `${where} computed '${c?.id || '(no id)'}'`;
      if (!c?.id || !ID_RE.test(c.id)) errors.push(`${cw}: id must be a lowercase identifier`);
      if (baseCols.has(c?.id) || sourceFields.has(c?.id)) errors.push(`${cw}: id collides with an existing column`);
      if (!isBilingual(c?.label)) errors.push(`${cw}: label must carry both en and he`);
      if (c?.format !== undefined && !FORMATS.includes(c.format)) errors.push(`${cw}: bad format`);
      if (typeof c?.expr !== 'string') errors.push(`${cw}: expr must be a string`);
      else validateExprOver(c.expr, baseCols, cw, errors);
    }
  }

  const allCols = resultSetColumns(rs);
  if (rs.where !== undefined) {
    if (typeof rs.where !== 'string') errors.push(`${where}: where must be a condition string`);
    // The row filter runs BEFORE computed columns in SQL terms, but computed
    // columns are plain expressions over the same row, so allowing them here
    // is safe — the compiler inlines them.
    else validateExprOver(rs.where, allCols, `${where} where`, errors, { condition: true });
  }
  if (rs.orderBy !== undefined) {
    if (!rs.orderBy?.field || !allCols.has(rs.orderBy.field)) {
      errors.push(`${where}: orderBy.field must be a column of this result set`);
    }
    if (rs.orderBy?.dir !== undefined && !['asc', 'desc'].includes(rs.orderBy.dir)) {
      errors.push(`${where}: orderBy.dir must be asc or desc`);
    }
  }
  if (rs.limit !== undefined && (!Number.isInteger(rs.limit) || rs.limit < 1 || rs.limit > MAX_LIMIT)) {
    errors.push(`${where}: limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
}

function validateBlock(block, i, spec, brief, errors) {
  const where = `blocks[${i}]`;
  if (!BLOCK_KINDS.includes(block?.kind)) {
    errors.push(`${where}: kind must be one of ${BLOCK_KINDS.join('/')}`);
    return;
  }
  const rsById = Object.fromEntries((spec.resultSets || []).map(r => [r.id, r]));
  const needsFrom = ['kpiCards', 'filterBar', 'dataTable', 'chart'].includes(block.kind);
  const rs = needsFrom ? rsById[block.from] : null;
  if (needsFrom && !rs) {
    errors.push(`${where}: from '${block.from}' is not a declared result set`);
    return;
  }
  const cols = rs ? resultSetColumns(rs) : new Set();

  if (block.kind === 'kpiCards') {
    if (!Array.isArray(block.cards) || block.cards.length === 0 || block.cards.length > 6) {
      errors.push(`${where}: cards must carry 1-6 entries`);
      return;
    }
    for (const card of block.cards) {
      const cw = `${where} card '${card?.id || '(no id)'}'`;
      if (!card?.id || !ID_RE.test(card.id)) errors.push(`${cw}: id must be a lowercase identifier`);
      if (!isBilingual(card?.label)) errors.push(`${cw}: label must carry both en and he`);
      if (card?.sub !== undefined && !isBilingual(card.sub)) errors.push(`${cw}: sub must carry both en and he`);
      if (!KPI_AGGS.includes(card?.agg)) errors.push(`${cw}: agg must be one of ${KPI_AGGS.join('/')}`);
      if (['sum', 'avg', 'min', 'max'].includes(card?.agg)) {
        if (!card?.field || !cols.has(card.field)) errors.push(`${cw}: field must be a column of '${block.from}'`);
      }
      if (card?.agg === 'countWhere' && card?.where === undefined) {
        errors.push(`${cw}: countWhere requires a where condition`);
      }
      if (card?.where !== undefined) validateExprOver(card.where, cols, `${cw} where`, errors, { condition: true });
      if (card?.tone !== undefined && !TONES.includes(card.tone)) errors.push(`${cw}: bad tone`);
      if (card?.format !== undefined && !FORMATS.includes(card.format)) errors.push(`${cw}: bad format`);
    }
  }

  if (block.kind === 'filterBar') {
    if (!Array.isArray(block.filters) || block.filters.length === 0) {
      errors.push(`${where}: filters must be a non-empty array of column ids`);
    } else for (const f of block.filters) {
      if (!cols.has(f)) errors.push(`${where}: filter '${f}' is not a column of '${block.from}'`);
    }
  }

  if (block.kind === 'dataTable') {
    if (!Array.isArray(block.columns) || block.columns.length === 0) {
      errors.push(`${where}: columns must be a non-empty array of column ids`);
    } else for (const c of block.columns) {
      if (!cols.has(c)) errors.push(`${where}: column '${c}' is not a column of '${block.from}'`);
    }
    if (block.pageSize !== undefined && (!Number.isInteger(block.pageSize) || block.pageSize < 5 || block.pageSize > 100)) {
      errors.push(`${where}: pageSize must be an integer between 5 and 100`);
    }
  }

  if (block.kind === 'chart') {
    if (!CHART_VARIANTS.includes(block.variant)) errors.push(`${where}: variant must be one of ${CHART_VARIANTS.join('/')}`);
    if (!block.category || !cols.has(block.category)) errors.push(`${where}: category must be a column of '${block.from}'`);
    if (!Array.isArray(block.series) || block.series.length === 0) {
      errors.push(`${where}: series must be a non-empty array of numeric column ids`);
    } else for (const s of block.series) {
      if (!cols.has(s)) errors.push(`${where}: series column '${s}' is not a column of '${block.from}'`);
    }
    if (!isBilingual(block.title)) errors.push(`${where}: title must carry both en and he`);
  }

  if (block.kind === 'actionsBar') {
    if (!Array.isArray(block.actions) || block.actions.length === 0 || block.actions.length > 4) {
      errors.push(`${where}: actions must carry 1-4 entries`);
      return;
    }
    for (const a of block.actions) {
      const aw = `${where} action '${a?.id || '(no id)'}'`;
      if (!a?.id || !ID_RE.test(a.id)) errors.push(`${aw}: id must be a lowercase identifier`);
      if (!isBilingual(a?.label)) errors.push(`${aw}: label must carry both en and he`);
      if (!ACTION_TYPES.includes(a?.type)) errors.push(`${aw}: type must be one of ${ACTION_TYPES.join('/')}`);
      if (a?.type === 'exportCsv' && !rsById[a?.from]) {
        errors.push(`${aw}: exportCsv requires from = a declared result set`);
      }
      if (a?.type === 'stub' && a?.notice !== undefined && !isBilingual(a.notice)) {
        errors.push(`${aw}: notice must carry both en and he`);
      }
    }
  }

  if (block.kind === 'noteLine') {
    const caveatIds = new Set((brief.caveats || []).map(c => c.id));
    if (!Array.isArray(block.caveatIds) || block.caveatIds.length === 0) {
      errors.push(`${where}: caveatIds must be a non-empty array`);
    } else for (const id of block.caveatIds) {
      // Caveats are QUOTED from the brief, never re-worded — a note the brief
      // does not carry is a note the model invented.
      if (!caveatIds.has(id)) errors.push(`${where}: caveat '${id}' is not in the brief`);
    }
  }
}

/**
 * Validate a full screen spec against the brief.
 * @returns {string[]} error strings — empty means the spec may be stored.
 */
function validateSpec(spec, brief) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];
  if (spec.specVersion !== 1) errors.push('specVersion must be 1');

  if (!Array.isArray(spec.resultSets) || spec.resultSets.length === 0) {
    errors.push('resultSets must be a non-empty array');
  } else {
    if (spec.resultSets.length > MAX_RESULT_SETS) errors.push(`at most ${MAX_RESULT_SETS} result sets`);
    const seen = new Set();
    for (const rs of spec.resultSets) {
      if (rs?.id && seen.has(rs.id)) errors.push(`duplicate result set id '${rs.id}'`);
      if (rs?.id) seen.add(rs.id);
      validateResultSet(rs, brief, errors);
    }
  }

  if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) {
    errors.push('blocks must be a non-empty array');
  } else {
    if (spec.blocks.length > MAX_BLOCKS) errors.push(`at most ${MAX_BLOCKS} blocks`);
    if (Array.isArray(spec.resultSets)) {
      spec.blocks.forEach((b, i) => validateBlock(b, i, spec, brief, errors));
    }
    if (!spec.blocks.some(b => b?.kind === 'dataTable' || b?.kind === 'chart' || b?.kind === 'kpiCards')) {
      errors.push('the screen must contain at least one content block (dataTable, chart or kpiCards)');
    }
  }

  return errors;
}

module.exports = {
  validatePlan,
  validateSpec,
  resultSetColumns,
  BLOCK_KINDS,
  KPI_AGGS,
  MEASURE_AGGS,
  ACTION_TYPES,
  ICONS,
  FORMATS,
  TONES,
  CHART_VARIANTS,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  isBilingual,
};
