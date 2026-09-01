/**
 * The Apps shelf — what the client sees on /apps.
 *
 * One place answers three questions the shell asks constantly: does this
 * dataset have any apps at all (which is what makes the nav item appear), what
 * are they, and what number goes on the badge.
 *
 * Live-ness is NOT decided here. `moduleService.getLiveModules` is the single
 * definition of live and this reads it, so an app cannot appear on the shelf
 * under rules that differ from the ones the reload and the chat tool obey.
 */
const moduleService = require('./module.service');
const registry = require('../registry');

/**
 * When the data behind these apps was last rebuilt.
 *
 * The design prints "Researched 02:57" under the icon, and the only truthful
 * source for it is the reload that actually rebuilt the module's views — not a
 * clock, and not the module row's `updated_at`, which moves when an operator
 * flips a switch.
 */
async function researchedAt(datasetId) {
  try {
    const db = require('../../services/db.pg');
    // Read directly rather than through DataReloadService: that is a class the
    // server constructs with per-dataset config, and instantiating one just to
    // read a timestamp would drag its whole world in.
    //
    // `total_files IS NOT NULL` is what separates a real import from an
    // index-only or maintenance run — the same test the reload service itself
    // uses to find the last import.
    const { rows } = await db.query(
      `SELECT completed_at FROM public.data_reload_runs
        WHERE schema_name = $1 AND status = 'completed' AND total_files IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1`,
      [datasetId]);
    return rows[0]?.completed_at || null;
  } catch (err) {
    // A missing timestamp renders as nothing at all, which is honest. Failing
    // the whole page because we cannot say WHEN would not be.
    console.warn(`[apps] no research timestamp for ${datasetId}: ${err.message}`);
    return null;
  }
}

/** The headline numbers for one app, or null when it has none to give. */
async function headlineFor(descriptor, datasetId) {
  if (descriptor.id !== 'replenishment') return null;
  try {
    const recs = require('../replenishment/services/recommendations.service');
    // limit 1: the summary covers every row regardless, and shipping 9,000
    // recommendations to draw one badge would be absurd.
    const r = await recs.getRecommendations(datasetId, { limit: 1, onlyDue: false });
    if (r.error) return null;
    const suppliers = new Set(r.recommendations.map(x => x.supplier));
    return {
      orderNow: r.summary.orderNow,
      dueSoon: r.summary.dueSoon,
      stockedOk: r.summary.ok,
      noDemand: r.summary.noDemand,
      estimatedTotalExVat: r.summary.estimatedTotalExVat,
      supplierCount: r.supplierCount ?? suppliers.size,
      dataThrough: r.dataThrough || null,
      badge: r.summary.orderNow,
    };
  } catch (err) {
    console.warn(`[apps] headline for ${descriptor.id}/${datasetId} failed: ${err.message}`);
    return null;
  }
}

/**
 * @param {string} datasetId
 * @param {{ withHeadlines?: boolean }} opts headlines cost a full compute, so
 *   the nav check — which only needs to know whether the shelf is empty — asks
 *   without them.
 */
async function listApps(datasetId, opts = {}) {
  let live = [];
  try {
    live = await moduleService.getLiveModules(datasetId);
  } catch (err) {
    // The shelf failing must not take the page with it: a client whose module
    // registry is briefly unreachable sees no apps, not an error screen.
    console.warn(`[apps] could not list live modules for ${datasetId}: ${err.message}`);
    return { datasetId, apps: [], planned: [], researchedAt: null };
  }

  const inApps = live.filter(({ descriptor }) => descriptor.group === 'apps');
  const stamp = inApps.length ? await researchedAt(datasetId) : null;

  const apps = [];
  for (const { descriptor } of inApps) {
    apps.push({
      id: descriptor.id,
      name: descriptor.name,
      icon: descriptor.icon,
      blurb: descriptor.blurb || null,
      researchedAt: stamp,
      headline: opts.withHeadlines ? await headlineFor(descriptor, datasetId) : null,
    });
  }

  return {
    datasetId,
    apps,
    // Announced, not built. Shown greyed out so the client can see where this
    // is going; never installable, because installing one would install nothing.
    planned: registry.PLANNED_APPS.map(a => ({ id: a.id, name: a.name, icon: a.icon, blurb: a.blurb })),
    researchedAt: stamp,
  };
}

/** Does the nav show an Apps item for this dataset? */
async function hasApps(datasetId) {
  const { apps } = await listApps(datasetId);
  return apps.length > 0;
}

module.exports = { listApps, hasApps };
