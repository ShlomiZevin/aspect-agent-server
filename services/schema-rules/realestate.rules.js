/**
 * Real-estate developer demo ("אופק יזמות") SQL-generation rules.
 *
 * Synthetic dataset built by scripts/seed-realestate-synthetic.js. The business
 * logic (what "sold", "stuck", "cost per deal", "worth a call today" mean) lives
 * ONCE in that script's views, so chat, Intelligence and the building board all
 * compute it the same way — these rules route the generator to those views
 * rather than letting it re-derive the definitions per question.
 */

function realestateRules(schemaName) {
  const s = schemaName;
  return `
## realestate (Ofek Development — residential developer demo) Rules (CRITICAL — follow exactly)

A developer selling apartments off-plan in 5 projects. All text values are Hebrew — filter with the exact values below.

### Use the views first — they hold the agreed definitions
- \`${s}.v_project_sellout\` — per project: total/sold/reserved/available units, pct_sold, sold_last_90_days, monthly_sales_pace, months_to_sell_out, forecast_sell_out_date, signed_revenue, unsold_inventory_value. Use for "how is each project selling", "when will it sell out", inventory value.
- \`${s}.v_stuck_units\` — THE stuck apartments, the one definition every screen uses: unsold, over 180 days on the market AND priced 10%+ above what the same room count + unit type actually sold for in that project. Columns include price_premium_pct, days_on_market, leads_wanting_this_size_last_90_days. NEVER count stuck units any other way (not all unsold units, not just "over 180 days"). Select only project_name, building, unit_number, rooms, direction, days_on_market, price_premium_pct — the chat shows it in a narrow panel. "Stuck / not selling / overpriced units" → this view, \`ORDER BY price_premium_pct DESC NULLS LAST, days_on_market DESC\` — NEVER order by project_name first (that puts whichever project sorts first alphabetically on top and hides the worst units). Group by project only when the user asks per project.
- \`${s}.v_source_performance\` — per lead source: leads, office_visits, deals, visit_rate_pct, conversion_pct, marketing_spend, cost_per_lead, cost_per_deal. "Best / worst lead source", "where to put the marketing budget" → this view.
- \`${s}.v_campaign_roi\` — per campaign: budget_ils, leads, office_visits, deals, signed_revenue, cost_per_lead, cost_per_deal.
- \`${s}.v_rep_performance\` — per sales rep: median_first_response_minutes, pct_answered_within_hour, deals, conversion_pct, avg_discount_pct, company_avg_discount_pct, total_discount_ils, discount_above_company_avg_ils (THE discount-leakage figure — use it as is).
- \`${s}.v_rep_discount_monthly\` — per rep per signing month: deals, avg_discount_pct, company_avg_discount_pct. "Since when / is it getting worse" for discounts → this view, ORDER BY signed_month.
- \`${s}.v_segment_benefit\` — close rate of each purchase_purpose (buyer segment) by the offered_benefit. "Which benefit works for which segment" → this view.
- \`${s}.v_call_today\` — open leads worth calling: lead_score (0-100), reason (ready-made Hebrew reason), days_without_contact, phone, rep_name. "Who should we call today" → exactly these columns, so the table stays readable:
  \`SELECT full_name, phone, project_name, rep_name, lead_score, reason FROM ${s}.v_call_today ORDER BY lead_score DESC, days_without_contact DESC LIMIT 15\` (or the N asked for). Filter by project_name / rep_name when asked.
- \`${s}.v_deals\` — every signed deal with unit, price, discount, benefit, payment_plan, index_linkage AND the buyer's profile (age, gender, profession, income_decile, family_status, children, purchase_purpose, source, city_of_residence, days_lead_to_deal). Buyer-profile questions ("who buys", "age of buyers", "investors vs first home") → this view, AGGREGATED: one row per group (purpose, age band, decile band) with COUNT and share — at most 5 columns, never one row per combination of several dimensions. Age bands: עד 30 / 30-39 / 40-49 / 50-59 / 60+. First/second home = owned_apartments 0 / 1 / 2+.
- \`${s}.v_units\` — every unit with project, price_per_sqm, status, days_on_market.

### Base tables (when no view fits)
- \`${s}.leads\` — one row per lead (inquiry). lead_date, project_id, source, campaign_id, demographics (gender 'גבר'/'אישה', age, family_status, children, profession, income_decile 1-10, city_of_residence), purchase_purpose, owned_apartments, rooms_wanted, budget, mortgage_preapproved, rep_name, first_response_minutes, status, lost_reason, visit_date, negotiation_date, offered_benefit.
- \`${s}.deals\` — one row per signed contract (at most ONE per lead, one per unit). JOIN leads ON lead_id, units ON unit_id.
- \`${s}.activities\` — MANY rows per lead (calls, WhatsApp, visits). NEVER join it to leads before aggregating leads — aggregate activities per lead first.
- \`${s}.units\`, \`${s}.projects\`, \`${s}.campaigns\`, \`${s}.sales_reps\`.

### Vocabulary (exact values)
- projects.project_name: 'אופק פארק' (ראשון לציון, מרכז), 'אופק ים' (נתניה, שרון), 'אופק כרמל' (חיפה, צפון), 'אופק הנגב' (באר שבע, דרום), 'אופק העיר' (ירושלים). A user naming a CITY means that project.
- leads.status: 'חדש', 'בטיפול', 'ביקר במשרד', 'משא ומתן', 'נחתם חוזה' (= bought), 'אבוד'. Open = 'חדש','בטיפול','ביקר במשרד','משא ומתן'.
- units.status: 'נמכרה', 'שמורה', 'פנויה'. unit_type: 'דירה', 'דירת גן', 'פנטהאוז', 'מיני פנטהאוז'. direction e.g. 'צפון-מערב' (use LIKE 'צפון%' for north-facing).
- purchase_purpose (buyer segment): 'דירה ראשונה' (first home), 'משפרי דיור' (upgraders / second home), 'השקעה' (investment), 'עבור הילדים' (buying for children or grandchildren).
- source: 'פייסבוק','אינסטגרם','גוגל','יד2','מדלן','יריד נדל"ן','ערב השקה','המלצת חבר','שלט באתר הבנייה','אתר החברה','מתווך'.
- offered_benefit / deals.benefit: 'מימון 20/80','ללא הצמדה למדד','מטבח מתנה','הנחה במחיר','שדרוג מפרט','חניה נוספת'.
- deals.index_linkage (linkage to מדד תשומות הבנייה until delivery): 'הצמדה מלאה','הצמדה חלקית (50%)','ללא הצמדה'. "מדד", "הצמדה", "צמוד" → this column.
- 'עבור הילדים' also covers grandchildren — there is no separate grandchildren segment.

### Definitions
- Conversion = leads that reached status 'נחתם חוזה' / all leads (in %). Lead→deal time = deals.signed_date - leads.lead_date.
- Conversion over TIME / "WHY did conversion change or drop" → \`${s}.v_conversion_monthly\` (per project per lead month: leads, office_visits, deals, conversion_pct, reps, median_first_response_minutes, pct_answered_within_hour; only months old enough to have converted). Return every month of the project in question ORDER BY lead_month, so the change, the rep who handled it and the call-back speed are visible side by side. Never compare leads from the last 90 days with older ones — they have not had time to sign.
- Revenue = SUM(deals.final_price). Discount = deals.discount_pct / discount_ils.
- Time: data runs to today. "This year" = lead_date / signed_date >= DATE_TRUNC('year', CURRENT_DATE). For month-by-month trends use complete months unless the user asks for the current one.
`;
}

module.exports = { realestateRules };
