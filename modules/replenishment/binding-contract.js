/**
 * Smart Replenishment — the binding contract.
 *
 * A "binding" is the mapping from ONE client's schema to the concepts this
 * module needs: which rows are demand, which are stock, which are on order,
 * which column is the supplier, which key joins what. The init LLM produces
 * it; a deterministic generator (./templates.js) turns it into DDL.
 *
 * THE POINT OF THIS FILE: it makes the model's job enumerable. The LLM picks
 * table and column names and a handful of quirk flags — it never writes SQL
 * that ships and never does arithmetic. That is why the ≤5-round
 * bind → build → verify loop can converge at all: a failed probe names
 * exactly which mapping to reconsider, instead of "the SQL was wrong
 * somehow".
 *
 * Everything here is data + validation. No SQL, no LLM call.
 */

/**
 * Probe thresholds. These are the numbers verify() checks the built views
 * against, and they are deliberately in one place so a reviewer can see the
 * whole bar at once rather than hunting through query code.
 */
const THRESHOLDS = {
  /**
   * What fraction of demand rows must resolve to a catalog item.
   * ZolStock measures 99.9% on the sales key and ~0% on the replenishment
   * key — that gap IS the mis-mapping this probe exists to catch, and it is
   * the exact failure the round loop is designed to recover from.
   */
  demandJoinRate: 0.95,

  /**
   * What fraction of items may carry a replenishment key. Deliberately tiny:
   * on ZolStock only 14,649 of 298,555 items (4.9%) have a SKU at all, which
   * is a known, documented property of the feed rather than a mapping error.
   * The probe exists to catch ZERO — a binding that mapped the wrong column
   * entirely — not to demand good coverage.
   */
  replenishmentKeyRate: 0.001,

  /** At least this many rows must land in the base view, or the mapping is wrong. */
  minBaseRows: 100,

  /** At least this fraction of base rows must have some demand history. */
  velocityCoverage: 0.10,

  /** Spot aggregates must match the raw tables within this relative tolerance. */
  aggregateTolerance: 0.0001,
};

/**
 * Quirks a binding may declare. Each one changes rendered SQL or the
 * annotations attached to an answer, so an unknown quirk is a mapping error
 * rather than something to ignore quietly.
 */
const KNOWN_QUIRKS = {
  catalog_not_unique: 'The catalog repeats its item key — dedupe with GROUP BY + MAX before every join.',
  vat_1_18: 'Money is derived at 18% VAT from list prices, so every figure is an estimate excluding discounts.',
  anchor_to_demand_max_date: 'Trailing windows anchor to the demand max date, never CURRENT_DATE.',
  supplier_col_reversed_latin: 'Latin supplier values are stored character-reversed in the export — never present them as company names.',
  on_order_unverified: 'No goods-receipt events exist, so an open order may already have been delivered.',
  two_item_keys: 'Demand and stock key on different columns and must be bridged through the catalog.',
};

/** Required leaf fields per binding section. */
const REQUIRED = {
  demand: ['table', 'dateCol', 'qtyCol', 'itemKey'],
  catalog: ['table', 'itemKey', 'replenishmentKey'],
};

