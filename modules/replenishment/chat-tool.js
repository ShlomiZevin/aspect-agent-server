/**
 * Smart Replenishment — the crew tool.
 *
 * STRUCTURED ARGUMENTS, NEVER GENERATED SQL — for the arithmetic. The same
 * question asked five different ways, in either language, must return
 * identical numbers, so quantities, dates and reorder points come from the
 * engine exclusively.
 *
 * SCOPE IS THE MODEL'S JOB. Every replenishment question decomposes into
 * scope × arithmetic (see ../scope.js). The parameters below cover the common
 * vocabulary directly (supplier, category, free-text name search, SKU lists);
 * anything they don't cover, the model resolves against the catalogue with an
 * ordinary data query and hands back here as `skus`. Refusing because of
 * vocabulary is a bug — the live incident this closes was a buyer refused
 * twice ("purchase recommendation for the wood-products department", then
 * "items with עץ in the name") while the data to resolve both sat one query
 * away.
 *
 * The tool is registered ONLY when the module is enabled and ready. When it
 * is not, the crew has exactly the tools it had before this module existed.
 */

const recommendationsService = require('./services/recommendations.service');
const { MAX_SCOPE_SKUS } = require('./scope');
const { GROUPS } = require('./groups');

const MAX_ROWS_IN_ANSWER = 25;

