/**
 * Real-estate demo screens — the data behind the two designed pages:
 *
 *   GET /api/realestate/board  — "לוח מכירות חי": every project, building and
 *                                 apartment with its status, plus the chain KPIs
 *                                 and the Intelligence reports' headlines.
 *   GET /api/realestate/brief  — "היועץ החכם שלי": the morning brief — who to
 *                                 call, which apartments are stuck and why,
 *                                 where discounts leak money.
 *
 * Read-only, straight from the views of scripts/seed-realestate-synthetic.js,
 * which hold the business definitions. Every sentence is composed from the
 * numbers here, not by a model, so the screens are instant and always agree
 * with what the chat answers.
 */

const express = require('express');
const { getPool } = require('../../services/db.realestate');

const router = express.Router();
const STUCK_DAYS = 180;
const STUCK_PREMIUM_PCT = 10;

const shekels = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `₪${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `₪${Math.round(v / 1e3)}K`;
  return `₪${Math.round(v)}`;
};
const todayHe = () => new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' }).format(new Date());

/** The Intelligence "Suggested reports" for this dataset, newest first — the board's overnight insights. */
async function suggestedReports() {
  try {
    const store = require('../../insights/services/insights-store.service');
    const list = await store.listByUser('realestate', 'system');
    return list.map(i => ({ id: i.id, title: i.title, headline: i.headline || i.summary || '' }));
  } catch (err) {
    console.warn('[realestate] suggested reports unavailable:', err.message);
    return [];
  }
}

router.get('/board', async (req, res) => {
  try {
    const pool = getPool();
    const [projects, units, sold30, reports] = await Promise.all([
      pool.query(`SELECT p.project_id, p.project_name, p.city, p.region, p.floors, s.pct_sold, s.sold_units, s.reserved_units, s.available_units,
                         s.total_units, s.monthly_sales_pace, s.forecast_sell_out_date
                    FROM realestate.projects p JOIN realestate.v_project_sellout s ON s.project_id = p.project_id
                   ORDER BY p.project_id`),
      pool.query(`SELECT u.unit_id, u.project_id, u.building, u.floor, u.position, u.unit_number, u.rooms, u.unit_type, u.sqm, u.outdoor_sqm,
                         u.direction, u.view, u.list_price, u.status, CURRENT_DATE - u.listed_date AS days_on_market, s.price_premium_pct
                    FROM realestate.units u LEFT JOIN realestate.v_stuck_units s USING (unit_id)
                   ORDER BY u.project_id, u.building, u.floor, u.position`),
      pool.query("SELECT COUNT(*)::int AS n FROM realestate.units WHERE sold_date >= CURRENT_DATE - 30"),
      suggestedReports(),
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
            // "Stuck" on the board = over STUCK_DAYS on the market AND priced well above what the
            // same kind of unit actually sold for — the units whose price is the problem. Plain
            // "unsold for a while" would light up every leftover unit of every older project.
            premiumPct: u.price_premium_pct == null ? null : Number(u.price_premium_pct),
            stuck: u.status === 'פנויה' && u.days_on_market > STUCK_DAYS && Number(u.price_premium_pct) >= STUCK_PREMIUM_PCT,
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
      insights: reports.slice(0, 3),
    });
  } catch (err) {
    console.error('[realestate] board failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/brief', async (req, res) => {
  try {
    const pool = getPool();
    const [calls, callsHot, stuck, stuckAll, reps, totals] = await Promise.all([
      pool.query(`SELECT lead_id, full_name, phone, project_name, status, purchase_purpose, rooms_wanted, budget, mortgage_preapproved,
                         source, rep_name, days_without_contact, lead_score, reason
                    FROM realestate.v_call_today ORDER BY lead_score DESC, days_without_contact DESC LIMIT 5`),
      pool.query('SELECT COUNT(*)::int AS n FROM realestate.v_call_today WHERE lead_score >= 85'),
      pool.query(`SELECT s.unit_id, s.project_name, s.city, s.building, s.floor, s.unit_number, s.rooms, s.unit_type, s.sqm, s.direction,
                         s.list_price, s.days_on_market, s.price_premium_pct, s.avg_sold_price_per_sqm_same_rooms, s.leads_wanting_this_size_last_90_days,
                         u.project_id
                    FROM realestate.v_stuck_units s JOIN realestate.units u USING (unit_id)
                   ORDER BY s.price_premium_pct DESC NULLS LAST, s.days_on_market DESC LIMIT 5`),
      pool.query('SELECT COUNT(*)::int AS n, ROUND(AVG(days_on_market))::int AS avg_days FROM realestate.v_stuck_units WHERE price_premium_pct >= 10'),
      pool.query('SELECT rep_name, deals, avg_discount_pct, company_avg_discount_pct, total_discount_ils, discount_above_company_avg_ils FROM realestate.v_rep_performance ORDER BY discount_above_company_avg_ils DESC'),
      pool.query(`SELECT (SELECT COUNT(*) FROM realestate.leads)::int AS leads, (SELECT COUNT(*) FROM realestate.units)::int AS units,
                         (SELECT COUNT(*) FROM realestate.deals)::int AS deals, (SELECT COUNT(*) FROM realestate.deals WHERE discount_pct > 4)::int AS deals_over_4,
                         (SELECT COUNT(*) FROM realestate.deals WHERE discount_pct > 4 AND signed_date >= CURRENT_DATE - 90)::int AS deals_over_4_recent,
                         (SELECT COUNT(*) FROM realestate.deals WHERE signed_date >= CURRENT_DATE - 90)::int AS deals_recent`),
    ]);

    const t = totals.rows[0];
    const top = reps.rows[0];
    const leak = Number(top.discount_above_company_avg_ils);
    const hot = callsHot.rows[0].n;
    const overpriced = stuckAll.rows[0];

    const callItems = calls.rows.map(c => {
      const parts = String(c.reason).split(' · ');
      return {
        leadId: c.lead_id, name: c.full_name, phone: c.phone, project: c.project_name, rep: c.rep_name,
        score: Number(c.lead_score), daysWithoutContact: c.days_without_contact,
        // The headline reason is the stage + the strongest buying signal; the "no contact" part is shown on its own.
        reason: parts.filter(p => !p.startsWith('אין קשר')).slice(0, 2).join(' · '),
      };
    });

    const stuckItems = stuck.rows.map(s => {
      const premium = Number(s.price_premium_pct);
      const fair = Math.round(Number(s.avg_sold_price_per_sqm_same_rooms) * s.sqm / 10000) * 10000;
      const cut = Math.round(100 * (fair / Number(s.list_price) - 1));
      const reason = premium >= 10 ? 'מחיר גבוה ביחס לשוק' : Number(s.leads_wanting_this_size_last_90_days) < 10 ? 'ביקוש נמוך לגודל הזה' : 'זמן ארוך על המדף';
      const action = premium >= 10
        ? `להתאים מחיר ל־${shekels(fair)} (${cut}%) — יש ${s.leads_wanting_this_size_last_90_days} לידים לגודל הזה`
        : `קמפיין ממוקד ל־${s.leads_wanting_this_size_last_90_days} הלידים שמחפשים ${s.rooms} חד׳`;
      return {
        unitId: s.unit_id, projectId: s.project_id, project: s.project_name, city: s.city, building: s.building, floor: s.floor,
        number: s.unit_number, rooms: s.rooms, type: s.unit_type, direction: s.direction, price: Number(s.list_price),
        daysOnMarket: s.days_on_market, premiumPct: premium, reason, action,
      };
    });

    const companyAvg = Number(top.company_avg_discount_pct);
    res.json({
      date: todayHe(),
      intro: `עברתי על ${t.leads.toLocaleString('en-US')} לידים, ${t.units} דירות ו־${t.deals} עסקאות בכל הפרויקטים, וסימנתי עבורך את 3 הדברים שחשובים היום: ${hot} שיחות שכדאי לעשות, ${overpriced.n} דירות שנתקעו בגלל המחיר, וזליגת הנחות שכבר עלתה ${shekels(leak)}. בהמשך — המלצה ברורה לכל אחד.`,
      kpis: {
        calls: { count: hot, sub: `${callItems.filter(c => c.score >= 95).length} לידים בשלב סגירה עם משכנתא מאושרת` },
        stuck: { count: overpriced.n, sub: `זמן ממוצע על המדף: ${overpriced.avg_days} ימים` },
        leakage: { amount: shekels(leak), sub: `הנחות מעל ממוצע החברה אצל ${top.rep_name}` },
      },
      calls: callItems,
      stuck: stuckItems,
      leakage: {
        amount: shekels(leak),
        amountSub: 'הנחות מעבר לממוצע החברה — כסף שנשאר על השולחן',
        bullets: [
          `${top.rep_name} נותן הנחה ממוצעת של ${Number(top.avg_discount_pct).toFixed(1)}% מול ${companyAvg.toFixed(1)}% בחברה — על ${top.deals} עסקאות`,
          `${t.deals_over_4} מתוך ${t.deals} העסקאות נסגרו בהנחה של מעל 4% (${Math.round(100 * t.deals_over_4 / t.deals)}%)`,
          `תקרת הנחה של ${companyAvg.toFixed(1)}% עם אישור מנהל לחריגה הייתה חוסכת ${shekels(leak)}`,
        ],
        reps: reps.rows.slice(0, 4).map(r => ({ name: r.rep_name, avgDiscountPct: Number(r.avg_discount_pct), aboveAvg: Number(r.discount_above_company_avg_ils) })),
      },
    });
  } catch (err) {
    console.error('[realestate] brief failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
