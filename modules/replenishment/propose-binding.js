/**
 * Smart Replenishment — the binding proposal (the ONLY LLM call in this module).
 *
 * In:  the audit's measurements + the binding contract.
 * Out: a binding document — column mappings and quirk flags.
 *
 * The model NEVER writes SQL and never computes anything. Its entire job is
 * "which column means demand quantity, which means stock, which key joins
 * what" — a small, enumerable choice. That is what makes the ≤5-round loop
 * able to converge: a failed probe names exactly which mapping to reconsider,
 * instead of "the SQL was wrong somehow".
 *
 * Temperature 0, via services/llm.js with a context key, model id from
 * services/models.service.js — all three are house rules, and the first one
 * matters most here: the same schema must map the same way every run, or a
 * re-init would silently change a client's numbers.
 */

const llmService = require('../../services/llm.js');
const { validateBinding, KNOWN_QUIRKS, THRESHOLDS } = require('./binding-contract');

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You map a retailer's database schema onto a fixed replenishment model.

You are given MEASUREMENTS taken from the live database — row counts, column
population rates, and measured join rates. You return a JSON binding that says
which table and column plays each role.

RULES, in order of importance:

1. You do NOT write SQL. You do NOT compute anything. You choose column names.
   A deterministic generator turns your binding into SQL; anything you write
   that is not a plain column or table name will be rejected.

2. Prefer MEASURED evidence over column names. A column called "sku" that
   joins to nothing is not the replenishment key; a column with an unhelpful
   name that joins at 99% is. The measurements name the join rates — use them.

3. Every table and column you name MUST appear in the measurements. Do not
   invent, do not guess a column that "should" exist, do not carry over names
   from another retailer. If a role has no column, omit that section entirely
   rather than filling it with something plausible.

4. Identifiers must be plain: letters, digits and underscores only. No quotes,
   no dots, no expressions.

THE MODEL YOU ARE MAPPING ONTO:

  demand     rows that record a SALE           (needs: table, dateCol, qtyCol, itemKey, rowFilter?)
  stock.warehouse  rows that record CENTRAL stock on hand (qtyCol, itemKey, table?, rowFilter?)
  stock.store      rows that record PER-BRANCH stock      (optional, same shape)
  onOrder    rows for orders PLACED with a supplier, not yet received
             (optional: qtyCol, itemKey, dateCol?, table?, rowFilter?)
  committed  rows for orders CUSTOMERS have placed, not yet fulfilled (optional)
  catalog    the item master (table, itemKey, replenishmentKey, and optionally
             nameCol, categoryCol, subcategoryCol, supplierCol, supplierCodeCol,
             cartonCol, safetyCol, priceCol, costCol)

TWO KEYS, AND THEY ARE USUALLY DIFFERENT:
  catalog.itemKey          joins the catalogue to DEMAND rows
  catalog.replenishmentKey joins the catalogue to STOCK and ORDER rows
If one column does both, name it in both places. If the measurements show a
column joining to stock but not to sales (or vice versa), that tells you which
is which.

WHEN SEVERAL ROW KINDS SHARE ONE TABLE, each section needs a rowFilter that
selects its kind — a short SQL condition such as record_type = 'sales'. Use
the discriminator values exactly as the measurements report them.

QUIRKS you may declare (only these, only when the measurements support them):
${Object.entries(KNOWN_QUIRKS).map(([k, v]) => `  ${k} — ${v}`).join('\n')}

