/**
 * The Aspect demo's financial statements, for the Apps screens (task #116).
 *
 * Same engine as the chat tool — `finance-reports.js`, straight from the demo
 * books — but handed over as STRUCTURE (sections, their lines, their totals)
 * rather than a markdown table, so the app can draw a statement the way a
 * company report is laid out instead of a flat grid.
 *
 * Demo-only by construction: every query inside the engine is hardcoded to the
 * `aspect` schema, so there is no dataset parameter to get wrong and no other
 * client can reach it. Read-only — the only verbs here are GET.
 */
const express = require('express');
const { getFinanceReport, PRESETS, REPORTS } = require('./finance-reports');

const router = express.Router();

/** The statements the Apps page offers, in the order a reader expects them. */
const CATALOG = [
  { id: 'pnl', name: { he: 'דוח רווח והפסד', en: 'Profit & loss' } },
  { id: 'balance_sheet', name: { he: 'מאזן', en: 'Balance sheet' } },
  { id: 'cash_flow', name: { he: 'דוח תזרים מזומנים', en: 'Cash flow' } },
  { id: 'branch_profitability', name: { he: 'רווחיות סניפים', en: 'Branch profitability' } },
  { id: 'monthly_trend', name: { he: 'מגמה חודשית', en: 'Monthly trend' } },
  { id: 'line_by_branch', name: { he: 'סעיף לפי סניף', en: 'One line by branch' } },
];

const PERIOD_OPTIONS = [
  { id: 'last_month_vs_last_year', name: { he: 'החודש האחרון מול אשתקד', en: 'Last month vs last year' } },
  { id: 'last_month_vs_previous_month', name: { he: 'החודש האחרון מול הקודם', en: 'Last month vs previous month' } },
  { id: 'ytd_vs_last_ytd', name: { he: 'מתחילת השנה מול אשתקד', en: 'Year to date vs last year' } },
  { id: 'last_quarter_vs_last_year', name: { he: 'הרבעון האחרון מול אשתקד', en: 'Last quarter vs last year' } },
];

router.get('/catalog', (_req, res) => {
  res.json({ reports: CATALOG, periods: PERIOD_OPTIONS });
});

router.get('/report', async (req, res) => {
  const { report, preset, a_from, a_to, b_from, b_to, branch, line } = req.query;
  if (report && !REPORTS.includes(report)) {
    return res.status(400).json({ success: false, error: 'unknown_report', message: `report must be one of: ${REPORTS.join(', ')}` });
  }
  if (preset && !PRESETS.includes(preset)) {
    return res.status(400).json({ success: false, error: 'unknown_preset', message: `preset must be one of: ${PRESETS.join(', ')}` });
  }
  try {
    const r = await getFinanceReport({ report, preset, a_from, a_to, b_from, b_to, branch, line });
    if (!r.success) return res.status(422).json(r);
    // `report_markdown` is for the chat's fallback path; a screen that draws
    // the statement itself has no use for a second copy of the same numbers.
    const { report_markdown: _markdown, view, ...rest } = r;
    res.json({ ...rest, columns: view.columns, blocks: view.blocks });
  } catch (err) {
    console.error('[aspect-finance] report failed:', err.message);
    res.status(500).json({ success: false, error: 'report_failed', message: err.message });
  }
});

module.exports = router;
