/**
 * Build-order step 4, verbatim: "hand-check ten real items with a calculator —
 * invented test cases only test what we already understand."
 *
 * Ten REAL rows are pulled from the live prepared view, and each figure is
 * recomputed here from the raw inputs using the formula as the brief states
 * it, with no reference to engine.js. Then the two are compared.
 *
 *     cover     = available / daily velocity
 *     order by  = data date + (cover - lead time)
 *     order qty = velocity x (lead time + review cycle) + safety - available
 *
 * The point is INDEPENDENCE. Calling the engine twice proves determinism, not
 * correctness; a unit test over invented rows proves the code matches our own
 * model of the data. This is the only check that can catch the formula itself
 * being wrong on data as it really is - which is why the brief asks for it in
 * those words.
 */
require('dotenv').config();

const DAY = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  await require('../services/db.pg').initialize();
  const recs = require('../modules/replenishment/services/recommendations.service');
  const moduleService = require('../modules/services/module.service');
  if (!await moduleService.isLive('zolstock', 'replenishment')) {
    console.log('replenishment is not live for zolstock'); process.exit(0);
  }

  // A spread, not the top ten: taking only the most urgent rows would test one
  // status and miss the branches (dormant items, negative availability).
  const { recommendations, dataThrough } = await recs.getRecommendations('zolstock', { limit: 100000, onlyDue: false });

  // The limit must cover the WHOLE set. Recommendations come back sorted by
  // urgency, so any smaller cap returns nothing but overdue rows and the calm
  // buckets - stocked items with a real future order date, and dormant items
  // whose quantity must be zero - are never sampled. That happened on the
  // first run here: ten rows, every one of them avail<=0 and cover=0, which
  // means the order-by date formula was not exercised at all.
  // Round-robin across the branches that behave DIFFERENTLY, so ten rows are
  // ten distinct paths and not the same one ten times. Buckets, not statuses:
  // what matters arithmetically is whether there is demand, whether stock is
  // negative, and whether a carton size is known.
  const bucketOf = (r) => {
    if (Number(r.velocityDaily) <= 0) return 'dormant';
    if (Number(r.netAvailable) < 0) return 'negative-stock';
    if (Number(r.netAvailable) > 0) return 'has-stock';
    if (!Number(r.unitsPerCarton)) return 'no-carton';
    return 'out-of-stock';
  };
  const buckets = new Map();
  for (const r of recommendations) {
    const b = bucketOf(r);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }
  const pick = [];
  const queues = [...buckets.values()];
  while (pick.length < 10 && queues.some(q => q.length)) {
    for (const q of queues) { if (pick.length < 10 && q.length) pick.push(q.shift()); }
  }
  console.log('buckets covered: ' + [...buckets.keys()].join(', '));

  let fail = 0;
  console.log(`data through ${dataThrough} — recomputing ${pick.length} real rows independently\n`);

  for (const r of pick) {
    const v        = Number(r.velocityDaily);
    const avail    = Number(r.netAvailable);
    const lead     = Number(r.leadTimeDays);
    const review   = Number(r.reviewDays ?? 0);
    const safety   = Number(r.safetyStock);
    const carton   = Number(r.unitsPerCarton || 0);

    // cover
    const myCover  = v > 0 ? Math.max(0, avail / v) : null;
    // order-by date: anchored to the DATA date, never today
    let myOrderBy = null;
    if (myCover !== null) {
      const d = new Date(dataThrough + 'T00:00:00Z');
      myOrderBy = new Date(d.getTime() + Math.round(myCover - lead) * DAY).toISOString().slice(0, 10);
    }
    // quantity
    const target   = v * (lead + review) + safety;
    let myQty      = Math.max(0, target - avail);
    myQty = carton > 0 ? Math.ceil(myQty / carton) * carton : Math.ceil(myQty);
    if (v <= 0) myQty = 0;                       // dormant: no demand, no order

    const coverOK = (myCover === null && r.daysOfCover === null) ||
                    (myCover !== null && Math.abs(round2(myCover) - round2(Number(r.daysOfCover))) <= 0.02);
    const qtyOK   = Math.abs(myQty - Number(r.orderQty)) <= (carton > 0 ? carton : 1);
    const dateOK  = !myOrderBy || !r.orderByDate || myOrderBy === r.orderByDate;
    const ok = coverOK && qtyOK && dateOK;
    if (!ok) fail++;

    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${String(r.sku).padEnd(12)} ${r.status.padEnd(10)}` +
      ` v=${v.toFixed(3)} avail=${avail} lead=${lead} safety=${safety} carton=${carton || '-'}`);
    console.log(`       cover  mine=${myCover === null ? 'n/a' : round2(myCover)}  engine=${r.daysOfCover === null ? 'n/a' : round2(Number(r.daysOfCover))}`);
    console.log(`       qty    mine=${myQty}  engine=${r.orderQty}`);
    console.log(`       orderBy mine=${myOrderBy || 'n/a'}  engine=${r.orderByDate || 'n/a'}`);
  }

  console.log(`\n${pick.length - fail}/${pick.length} real items reconcile with an independent recomputation`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