Return ONLY the JSON object, with no commentary.`;

/**
 * Condense the audit into what the model actually needs. The full audit
 * document is large and mostly irrelevant to a mapping decision; sending it
 * whole would bury the join rates that are the entire basis for the choice.
 */
function summariseAudit(auditDoc) {
  const m = auditDoc?.measurements || {};
  return {
    tables: (m.relations || []).filter(r => r.kind === 'table')
      .map(r => ({ name: r.name, approxRows: r.approxRows })),
    detected: m.detected,
    rowKindColumn: m.discriminator?.column || null,
    rowKinds: (m.rowKinds || m.discriminator?.values || []).map(k => ({
      kind: k.kind ?? k.value,
      rows: k.rows,
      hasDates: k.datedRows ? k.datedRows > 0 : undefined,
      from: k.from, to: k.to,
    })),
    supplierColumns: m.supplierColumns,
    replenishmentKeyCandidates: (m.replenishmentKeyColumns || []).map(c => ({
      column: c.column,
      populatedInCatalogue: c.coverage,
      measuredJoinRateToStock: c.joinRate,
      factSideColumn: c.factSideColumn,
    })),
    chosenByMeasurement: m.chosenReplenishmentKey
      ? { column: m.chosenReplenishmentKey.column, joinRate: m.chosenReplenishmentKey.joinRate }
      : null,
    keyBehaviourByRowKind: m.keyJoinRateByRowKind,
    safetyStockColumns: m.safetyStock,
    cartonColumns: m.unitsPerCarton,
    dateColumns: m.dateColumns,
    goodsReceiptEvidence: m.goodsReceiptEvidence,
    gaps: (auditDoc?.gaps || []).map(g => ({ key: g.key, title: g.title })),
  };
}

/**
 * Every column the audit saw, per table — the whitelist the model must stay
 * inside. Sent alongside the summary so "name only columns that exist" is
 * enforceable rather than merely requested.
 */
function columnCatalogue(auditDoc) {
  const m = auditDoc?.measurements || {};
  const out = {};
  const add = (table, cols) => {
    if (!table || !cols) return;
    out[table] = [...new Set([...(out[table] || []), ...cols])];
  };
  add(m.detected?.factTable?.name, m.dateColumns);
  add(m.detected?.catalogTable?.name, (m.supplierColumns || []).map(c => c.column));
  add(m.detected?.catalogTable?.name, (m.replenishmentKeyColumns || []).map(c => c.column));
  add(m.detected?.catalogTable?.name, (m.safetyStock || []).map(c => c.column));
  add(m.detected?.catalogTable?.name, (m.unitsPerCarton || []).map(c => c.column));
  return out;
}

/**
 * Propose (or revise) a binding.
 *
 * @param {object} ctx { audit, round, previousFailures, settings, datasetId, schemaName }
 * @returns {object} the proposed binding
 */
async function proposeBinding(ctx) {
  const { audit: auditDoc, round = 1, previousFailures = [], settings = {} } = ctx;
  const model = settings.initModel || DEFAULT_MODEL;

  const parts = [
    `Retailer schema: ${ctx.schemaName}`,
    '',
    'MEASUREMENTS FROM THE LIVE DATABASE:',
    JSON.stringify(summariseAudit(auditDoc), null, 2),
    '',
    'COLUMNS THAT EXIST (you may name no others):',
    JSON.stringify(columnCatalogue(auditDoc), null, 2),
  ];

  if (round > 1 && previousFailures.length) {
    // The whole point of a round: the model is told exactly what failed, with
    // the numbers, so the next attempt is a revision rather than a re-roll.
    parts.push(
      '',
      `ATTEMPT ${round}. Your previous binding was built and FAILED these checks:`,
      ...previousFailures.map(f => `  - ${f.probe}: ${f.detail || 'failed'}`),
      '',
      'Change the mappings those checks implicate. Do not resubmit the same binding.',
    );
  }

  const raw = await llmService.sendOneShot(SYSTEM_PROMPT, parts.join('\n'), {
    model,
    maxTokens: 2048,
    jsonOutput: true,
    temperature: 0,
    context: 'replenishment_propose_binding',
    agentName: ctx.datasetId,
  });

  const binding = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Structural validation happens HERE, not at build time, so a malformed
  // proposal costs one round with an actionable message rather than a
  // database error nobody can act on.
  const { valid, errors } = validateBinding(binding);
  if (!valid) {
    const err = new Error(`proposed binding is invalid: ${errors.join('; ')}`);
    err.bindingErrors = errors;
    err.binding = binding;
    throw err;
  }

  return binding;
}

module.exports = { proposeBinding, summariseAudit, columnCatalogue, SYSTEM_PROMPT, DEFAULT_MODEL, THRESHOLDS };
