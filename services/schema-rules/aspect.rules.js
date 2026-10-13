/**
 * TechZone (the Aspect demo dataset) SQL-generation rules - task #112.
 *
 * Written 2026-10-13 after the Intelligence Center's suggested reports, asked
 * about "operating profit vs last year", wrote WHERE year = 2024 ("2024 is
 * fully closed") and reported "no 2023 data" - with no rules the generator
 * picked its own analysis period. The finance views are built by
 * scripts/seed-aspect-synthetic.js and match the chat's finance reports
 * (agents/aspect/finance-reports.js) line for line.
 */

function aspectRules(schemaName) {
  const s = schemaName;
  return `
## aspect (TechZone demo) Rules (CRITICAL — follow exactly)

### Time: anchor on the books, never pick a year yourself
- The finance books are MONTHLY and hold only CLOSED months: January 2024 to the last closed month = \`(SELECT MAX(month) FROM ${s}.fin_monthly_summary)\`. The current month is not booked.
- "Recent", "this year", "year to date", "last month" ALWAYS mean relative to that last closed month. Derive it with the subquery above — never hard-code a year, and NEVER choose 2024 as the analysis period unless the user names 2024.
- Year to date = months of the last closed month's year up to that month:
  \`WHERE year = (SELECT EXTRACT(YEAR FROM MAX(month))::int FROM ${s}.fin_monthly_summary) AND month <= (SELECT MAX(month) FROM ${s}.fin_monthly_summary)\`.
- Year-over-year: use the \`*_last_year\` / \`amount_last_year\` columns already on every finance view. They are filled from January 2025 onward (2024 has no prior year) — another reason to analyse the latest year.

### Finance: query ONLY these views, never ${s}.fin_ledger / ${s}.fin_balances
- \`${s}.fin_monthly_summary\` — one row per month: revenue, gross_profit, operating_profit, profit_before_tax and each \`*_last_year\`. Trends and year-over-year.
- \`${s}.fin_pnl_lines\` — the P&L as rows per month: \`line\`, \`section\`, \`line_order\`, \`is_total\`, \`amount\`, \`amount_last_year\`, \`revenue\`, \`revenue_last_year\`. Expenses are positive. Filter by the Hebrew \`line\` (e.g. 'הוצאות שכר', 'שכר דירה', 'דמי ניהול', 'סה"כ הוצאות תפעול', 'רווח תפעולי'). % of revenue = amount / revenue. NEVER SUM the stock lines 'מלאי פתיחה' / 'מלאי סגירה' across months.
  \`revenue\` / \`revenue_last_year\` are the MONTH's total revenue, repeated on every line of that month BY DESIGN (so each line can show its % of revenue) — identical revenue across lines is correct, not a join error. To compare a line's growth with revenue growth, sum each line's amount over the months and sum revenue ONCE per month (e.g. from fin_monthly_summary), never revenue summed over lines.
- \`${s}.fin_line_branch\` — every P&L line by \`branch\` (Hebrew city name; 'מטה' = head office) for \`period\` = 'החודש האחרון שנסגר' or 'מתחילת השנה', with \`amount\`, \`amount_last_year\`, \`branch_revenue\`. Branch profitability: line = 'רווח תפעולי סניפי' (or 'רווח גולמי'); exclude branch 'מטה' and 'אונליין' only if the user asks for physical branches.
- \`${s}.fin_balance_lines\` — balance sheet rows at each month-end (\`year_month\`): 'מזומנים ושווי מזומנים', 'מלאי', 'ספקים ונותני שירותים', 'הלוואות מתאגידים בנקאיים', 'סה"כ הון עצמי', 'סה"כ נכסים', ... with \`amount_last_year\`. Latest balance = the last closed month's \`year_month\`.

### Sales
- \`${s}.sales\` lines: revenue = \`qty * unit_price\`, cost = \`qty * unit_cost\` (both ex-VAT). Join \`${s}.stores\` on \`store_id\`; branch name = \`stores.name_he\`; \`is_online = true\` is the online channel, not a physical branch.
- Sales run to today (the current month is partial). For month comparisons use complete months.
`;
}

module.exports = { aspectRules };
