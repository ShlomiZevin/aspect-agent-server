/**
 * Smart Replenishment — the deterministic DDL generator.
 *
 * binding → an ordered list of SQL statements. Pure: no DB, no clock, no
 * randomness, no LLM. The same binding always renders byte-identical SQL,
 * which is what lets the golden-DDL test assert the output exactly and what
 * lets the nightly reload rebuild the views from the stored binding without
 * re-running any of the init pipeline.
 *
 * Statement order matters and is not incidental:
 *   1. DROP both views (CASCADE) — mv_suppliers is built ON TOP of
 *      mv_replenishment_base, so it must go first and come back last.
 *   2. CREATE mv_replenishment_base
 *   3. CREATE mv_suppliers (reads the base view)
 *   4. Indexes, including the UNIQUE ones REFRESH … CONCURRENTLY requires
 */

const { validateBinding } = require('./binding-contract');
const { renderReplenishmentBase, renderSuppliers, renderIndexes } = require('./templates');

/**
 * TARGET vs SOURCE are separate, and the distinction is load-bearing.
 *
 * The views are CREATEd in the target schema but read their data from the
 * source schema, and those are only the same schema on the nightly path:
 *
 *   nightly reload  target = <schema>_new (shadow)   source = <schema>_new
 *                   — the shadow holds a full freshly-loaded copy of the data,
 *                     so it is both, and the views swap in with it.
 *
 *   init / verify   target = <schema>_mod_..._scratch  source = <schema>
 *                   — the scratch schema is EMPTY. An earlier version used one
 *                     schema for both and every init failed with
 *                     `relation "..._scratch.facts" does not exist`.
 *
 * @param {string|{target: string, source?: string}} schema
 *        where to build, and where to read from (defaults to the same).
 * @param {object} binding the mapping produced by init and stored on the module
 * @returns {string[]} statements, in execution order
 */
function renderInfra(schema, binding) {
  const schemas = typeof schema === 'string'
    ? { target: schema, source: schema }
    : { target: schema.target, source: schema.source || schema.target };

  const { valid, errors } = validateBinding(binding);
  if (!valid) {
    // Refuse rather than render something partial: a half-built view that
    // looks present is worse than an obvious failure, because the nightly
    // freshness check would then find a view that exists and is wrong.
    throw new Error(`replenishment: invalid binding — ${errors.join('; ')}`);
  }

  const statements = [];

  // Drop dependents first. CASCADE covers indexes; naming both explicitly
  // keeps the intent readable rather than relying on cascade order.
  statements.push(`DROP MATERIALIZED VIEW IF EXISTS ${schemas.target}.mv_suppliers CASCADE`);
  statements.push(`DROP MATERIALIZED VIEW IF EXISTS ${schemas.target}.mv_replenishment_base CASCADE`);

  statements.push(renderReplenishmentBase(schemas, binding));

  const suppliers = renderSuppliers(schemas, binding);
  if (suppliers) statements.push(suppliers);

  statements.push(...renderIndexes(schemas, binding));

  return statements;
}

module.exports = { renderInfra };
