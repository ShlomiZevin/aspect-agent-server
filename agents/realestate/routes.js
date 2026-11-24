/**
 * Real-estate demo screens — the data behind the designed pages:
 *
 *   GET /api/realestate/board   — "לוח מכירות חי": every project, building and
 *                                  apartment with its status, the chain KPIs and
 *                                  three short overnight insights.
 *   GET /api/realestate/brief   — "היועץ החכם שלי": the morning brief — who to
 *                                  call, which apartments are stuck and why,
 *                                  where discounts leak money.
 *   GET /api/realestate/market  — "רוכשים ושיווק": who the buyers are, which
 *                                  sources and benefits work, demand by size.
 *
 * Read-only, straight from the views of scripts/seed-realestate-synthetic.js,
 * which hold the business definitions ("stuck" = v_stuck_units, the leakage =
 * v_rep_performance.discount_above_company_avg_ils) — so the screens, the
 * reports and the chat all count the same things. Every sentence is composed
 * from the numbers here, not by a model.
 */

const express = require('express');
const { getPool } = require('../../services/db.realestate');

const router = express.Router();
const CRITICAL_CALL_SCORE = 80; // the brief's "critical calls" — the list and its count
const MAX_CALLS = 8;

const shekels = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `₪${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `₪${Math.round(v / 1e3)}K`;
  return `₪${Math.round(v)}`;
};
const pct1 = (n) => `${Number(n).toFixed(1)}%`;
const todayHe = () => new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' }).format(new Date());
const monthHe = (d) => new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' }).format(new Date(d));

/** The rep whose discounts drifted: the month it started, the average since, the company's, and the total above average. */
async function discountLeak(pool) {
  const [reps, monthly] = await Promise.all([
    pool.query('SELECT rep_name, deals, avg_discount_pct, company_avg_discount_pct, discount_above_company_avg_ils FROM realestate.v_rep_performance ORDER BY discount_above_company_avg_ils DESC LIMIT 1'),
    pool.query('SELECT rep_name, signed_month, deals, avg_discount_pct, company_avg_discount_pct FROM realestate.v_rep_discount_monthly ORDER BY signed_month'),
  ]);
  const top = reps.rows[0];
  const mine = monthly.rows.filter(m => m.rep_name === top.rep_name);
  // The drift starts at the first month from which every month runs 1.5x the company average.
  let start = mine.length;
  for (let i = mine.length - 1; i >= 0 && Number(mine[i].avg_discount_pct) >= 1.5 * Number(mine[i].company_avg_discount_pct); i--) start = i;
  const since = mine.slice(start);
  const before = mine.slice(0, start);
  const avg = (rows, key) => rows.reduce((a, r) => a + Number(r[key]) * Number(r.deals), 0) / Math.max(1, rows.reduce((a, r) => a + Number(r.deals), 0));
  return {
    rep: top.rep_name,
    amount: Number(top.discount_above_company_avg_ils),
    sinceMonth: since.length ? since[0].signed_month : null,
    dealsSince: since.reduce((a, r) => a + Number(r.deals), 0),
    avgSince: avg(since, 'avg_discount_pct'),
    companySince: avg(since, 'company_avg_discount_pct'),
    avgBefore: avg(before, 'avg_discount_pct'),
  };
}

/** Three short overnight findings for the board, each one sentence. */
async function boardInsights(pool) {
  const [leak, slow, sources] = await Promise.all([
    discountLeak(pool),
    pool.query(`SELECT rep_name, median_first_response_minutes, conversion_pct FROM realestate.v_rep_performance ORDER BY median_first_response_minutes DESC LIMIT 1`),
    pool.query(`SELECT source, cost_per_deal FROM realestate.v_source_performance WHERE deals >= 5 ORDER BY cost_per_deal`),
  ]);
  const s = slow.rows[0];
  const hours = Math.round(Number(s.median_first_response_minutes) / 60);
  const cheap = sources.rows.slice(0, 2);
  const dear = sources.rows[sources.rows.length - 1];
  return [
    { id: 'discounts', icon: 'trendUp', title: `${leak.rep} מעניק מאז ${monthHe(leak.sinceMonth)} הנחה ממוצעת של ${pct1(leak.avgSince)} — פי ${(leak.avgSince / leak.companySince).toFixed(1)} מהחברה` },
    { id: 'response', icon: 'alert', title: `${s.rep_name} חוזר ללידים אחרי ${hours} שעות בממוצע — ההמרה שלו ${pct1(s.conversion_pct)} בלבד` },
    { id: 'sources', icon: 'users', title: `${cheap.map(c => c.source).join(' ו')} עולים ${shekels(cheap[0].cost_per_deal)}–${shekels(cheap[1].cost_per_deal)} לעסקה; ${dear.source} — ${shekels(dear.cost_per_deal)}` },
  ];
}

router.get('/board', async (req, res) => {
  try {
    const pool = getPool();
    const [projects, units, sold30, insights] = await Promise.all([
      pool.query(`SELECT p.project_id, p.project_name, p.city, p.region, p.floors, s.pct_sold, s.sold_units, s.reserved_units, s.available_units,
                         s.total_units, s.monthly_sales_pace, s.forecast_sell_out_date
                    FROM realestate.projects p JOIN realestate.v_project_sellout s ON s.project_id = p.project_id
                   ORDER BY p.project_id`),
      pool.query(`SELECT u.unit_id, u.project_id, u.building, u.floor, u.position, u.unit_number, u.rooms, u.unit_type, u.sqm, u.outdoor_sqm,
                         u.direction, u.view, u.list_price, u.status, CURRENT_DATE - u.listed_date AS days_on_market,
                         s.price_premium_pct, s.unit_id IS NOT NULL AS stuck
                    FROM realestate.units u LEFT JOIN realestate.v_stuck_units s USING (unit_id)
                   ORDER BY u.project_id, u.building, u.floor, u.position`),
      pool.query("SELECT COUNT(*)::int AS n FROM realestate.units WHERE sold_date >= CURRENT_DATE - 30"),
      boardInsights(pool),
    ]);

    const out = projects.rows.map(p => {
      const mine = units.rows.filter(u => u.project_id === p.project_id);
      const buildings = [...new Set(mine.map(u => u.building))].map(b => {
        const inB = mine.filter(u => u.building === b);
        return {
          building: b,
          pctSold: Math.round(100 * inB.filter(u => u.status === 'נמכרה').length / inB.length),
          units: inB.map(u => ({
            id: u.unit_id, floor: u.floor, position: u.position, number: u.unit_number, rooms: u.rooms,
            type: u.unit_type, sqm: u.sqm, outdoorSqm: u.outdoor_sqm, direction: u.direction, view: u.view,
            price: Number(u.list_price), status: u.status, daysOnMarket: u.days_on_market,
            premiumPct: u.price_premium_pct == null ? null : Number(u.price_premium_pct),
            stuck: u.stuck, // in v_stuck_units — the one definition the brief, reports and chat use too
          })),
        };
      });
      return {
        id: p.project_id, name: p.project_name, city: p.city, region: p.region, floors: p.floors,
        totalUnits: Number(p.total_units), sold: Number(p.sold_units), reserved: Number(p.reserved_units), free: Number(p.available_units),
        pctSold: Number(p.pct_sold), monthlyPace: Number(p.monthly_sales_pace), sellOutDate: p.forecast_sell_out_date,
        buildings,
      };
    });

    const total = out.reduce((a, p) => a + p.totalUnits, 0);
    const sold = out.reduce((a, p) => a + p.sold, 0);
    res.json({
      date: todayHe(),
      kpis: { totalUnits: total, soldUnits: sold, pctSold: Math.round(100 * sold / total), soldLast30Days: sold30.rows[0].n },
      projects: out,
      insights,
    });
  } catch (err) {
    console.error('[realestate] board failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/brief', async (req, res) => {
  try {
    const pool = getPool();
    const [calls, stuckGroups, segBenefit, demand, leak, totals] = await Promise.all([
      pool.query(`SELECT lead_id, full_name, phone, project_name, status, rep_name, days_without_contact, lead_score, reason
                    FROM realestate.v_call_today ORDER BY lead_score DESC, days_without_contact DESC LIMIT ${MAX_CALLS}`),
      // Stuck apartments come in groups that share a cause (same project, size, type and side) — one finding each.
      pool.query(`SELECT s.project_name, MIN(u.project_id) AS project_id, s.rooms, s.unit_type, s.direction,
                         COUNT(*)::int AS units, MIN(s.days_on_market) AS min_days, MAX(s.days_on_market) AS max_days,
                         MIN(s.price_premium_pct) AS min_premium, MAX(s.price_premium_pct) AS max_premium,
                         MAX(s.leads_wanting_this_size_last_90_days) AS leads_90,
                         (ARRAY_AGG(s.unit_id ORDER BY s.price_premium_pct DESC))[1] AS first_unit
                    FROM realestate.v_stuck_units s JOIN realestate.units u USING (unit_id)
                   GROUP BY s.project_name, s.rooms, s.unit_type, s.direction
                   ORDER BY COUNT(*) DESC, MAX(s.price_premium_pct) DESC`),
      pool.query('SELECT purchase_purpose, offered_benefit, negotiations, close_rate_pct FROM realestate.v_segment_benefit WHERE negotiations >= 15'),
      // Who wants each size, per project, over the last half year — picks the segment a stuck group sells to.
      pool.query(`SELECT project_id, rooms_wanted, purchase_purpose, COUNT(*)::int AS n FROM realestate.leads
                   WHERE lead_date >= CURRENT_DATE - 180 GROUP BY 1, 2, 3`),
      discountLeak(pool),
      pool.query(`SELECT (SELECT COUNT(*) FROM realestate.leads)::int AS leads, (SELECT COUNT(*) FROM realestate.units)::int AS units,
                         (SELECT COUNT(*) FROM realestate.deals)::int AS deals`),
    ]);

    const t = totals.rows[0];
    const critical = calls.rows.filter(c => Number(c.lead_score) >= CRITICAL_CALL_SCORE);
    const shown = critical.length >= 3 ? critical : calls.rows.slice(0, 5);
    const callItems = shown.map(c => ({
      leadId: c.lead_id, name: c.full_name, phone: c.phone, project: c.project_name, rep: c.rep_name,
      score: Number(c.lead_score), daysWithoutContact: c.days_without_contact,
      // Silence is shown on its own line; the source is a detail the call prep covers.
      reason: String(c.reason).split(' · ').filter(p => !p.startsWith('בלי קשר') && !p.startsWith('מקור:')).slice(0, 3).join(' · '),
    }));
    const negotiating = shown.filter(c => c.status === 'משא ומתן').length;

    // The best benefit for a segment, by close rate in decided negotiations.
    const bestBenefit = (purpose) => segBenefit.rows.filter(r => r.purchase_purpose === purpose)
      .sort((a, b) => Number(b.close_rate_pct) - Number(a.close_rate_pct))[0];
    const stuckItems = stuckGroups.rows.slice(0, 3).map(g => {
      const wanting = demand.rows.filter(d => d.project_id === g.project_id && d.rooms_wanted === g.rooms);
      const total = wanting.reduce((a, d) => a + d.n, 0);
      const seg = wanting.sort((a, b) => b.n - a.n)[0];
      const best = seg ? bestBenefit(seg.purchase_purpose) : null;
      const premium = Number(g.min_premium) === Number(g.max_premium) ? `${Math.round(g.max_premium)}%` : `${Math.round(g.min_premium)}–${Math.round(g.max_premium)}%`;
      return {
        unitId: g.first_unit, projectId: g.project_id, project: g.project_name, rooms: g.rooms, type: g.unit_type, direction: g.direction,
        units: g.units, minDays: g.min_days, maxDays: g.max_days,
        title: g.units > 1
          ? `${g.units} דירות ${g.rooms} חד׳ ${g.direction} · ${g.project_name}`
          : `דירת ${g.rooms} חד׳ ${g.direction} · ${g.project_name}`,
        reason: `${premium} מעל עסקאות דומות`,
        // Developers move stock with terms and benefits, not list-price cuts.
        action: best && seg
          ? `במקום להוריד מחיר: להציע ${best.offered_benefit} — סוגר ${pct1(best.close_rate_pct)} מ"${seg.purchase_purpose}", ${seg.n / total >= 0.95 ? `הסגמנט של כל ${total} הלידים` : `${Math.round(100 * seg.n / total)}% מ־${total} הלידים`} שמחפשים ${g.rooms} חד׳ כאן`
          : `קמפיין ממוקד ל־${g.leads_90} הלידים שמחפשים ${g.rooms} חד׳`,
      };
    });
    const stuckTotal = stuckGroups.rows.reduce((a, g) => a + g.units, 0);
    const minDays = Math.min(...stuckGroups.rows.map(g => g.min_days));
    const maxDays = Math.max(...stuckGroups.rows.map(g => g.max_days));

    const since = leak.sinceMonth ? monthHe(leak.sinceMonth) : null;
    res.json({
      date: todayHe(),
      intro: `עברתי על ${t.leads.toLocaleString('en-US')} לידים, ${t.units} דירות ו־${t.deals} עסקאות בכל הפרויקטים, וסימנתי עבורך 3 דברים להיום: ${callItems.length} שיחות שכדאי לעשות, ${stuckTotal} דירות שנתקעו בגלל המחיר, והנחות של ${leak.rep} שעלו ${shekels(leak.amount)} מעל ממוצע החברה. לכל אחד — מה לעשות.`,
      kpis: {
        calls: { count: callItems.length, sub: `${negotiating} מהם בשלב משא ומתן` },
        stuck: { count: stuckTotal, sub: `${stuckItems.length === 1 ? 'קבוצה אחת' : `${stuckItems.length} קבוצות`} · ${minDays}–${maxDays} ימים על המדף` },
        leakage: { amount: shekels(leak.amount), sub: `הנחות מעל ממוצע החברה אצל ${leak.rep}` },
      },
      calls: callItems,
      stuck: stuckItems,
      leakage: {
        amount: shekels(leak.amount),
        amountSub: `הנחות מעל ממוצע החברה אצל ${leak.rep}`,
        bullets: [
          since
            ? `מאז ${since} ${leak.rep} נותן הנחה ממוצעת של ${pct1(leak.avgSince)} מול ${pct1(leak.companySince)} בחברה — על ${leak.dealsSince} עסקאות`
            : `${leak.rep} נותן הנחה מעל ממוצע החברה`,
          `לפני כן הוא עמד על ${pct1(leak.avgBefore)} — כמו שאר הצוות`,
          `מה לעשות: תקרת הנחה של ${pct1(leak.companySince + 1)} עם אישור מנהל לחריגה, ולהחליף הנחה בהטבה שמתאימה לסגמנט`,
        ],
      },
    });
  } catch (err) {
    console.error('[realestate] brief failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/** Bucketed share of `rows` (each { label, n }), largest first unless `order` fixes it. */
const shares = (rows, order) => {
  const total = rows.reduce((a, r) => a + Number(r.n), 0) || 1;
  const list = rows.map(r => ({ label: String(r.label), n: Number(r.n), pct: Math.round(1000 * Number(r.n) / total) / 10 }));
  return order ? order.map(l => list.find(r => r.label === l)).filter(Boolean) : list.sort((a, b) => b.n - a.n);
};

router.get('/market', async (req, res) => {
  try {
    const pool = getPool();
    const B = 'FROM realestate.v_deals';
    const [purpose, age, decile, homes, gender, profession, sources, projects, rooms, segBenefit] = await Promise.all([
      pool.query(`SELECT purchase_purpose AS label, COUNT(*) AS n ${B} GROUP BY 1`),
      pool.query(`SELECT CASE WHEN age < 30 THEN 'עד 30' WHEN age < 40 THEN '30–39' WHEN age < 50 THEN '40–49' WHEN age < 60 THEN '50–59' ELSE '60+' END AS label, COUNT(*) AS n ${B} GROUP BY 1`),
      pool.query(`SELECT CASE WHEN income_decile <= 5 THEN 'עשירון 1–5' WHEN income_decile <= 7 THEN 'עשירון 6–7' WHEN income_decile <= 8 THEN 'עשירון 8' ELSE 'עשירון 9–10' END AS label, COUNT(*) AS n ${B} GROUP BY 1`),
      pool.query(`SELECT CASE WHEN owned_apartments = 0 THEN 'דירה ראשונה' WHEN owned_apartments = 1 THEN 'דירה שנייה' ELSE 'דירה שלישית ומעלה' END AS label, COUNT(*) AS n ${B} GROUP BY 1`),
      pool.query(`SELECT gender AS label, COUNT(*) AS n ${B} GROUP BY 1`),
      pool.query(`SELECT profession AS label, COUNT(*) AS n ${B} GROUP BY 1`),
      pool.query('SELECT source, leads, deals, conversion_pct, cost_per_deal FROM realestate.v_source_performance ORDER BY cost_per_deal NULLS LAST'),
      pool.query(`SELECT p.project_name, p.city, p.region, s.pct_sold, s.monthly_sales_pace,
                         (SELECT COUNT(*) FROM realestate.leads l WHERE l.project_id = p.project_id) AS leads,
                         (SELECT ROUND(AVG(final_price_per_sqm)) FROM realestate.v_deals d WHERE d.project_name = p.project_name) AS price_per_sqm
                    FROM realestate.projects p JOIN realestate.v_project_sellout s USING (project_id) ORDER BY p.project_id`),
      pool.query(`SELECT r.rooms,
                         (SELECT COUNT(*) FROM realestate.leads WHERE rooms_wanted = r.rooms AND lead_date >= CURRENT_DATE - 180) AS demand,
                         (SELECT COUNT(*) FROM realestate.units WHERE rooms = r.rooms AND status = 'פנויה') AS free_units,
                         (SELECT ROUND(AVG(sqm)) FROM realestate.units WHERE rooms = r.rooms) AS avg_sqm
                    FROM (VALUES (3), (4), (5), (6)) r(rooms)`),
      pool.query('SELECT purchase_purpose, offered_benefit, negotiations, close_rate_pct FROM realestate.v_segment_benefit WHERE negotiations >= 15'),
    ]);
    const segments = [...new Set(segBenefit.rows.map(r => r.purchase_purpose))].map(seg => {
      const rows = segBenefit.rows.filter(r => r.purchase_purpose === seg).sort((a, b) => Number(b.close_rate_pct) - Number(a.close_rate_pct));
      return { segment: seg, best: rows[0].offered_benefit, bestRate: Number(rows[0].close_rate_pct), worst: rows[rows.length - 1].offered_benefit, worstRate: Number(rows[rows.length - 1].close_rate_pct) };
    });
    res.json({
      buyers: {
        purpose: shares(purpose.rows),
        age: shares(age.rows, ['עד 30', '30–39', '40–49', '50–59', '60+']),
        decile: shares(decile.rows, ['עשירון 1–5', 'עשירון 6–7', 'עשירון 8', 'עשירון 9–10']),
        homes: shares(homes.rows, ['דירה ראשונה', 'דירה שנייה', 'דירה שלישית ומעלה']),
        gender: shares(gender.rows),
        profession: shares(profession.rows).slice(0, 6), // share of ALL buyers, top six shown
      },
      sources: sources.rows.map(s => ({ source: s.source, leads: Number(s.leads), deals: Number(s.deals), conversionPct: Number(s.conversion_pct), costPerDeal: s.cost_per_deal == null ? null : Number(s.cost_per_deal) })),
      projects: projects.rows.map(p => ({ name: p.project_name, city: p.city, region: p.region, pctSold: Number(p.pct_sold), monthlyPace: Number(p.monthly_sales_pace), leads: Number(p.leads), pricePerSqm: Number(p.price_per_sqm) })),
      rooms: rooms.rows.map(r => ({ rooms: r.rooms, demand: Number(r.demand), freeUnits: Number(r.free_units), avgSqm: Number(r.avg_sqm) })),
      segments,
    });
  } catch (err) {
    console.error('[realestate] market failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