/**
 * Validate a proposed binding STRUCTURALLY — shape, required fields, known
 * quirks, and identifier safety. This runs before any DDL is rendered, so a
 * malformed proposal costs a round rather than a database error.
 *
 * It deliberately does NOT check whether the named tables and columns exist:
 * that needs the live schema and is the verify hook's job. Structure first,
 * reality second — a binding that fails here would fail there too, but with
 * a far less actionable message.
 *
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateBinding(binding) {
  const errors = [];

  if (!binding || typeof binding !== 'object') {
    return { valid: false, errors: ['binding is not an object'] };
  }

  for (const [section, fields] of Object.entries(REQUIRED)) {
    const node = binding[section];
    if (!node || typeof node !== 'object') {
      errors.push(`missing section '${section}'`);
      continue;
    }
    for (const field of fields) {
      if (!node[field]) errors.push(`${section}.${field} is required`);
    }
  }

  // Stock must offer at least the warehouse grain — that is the grain the
  // first phase ships. Store stock is optional and additive.
  const warehouse = binding.stock?.warehouse;
  if (!warehouse) {
    errors.push('missing section stock.warehouse');
  } else {
    for (const field of ['qtyCol', 'itemKey']) {
      if (!warehouse[field]) errors.push(`stock.warehouse.${field} is required`);
    }
  }

  // onOrder and committed are optional: a client may have neither. But a
  // half-declared section is a mapping error, not an absence.
  for (const section of ['onOrder', 'committed']) {
    const node = binding[section];
    if (node && (!node.qtyCol || !node.itemKey)) {
      errors.push(`${section} is declared but missing qtyCol/itemKey`);
    }
  }

  for (const quirk of binding.quirks || []) {
    if (!KNOWN_QUIRKS[quirk]) errors.push(`unknown quirk '${quirk}'`);
  }

  // Every identifier reaches rendered SQL. Rejecting anything that is not a
  // plain identifier here is what keeps the generator from having to trust
  // the model's output — see templates.js, which refuses too.
  for (const [path, value] of collectIdentifiers(binding)) {
    if (!isSafeIdentifier(value)) {
      errors.push(`${path} is not a plain identifier: ${JSON.stringify(value)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Identifier fields only — rowFilter is SQL and is validated separately. */
function collectIdentifiers(binding) {
  const out = [];
  const push = (path, v) => { if (typeof v === 'string' && v) out.push([path, v]); };

  push('demand.table', binding.demand?.table);
  push('demand.dateCol', binding.demand?.dateCol);
  push('demand.qtyCol', binding.demand?.qtyCol);
  push('demand.itemKey', binding.demand?.itemKey);

  push('catalog.table', binding.catalog?.table);
  push('catalog.itemKey', binding.catalog?.itemKey);
  push('catalog.replenishmentKey', binding.catalog?.replenishmentKey);
  push('catalog.supplierCol', binding.catalog?.supplierCol);
  push('catalog.cartonCol', binding.catalog?.cartonCol);
  push('catalog.safetyCol', binding.catalog?.safetyCol);
  push('catalog.priceCol', binding.catalog?.priceCol);
  push('catalog.costCol', binding.catalog?.costCol);

  for (const grain of ['warehouse', 'store']) {
    push(`stock.${grain}.qtyCol`, binding.stock?.[grain]?.qtyCol);
    push(`stock.${grain}.itemKey`, binding.stock?.[grain]?.itemKey);
    push(`stock.${grain}.table`, binding.stock?.[grain]?.table);
  }
  for (const section of ['onOrder', 'committed']) {
    push(`${section}.qtyCol`, binding[section]?.qtyCol);
    push(`${section}.itemKey`, binding[section]?.itemKey);
    push(`${section}.table`, binding[section]?.table);
    push(`${section}.dateCol`, binding[section]?.dateCol);
  }
  return out;
}

/**
 * Unquoted Postgres identifier: letters, digits, underscore; not starting
 * with a digit. Anything else — quotes, dots, spaces, semicolons — is
 * refused rather than escaped, because a binding needing an exotic
 * identifier is a signal the mapping is wrong, not a case to accommodate.
 */
function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * A rowFilter is a SQL fragment, not an identifier, so it cannot be pattern-
 * matched as one. It is instead constrained to a shape that cannot carry a
 * second statement or a subquery: no semicolons, no comment markers, no
 * parentheses-with-SELECT.
 */
function isSafeRowFilter(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  if (value.length > 300) return false;
  if (/[;]|--|\/\*/.test(value)) return false;
  if (/\b(select|insert|update|delete|drop|alter|create|grant|truncate|copy)\b/i.test(value)) return false;
  return true;
}

module.exports = {
  THRESHOLDS,
  KNOWN_QUIRKS,
  REQUIRED,
  validateBinding,
  isSafeIdentifier,
  isSafeRowFilter,
  collectIdentifiers,
};
