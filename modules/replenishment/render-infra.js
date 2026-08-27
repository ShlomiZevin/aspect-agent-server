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
 * @param {string} schemaName  the schema to build into (a shadow or scratch
 *                             schema during a reload/init, never live directly)
 * @param {object} binding     the mapping produced by init and stored on the module
 * @returns {string[]}         statements, in execution order
 */
function renderInfra(schemaName, binding) {
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
  statements.push(`DROP MATERIALIZED VIEW IF EXISTS ${schemaName}.mv_suppliers CASCADE`);
  statements.push(`DROP MATERIALIZED VIEW IF EXISTS ${schemaName}.mv_replenishment_base CASCADE`);

  statements.push(renderReplenishmentBase(schemaName, binding));

  const suppliers = renderSuppliers(schemaName, binding);
  if (suppliers) statements.push(suppliers);

  statements.push(...renderIndexes(schemaName, binding));

  return statements;
}

module.exports = { renderInfra };