function buildTool(datasetId) {
  return {
    name: 'fetch_replenishment',
    description:
      'Reorder recommendations — what to order, how much, and when — computed from '
      + 'sales pace, stock, open orders and the supplier delivery time. This is the ONLY '
      + 'correct source for order quantities, order-by dates and reorder points; never '
      + 'compute those yourself and never take them from a data query. '
      + 'SCOPE PROTOCOL: if the user\'s scope is a supplier, a category/subcategory, a '
      + 'name/text match, or specific item codes, pass it DIRECTLY via the parameters — '
      + 'no catalogue query first: a side query adds nothing and its row counts describe '
      + 'a DIFFERENT universe (the catalogue holds store-only items this module never '
      + 'counts), which has put three competing totals in one answer. Only when the '
      + 'vocabulary cannot be expressed by these parameters (a brand, "things like X") '
      + 'resolve it with a catalogue query — fetching labels or codes, not a full '
      + 'catalogue — and hand the result back here as `skus`. Never refuse a reorder '
      + 'question because of its vocabulary — resolve the scope, then compute. Always '
      + 'restate the scope the answer covers, using THIS tool\'s counts as the only '
      + 'universe of the answer.',
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
        skus: {
          type: 'array',
          items: { type: 'string' },
          description:
            `Optional, up to ${MAX_SCOPE_SKUS}. A list of item codes — the universal bridge: `
            + 'resolve ANY vocabulary (a department, a brand, a pasted list) to SKUs with a '
            + 'catalogue query, then pass them here.',
        },
        search: {
          type: 'string',
          description:
            'Optional. Free-text match on item name or code — "items with עץ in the name" '
            + 'is search:"עץ". Matches as the data spells it; try the user\'s language first.',
        },
        category: {
          type: 'string',
          description:
            'Optional. Exact catalogue category label AS DELIVERED in the data (these labels '
            + 'can differ from the client\'s own BI categories — say "labels as delivered" when '
            + 'answering through them).',
        },
        subcategory: {
          type: 'string',
          description: 'Optional. Exact catalogue subcategory label as delivered.',
        },
        onlyDue: {
          type: 'boolean',
          description: 'Optional, default true. Only items that are overdue or due soon.',
        },
        horizonDays: {
          type: 'number',
          description:
            'Optional. How many days ahead still counts as "due soon". ONLY takes '
            + 'effect together with windowFromUser; alone it is IGNORED and the '
            + 'client\'s configured window is used — the one the Procurement screen '
            + 'shows. Never invent a window for a plain "what should we order" or '
            + '"below the reorder point" question: choosing one changes the counts, '
            + 'and a buyer comparing the chat with the screen has no way to see why '
            + 'they disagree.',
        },
        windowFromUser: {
          type: 'string',
          description:
            'The user\'s OWN words that named a time window ("in the next two '
            + 'weeks", "לחודש הקרוב"), quoted verbatim. Required for horizonDays to '
            + 'take effect — it exists so a window is only ever applied because the '
            + 'user asked for one.',
        },
        group: {
          type: 'string',
          enum: Object.values(GROUPS),
          description:
            'Optional. Filter to ONE of the Procurement screen\'s group chips: '
            + 'order_now ("Order now" / "להזמין עכשיו"), suspicious ("Needs checking" '
            + '/ "דורש בדיקה"), out_of_season ("מחוץ לעונה"), fading ("דועך"), new '
            + '("חדש"). Use it whenever the user names a group — "from the Order now '
            + 'group" MUST become group:"order_now", never a re-labeling of the '
            + 'overdue count: overdue is a STATUS, the groups are the screen\'s '
            + 'classification of those same items, and their counts differ.',
        },
        status: {
          type: 'string',
          enum: ['overdue', 'due_soon'],
          description:
            'Optional. overdue = the place-order date is ALREADY TODAY ("need to '
            + 'order now", "חייבים להזמין עכשיו"); due_soon = planned, the order '
            + 'date lies ahead ("coming up", "בקרוב"). Combine freely with sortBy: '
            + '"furthest items I must order now" = status:"overdue" + '
            + 'sortBy:"runout_desc" — the overdue items with the most remaining '
            + 'runway, a real and useful set. Never satisfy "now" by relabeling.',
        },
        sortBy: {
          type: 'string',
          enum: ['urgency', 'runout_desc'],
          description:
            'Optional row ordering — the same two the Procurement screen offers. '
            + 'Default "urgency": most urgent first (already-out and soonest-runout '
            + 'items lead, ranked by money at stake per day) — for "most urgent", '
            + '"most overdue", "what should we order first". '
            + '"runout_desc": the PLANNING view — the FURTHEST-future runouts first, '
            + 'already-run-out items last — for "furthest", "הרחוק להיגמר", "least '
            + 'urgent", "planning ahead". The two are near-opposites: a wrong guess '
            + 'reverses the list, so pick from the user\'s words and say which '
            + 'ordering the rows use.',
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
  const skus = Array.isArray(params.skus)
    ? params.skus.map(s => String(s).trim()).filter(Boolean)
    : undefined;

  // Over-cap is an honest instruction, not an error and not a truncation: a
  // silently clipped list would answer about a different scope than the one
  // the user resolved.
  if (skus && skus.length > MAX_SCOPE_SKUS) {
    return {
      summary:
        `The resolved scope has ${skus.length} SKUs, above the ${MAX_SCOPE_SKUS}-item limit for one answer. `
        + 'Narrow the scope (by supplier, category or a tighter name match) or ask for the group as a whole '
        + 'via the Procurement screen, which has no such limit.',
      dataContract: [`Scope was NOT computed: ${skus.length} SKUs exceeds the ${MAX_SCOPE_SKUS} limit. Say so.`],
      total: 0,
      recommendations: [],
    };
  }

  // THE HORIZON IS NOT THE MODEL'S TO CHOOSE. Twice now a plain question got
  // a window the user never named (0 days once, 25 another), and the same
  // question answered differently across runs. A horizon only applies when
  // the model can quote the user's words that asked for one; otherwise the
  // client's configured window — the screen's — is used, deterministically.
  const userNamedWindow = Boolean(String(params.windowFromUser ?? '').trim());
  const horizonIgnored = params.horizonDays != null && !userNamedWindow;

  const opts = {
    supplier: params.supplier || undefined,
    sku: params.sku || undefined,
    skus: skus && skus.length ? skus : undefined,
    search: params.search || undefined,
    category: params.category || undefined,
    subcategory: params.subcategory || undefined,
    onlyDue: params.onlyDue === undefined ? true : Boolean(params.onlyDue),
    horizonDays: userNamedWindow ? params.horizonDays : undefined,
    group: Object.values(GROUPS).includes(params.group) ? params.group : undefined,
    status: ['overdue', 'due_soon'].includes(params.status) ? params.status : undefined,
    sort: params.sortBy === 'runout_desc' ? 'runout_desc' : undefined,
    limit: Math.min(Number(params.limit) || MAX_ROWS_IN_ANSWER, 100),
  };

  const res = await recommendationsService.getRecommendations(datasetId, opts);
  if (res.error) {
    return {
      error: res.error,
      summary: 'Replenishment recommendations are not available for this dataset.',
    };
  }

  // The counts the talker quotes are the SCOPED ones — the set the user asked
  // about. With no scope given, scopedSummary === summary by construction, so
  // the unscoped invariance checks (fiveways) are unchanged.
  const counts = res.scopedSummary || res.summary;

  const rows = res.recommendations.map(r => ({
    item: r.itemName || r.sku,
    sku: r.sku,
    supplier: r.supplier,
    status: r.status,
    orderQty: r.orderQty,
    estimatedCostExVat: r.estimatedCostExVat,
    placeOrderBy: r.placeOrderBy,
    runoutDate: r.runoutDate,
    arrivesIfOrderedToday: r.arrivesIfOrderedToday,
    stockoutGapDays: r.stockoutGapDays,
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

  // THE INTERPRETATION, FIRST AND ALWAYS — composed from the parameters that
  // actually ran, not from what the model believes it asked for. Three times a
  // user's ask ("furthest", "from the Order now group", "that I need to order
  // now") was silently bent onto whatever the tool could express, and the
  // mislabeling was invisible. The answer MUST open by stating this
  // interpretation in the user's language, so a mismatch with their intent is
  // caught by the user in one glance instead of eroding their trust row by row.
  const interpretation = [
    params.supplier ? `supplier "${params.supplier}"` : 'all suppliers',
    Object.values(GROUPS).includes(params.group) ? `only the "${params.group}" group chip` : 'all group chips',
    params.status === 'overdue' ? 'only items to order TODAY (overdue)'
      : params.status === 'due_soon' ? 'only planned items (order date ahead)'
        : 'items to order today AND planned ones',
    params.sortBy === 'runout_desc' ? 'ordered by FURTHEST projected runout first (planning view)'
      : 'ordered most-urgent first',
  ].join(' · ');
  contract.push(`INTERPRETATION (state this openly at the top of your answer, in the user's language): ${interpretation}.`);
  // The two-date model, spelled out so answers stop presenting a diagnosis
  // as an instruction: a client read "order by June 6" (months past) as a
  // date to place an order, which is nonsense.
  contract.push(
    'DATES: `placeOrderBy` is WHEN TO ORDER — today at the earliest, never in the past; '
    + 'present it as the action date. `runoutDate` is when current stock is projected to '
    + 'hit zero; `arrivesIfOrderedToday` is when goods would land if ordered now, and '
    + '`stockoutGapDays` the projected zero-stock days even so. `orderByDate` is the '
    + 'DIAGNOSIS — the last date that would have prevented the runout; when it is in the '
    + 'past, say "should ideally have been ordered N days ago", never present it as when '
    + 'to order.');
  // The interpretation, stated — the buyer must see WHICH rows were answered
  // about, especially when the scope came from resolving their vocabulary.
  if (res.scope) contract.push(res.scope);
  // Which horizon produced these counts, always -- the figure moves with it, so
  // an answer that does not say which one it used cannot be reconciled against
  // the screen or against the same question asked yesterday.
  // != null, not truthy: 0 is a real window ("due today only") and an answer
  // computed at 0 that claims the configured window cannot be reconciled
  // against the screen — the exact failure this line exists to prevent.
  contract.push(userNamedWindow && params.horizonDays != null
    ? `"Due soon" here means within ${params.horizonDays} days`
      + (Number(params.horizonDays) === 0 ? ' — items whose order date is already today' : '')
      + `, because the user asked for that window ("${params.windowFromUser}"). `
      + 'Say so — the window configured for this client is different, and the Procurement screen uses that one.'
    : '"Due soon" uses the window configured for this client, the same one the Procurement screen uses.'
      + (horizonIgnored
        ? ' A different horizon was proposed without the user naming one — it was IGNORED so this answer matches the screen.'
        : ''));

  // ONE UNIVERSE PER ANSWER. When the scope came from catalogue labels or a
  // name match, the figures cover items in the WAREHOUSE STOCK FILE only —
  // the catalogue also holds store-only items this module never counts. A
  // catalogue row count from a side query is a different universe and must
  // never be quoted as this answer's item count.
  if (res.scope) {
    contract.push(
      'These figures cover items carried in the warehouse stock file — the module\'s universe. '
      + 'Do NOT quote a catalogue query\'s row count as the number of items assessed here; '
      + 'if a catalogue total is worth mentioning, present it as a separate, explained contrast.');
  }
  contract.push(
    `${counts.orderNow} items are overdue, ${counts.dueSoon} due within the horizon, ` +
    `${counts.ok} adequately stocked, ${counts.noDemand} with no recent sales` +
    (res.scope ? ' — within the stated scope.' : '.'));

  const gs = res.scopedGroupSummary;
  const activeGroup = Object.values(GROUPS).includes(params.group) ? params.group : null;

  // When ONE group chip was asked for, its own count and money ARE the
  // headline — the status counts above describe the whole scope. Without this
  // an answer relabeled "5,020 overdue" as "5,020 in the Order now group",
  // which is a different (and wrong) number.
  if (activeGroup && gs?.[activeGroup]) {
    contract.push(
      `GROUP FILTER: only the "${activeGroup}" chip — ${gs[activeGroup].count} item(s), estimated order `
      + `cost ₪${Math.round(gs[activeGroup].estimatedCostExVat).toLocaleString('en-GB')} ex-VAT. THESE are `
      + 'the headline figures. The overdue/due-soon counts above cover the whole scope across all groups — '
      + 'never present them as this group\'s size.');
  }

  // The money, LABELED — the tool returns two totals (the due set's, and the
  // whole scope's including adequately-stocked items) and answers have quoted
  // the wrong one as the other. Worded here so the talker copies a sentence
  // instead of choosing between two raw numbers.
  if (!activeGroup && counts.estimatedTotalExVat != null) {
    const due = Math.round(counts.estimatedTotalExVat).toLocaleString('en-GB');
    const all = counts.estimatedTotalAllExVat != null
      ? Math.round(counts.estimatedTotalAllExVat).toLocaleString('en-GB') : null;
    contract.push(
      `Estimated order cost of the ${counts.orderNow + counts.dueSoon} DUE items: ₪${due} ex-VAT`
      + (all && all !== due
        ? `. (₪${all} would be the whole scope including not-yet-due items — quote that ONLY if you label it as such.)`
        : '.'));
  }

  // GROUPS — reconciliation against the screen's chips, by construction. The
  // Procurement screen OPENS on its "Order now" chip and hides the other
  // groups until clicked; a chat total over the whole due set therefore
  // differs from the chip by composition, and the buyer comparing the two
  // (they always do) must be told which groups the figures include.
  if (gs && !activeGroup) {
    const parts = Object.entries(gs)
      .filter(([, v]) => v.count > 0)
      .map(([g, v]) => `${g}: ${v.count}`);
    if (parts.length > 1) {
      contract.push(
        `GROUPS: these due items split across the screen's group chips — ${parts.join(', ')}. `
        + 'The Procurement screen opens on "Order now" only, so a total over all groups will not match '
        + 'that chip. If the user is comparing with the screen, say which groups your figures include.');
    }
  }

  // ROW ORDER, always stated — the two available orderings are near-opposites
  // and an answer that does not say which one it used cannot be compared with
  // the screen or with the same question asked yesterday.
  contract.push(params.sortBy === 'runout_desc'
    ? 'ROW ORDER: the planning view — furthest-future projected runout first, already-run-out items last. Say so.'
    : 'ROW ORDER: most urgent first — already-out and soonest-runout items lead, ranked by money at stake '
      + 'per day. Say so; if the user actually asked for the FURTHEST/planning view, call again with '
      + 'sortBy="runout_desc" instead of reinterpreting these rows.');

  const assumed = res.recommendations.filter(r => r.leadTimeSource !== 'supplier');
  if (assumed.length) {
    contract.push(
      `${assumed.length} of the ${res.recommendations.length} rows shown use an ASSUMED delivery time, ` +
      `not one the client set. Say so, and point at the Procurement screen where it can be set — ` +
      `the delivery time decides every order date here.`);
  }
  if (res.recommendations.some(r => r.onOrderIsUnverified && r.onOrderQty > 0)) {
    contract.push(
      'This data records no goods receipts, so quantities shown as already on order may have ' +
      'arrived. Where that applies, the recommendation may be too small.');
  }
  contract.push('Order values are list-price estimates excluding VAT and before discounts.');

  // An empty scope is an answer, not a refusal: name what was searched and
  // offer the nearest resolvable alternative.
  const emptyScope = res.total === 0 && res.scope;

  return {
    // Kept small on purpose — this is what the talker reads.
    summary: emptyScope
      ? `No items matched. ${res.scope} The scope was searched, not refused — the term may be `
        + 'spelled differently in the catalogue, or the items may not be due: try a broader '
        + 'name match, or ask without onlyDue to see the whole scope.'
      : `${res.total} item(s) match. ` +
        (rows.length < res.total ? `Showing the ${rows.length} most urgent. ` : '') +
        (rows[0] ? `Most urgent: ${rows[0].item} — order ${rows[0].orderQty}, due ${rows[0].orderByDate}.` : ''),
    dataContract: contract,
    total: res.total,
    counts,
    scope: res.scope || null,
    dataThrough: res.dataThrough,
    recommendations: rows,
    // Every caveat, already worded by the engine. Quoted, never re-derived.
    notes: [...new Set(res.recommendations.flatMap(r => r.notes))].slice(0, 8),
  };
}

module.exports = { buildTool, handle, MAX_ROWS_IN_ANSWER };
