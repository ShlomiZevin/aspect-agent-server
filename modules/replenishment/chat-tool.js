/**
 * Smart Replenishment — the crew tool.
 *
 * STRUCTURED ARGUMENTS, NEVER GENERATED SQL. That is the whole point: the
 * same question asked five different ways, in either language, must return
 * identical numbers. A model writing SQL for "what should I order" would not
 * do that — it would produce a slightly different query, and therefore
 * slightly different numbers, each time. Here the model only chooses a
 * supplier filter and a horizon; the arithmetic is the same pure function the
 * screen and the report use.
 *
 * The tool is registered ONLY when the module is enabled and ready. When it
 * is not, the crew has exactly the tools it had before this module existed.
 */

const recommendationsService = require('./services/recommendations.service');

const MAX_ROWS_IN_ANSWER = 25;

function buildTool(datasetId) {
  return {
    name: 'fetch_replenishment',
    description:
      'Answer "what should we order, how much, and when" for this business. ' +
      'Returns reorder recommendations computed from sales pace, stock on hand, ' +
      'open orders and the supplier delivery time. Use this INSTEAD of a data ' +
      'query for any reorder / restock / purchasing question — it is the only ' +
      'correct source for those numbers.',
    parameters: {
      type: 'object',
      properties: {
        supplier: {
          type: 'string',
          description: 'Optional. Limit to one supplier, exactly as the data names it.',
        },
        sku: {
          type: 'string',
          description: 'Optional. Limit to one item code.',
        },
        onlyDue: {
          type: 'boolean',
          description: 'Optional, default true. Only items that are overdue or due soon.',
        },
        horizonDays: {
          type: 'number',
          description: 'Optional. How many days ahead still counts as "due soon".',
        },
        limit: {
          type: 'number',
          description: `Optional, default ${MAX_ROWS_IN_ANSWER}. Maximum rows to return.`,
        },
      },
      required: [],
    },
    handler: async (params) => handle(datasetId, params),
  };
}

/**
 * Run the engine and render a result the talker can rephrase but not
 * contradict.
 *
 * The caveats come from the engine's own `notes[]`, unedited — the screen,
 * this tool and the Intelligence report must not word the same caveat three
 * slightly different ways.
 */
async function handle(datasetId, params = {}) {
  const opts = {
    supplier: params.supplier || undefined,
    sku: params.sku || undefined,
    onlyDue: params.onlyDue === undefined ? true : Boolean(params.onlyDue),
    horizonDays: params.horizonDays,
    limit: Math.min(Number(params.limit) || MAX_ROWS_IN_ANSWER, 100),
  };

  const res = await recommendationsService.getRecommendations(datasetId, opts);
  if (res.error) {
    return {
      error: res.error,
      summary: 'Replenishment recommendations are not available for this dataset.',
    };
  }

  const rows = res.recommendations.map(r => ({
    item: r.itemName || r.sku,
    sku: r.sku,
    supplier: r.supplier,
    status: r.status,
    orderQty: r.orderQty,
    estimatedCostExVat: r.estimatedCostExVat,
    orderByDate: r.orderByDate,
    daysLate: r.daysLate,
    daysOfCover: r.daysOfCover === null ? null : Math.round(r.daysOfCover),
    salesPerDay: Number(r.velocityDaily.toFixed(3)),
    inStock: r.warehouseQty,
    onOrder: r.onOrderQty,
    reserved: r.committedQty,
    leadTimeDays: r.leadTimeDays,
    leadTimeSource: r.leadTimeSource,
  }));

  // A DATA CONTRACT block the talker must carry through. Same idea as
  // table-format.service's contract for query results: the model may rephrase
  // it, but it cannot quietly drop it.
  const contract = [];
  contract.push(`Data through ${res.dataThrough || 'unknown'}; computed for ${res.today}.`);
  contract.push(
    `${res.summary.orderNow} items are overdue, ${res.summary.dueSoon} due within the horizon, ` +
    `${res.summary.ok} adequately stocked, ${res.summary.noDemand} with no recent sales.`);

  const assumed = res.recommendations.filter(r => r.leadTimeSource !== 'supplier');
  if (assumed.length) {
    contract.push(
      `${assumed.length} of the ${res.recommendations.length} rows shown use an ASSUMED delivery time, ` +
      `not one the client set. Say so, and point at the Purchasing screen where it can be set — ` +
      `the delivery time decides every order date here.`);
  }
  if (res.recommendations.some(r => r.onOrderIsUnverified && r.onOrderQty > 0)) {
    contract.push(
      'This data records no goods receipts, so quantities shown as already on order may have ' +
      'arrived. Where that applies, the recommendation may be too small.');
  }
  contract.push('Order values are list-price estimates excluding VAT and before discounts.');

  return {
    // Kept small on purpose — this is what the talker reads.
    summary:
      `${res.total} item(s) match. ` +
      (rows.length < res.total ? `Showing the ${rows.length} most urgent. ` : '') +
      (rows[0] ? `Most urgent: ${rows[0].item} — order ${rows[0].orderQty}, due ${rows[0].orderByDate}.` : ''),
    dataContract: contract,
    total: res.total,
    counts: res.summary,
    dataThrough: res.dataThrough,
    recommendations: rows,
    // Every caveat, already worded by the engine. Quoted, never re-derived.
    notes: [...new Set(res.recommendations.flatMap(r => r.notes))].slice(0, 8),
  };
}

module.exports = { buildTool, handle, MAX_ROWS_IN_ANSWER };
