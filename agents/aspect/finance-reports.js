/**
 * TechZone finance reports for the Aspect demo (task #112).
 *
 * Fixed, deterministic reports over the synthetic ledger that
 * scripts/seed-aspect-synthetic.js builds (aspect.fin_sections /
 * fin_accounts / fin_ledger). The model never writes SQL or numbers here: it
 * picks a report and a period, this module returns a finished Hebrew table,
 * and the crew pastes it. Same question, same answer, every time - which is
 * the point of the task ("consistent, from a data source, not invented").
 *
 * Layout follows the client's Qlik finance model: two periods side by side,
 * the gap, and every line as a percentage of that period's revenue; a line
 * can be broken down by branch.
 */

const { getPool } = require('../../services/db.aspect');

const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const HQ_NAME = 'מטה';

const PRESETS = ['last_month_vs_last_year', 'last_month_vs_previous_month', 'ytd_vs_last_ytd', 'last_quarter_vs_last_year', 'custom'];
const REPORTS = ['pnl', 'line_by_branch', 'branch_profitability', 'monthly_trend'];

// ── periods ────────────────────────────────────────────────────────────────

/** 'YYYY-MM' <-> month index (year*12 + month-1), so period math is integer math. */
const toIdx = ym => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const fromIdx = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

function periodLabel(fromYm, toYm) {
  const [fy, fm] = [Number(fromYm.slice(0, 4)), Number(fromYm.slice(5, 7))];
  const [ty, tm] = [Number(toYm.slice(0, 4)), Number(toYm.slice(5, 7))];
  if (fromYm === toYm) return `${MONTHS_HE[fm - 1]} ${fy}`;
  if (fy === ty) return `${MONTHS_HE[fm - 1]}-${MONTHS_HE[tm - 1]} ${ty}`;
  return `${MONTHS_HE[fm - 1]} ${fy} - ${MONTHS_HE[tm - 1]} ${ty}`;
}

const period = (fromI, toI) => ({ from: fromIdx(fromI), to: fromIdx(toI), label: periodLabel(fromIdx(fromI), fromIdx(toI)) });

/**
 * Resolves a preset (or custom 'YYYY-MM' bounds) against the last closed
 * month in the ledger. Custom bounds are clamped into the data's range.
 */
function resolvePeriods({ preset, a_from, a_to, b_from, b_to }, firstYm, lastYm) {
  const last = toIdx(lastYm);
  const first = toIdx(firstYm);
  const clamp = i => Math.max(first, Math.min(last, i));
  const valid = s => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);

  if (preset === 'custom' && valid(a_from)) {
    const aF = clamp(toIdx(a_from));
    const aT = clamp(valid(a_to) ? toIdx(a_to) : aF);
    const len = aT - aF;
    // No B given: the same months a year earlier, the usual comparison.
    const bF = clamp(valid(b_from) ? toIdx(b_from) : aF - 12);
    const bT = clamp(valid(b_to) ? toIdx(b_to) : bF + len);
    return { a: period(aF, aT), b: period(bF, bT) };
  }
  switch (preset) {
    case 'last_month_vs_previous_month':
      return { a: period(last, last), b: period(last - 1, last - 1) };
    case 'ytd_vs_last_ytd': {
      const jan = last - (last % 12);
      return { a: period(jan, last), b: period(jan - 12, last - 12) };
    }
    case 'last_quarter_vs_last_year': {
      // The last FULLY closed calendar quarter.
      const qEnd = (last % 12) % 3 === 2 ? last : last - ((last % 12) % 3) - 1;
      return { a: period(qEnd - 2, qEnd), b: period(qEnd - 14, qEnd - 12) };
    }
    case 'last_month_vs_last_year':
    default:
      return { a: period(last, last), b: period(last - 12, last - 12) };
  }
}

// ── formatting ─────────────────────────────────────────────────────────────

const fmtNum = v => (v == null || Number.isNaN(v) ? '' : Math.round(v).toLocaleString('en-US'));
const fmtPct = (num, den) => {
  if (!den) return '';
  const p = (100 * num) / den;
  return `${Math.abs(p) < 10 ? p.toFixed(1) : Math.round(p)}%`;
};
const fmtChange = (a, b) => (b ? fmtPct(a - b, Math.abs(b)) : '');
const bold = s => (s === '' ? '' : `**${s}**`);

function markdownTable(columns, rows) {
  const esc = v => String(v ?? '').replace(/\|/g, '/');
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

// ── data ───────────────────────────────────────────────────────────────────

/**
 * "This ledger row belongs to the period $from..$to" — except stock: over a
 * multi-month period, opening stock is the FIRST month's and closing stock the
 * LAST month's (summing them per month would multiply the stock). Purchases
 * still sum, so opening + purchases - closing is the period's cost of sales.
 */
const inPeriod = (from, to) =>
  `CASE l.account_code WHEN 2010 THEN l.month = ${from} WHEN 2030 THEN l.month = ${to} ELSE l.month BETWEEN ${from} AND ${to} END`;

async function ledgerRange(pool) {
  const { rows } = await pool.query(`SELECT to_char(MIN(month), 'YYYY-MM') AS first, to_char(MAX(month), 'YYYY-MM') AS last FROM aspect.fin_ledger`);
  return rows[0];
}

/** Finds a branch by Hebrew/English name or number. HQ is not a branch here. */
async function findBranch(pool, branch) {
  if (branch == null || String(branch).trim() === '') return null;
  const q = String(branch).trim();
  const { rows } = await pool.query(
    `SELECT store_id, name_he FROM aspect.stores
      WHERE store_id::text = $1 OR name_he ILIKE $2 OR name ILIKE $2
      ORDER BY (name_he = $1) DESC, length(name_he) LIMIT 1`,
    [q, `%${q}%`]
  );
  return rows[0] || { notFound: q };
}

/** Sums per account for periods A and B (optionally one branch). */
async function accountTotals(pool, a, b, storeId) {
  const params = [`${a.from}-01`, `${a.to}-01`, `${b.from}-01`, `${b.to}-01`];
  // The branch condition sits in the JOIN, not a WHERE, so every account
  // still appears (with 0) for a branch that has no rows on it.
  let branchCond = '';
  if (storeId != null) { params.push(storeId); branchCond = 'AND l.store_id = $5'; }
  const { rows } = await pool.query(
    `SELECT s.section_code, s.section_name, s.section_order, s.sign,
            a.account_code, a.account_name, a.line_order,
            COALESCE(SUM(l.amount) FILTER (WHERE ${inPeriod('$1::date', '$2::date')}), 0)::float AS a_amt,
            COALESCE(SUM(l.amount) FILTER (WHERE ${inPeriod('$3::date', '$4::date')}), 0)::float AS b_amt
       FROM aspect.fin_accounts a
       JOIN aspect.fin_sections s USING (section_code)
       LEFT JOIN aspect.fin_ledger l ON l.account_code = a.account_code ${branchCond}
      GROUP BY 1, 2, 3, 4, 5, 6, 7
      ORDER BY s.section_order, a.line_order`,
    params
  );
  return rows;
}

// ── reports ────────────────────────────────────────────────────────────────

/** The P&L in the Qlik model's order, with the three computed profit rows. */
async function pnl(pool, a, b, branch) {
  const accounts = await accountTotals(pool, a, b, branch?.store_id ?? null);
  const sections = [];
  for (const r of accounts) {
    let s = sections.find(x => x.code === r.section_code);
    if (!s) { s = { code: r.section_code, name: r.section_name, sign: r.sign, lines: [], a: 0, b: 0 }; sections.push(s); }
    s.lines.push(r);
    s.a += r.a_amt;
    s.b += r.b_amt;
  }
  const sec = code => sections.find(s => s.code === code) || { a: 0, b: 0, lines: [] };
  const revA = sec('REV').a, revB = sec('REV').b;

  const out = [];
  const line = (name, va, vb, strong = false) => {
    const cells = [name, fmtNum(va), fmtPct(va, revA), fmtNum(vb), fmtPct(vb, revB), fmtNum(va - vb), fmtChange(va, vb)];
    out.push(strong ? cells.map(bold) : cells);
  };
  const profit = { a: 0, b: 0 };
  const addSection = code => {
    const s = sec(code);
    // A branch carries no head-office lines - leave out what is empty in both periods.
    const lines = s.lines.filter(l => l.a_amt !== 0 || l.b_amt !== 0);
    if (!lines.length) return;
    for (const l of lines) line(l.account_name, l.a_amt, l.b_amt);
    if (lines.length > 1) line(`סה"כ ${s.name}`, s.a, s.b, true);
    profit.a += s.sign * s.a;
    profit.b += s.sign * s.b;
  };

  addSection('REV');
  addSection('COGS');
  line('רווח גולמי', profit.a, profit.b, true);
  const gross = { ...profit };
  addSection('OPEX');
  addSection('GA');
  line(branch ? 'רווח תפעולי של הסניף' : 'רווח תפעולי', profit.a, profit.b, true);
  const operating = { ...profit };
  addSection('FIN');
  addSection('DEP');
  addSection('OTH');
  line('רווח (הפסד) לפני מס', profit.a, profit.b, true);

  const columns = ['סעיף', `${a.label} (₪)`, '% מההכנסות', `${b.label} (₪)`, '% מההכנסות', 'הפרש (₪)', 'שינוי %'];
  const title = `דוח רווח והפסד - ${a.label} מול ${b.label}${branch ? ` - סניף ${branch.name_he}` : ''}`;
  return {
    title,
    columns,
    rows: out,
    highlights: {
      revenue: { a: Math.round(revA), b: Math.round(revB), change: fmtChange(revA, revB) },
      gross_profit: { a: Math.round(gross.a), b: Math.round(gross.b), margin_a: fmtPct(gross.a, revA), margin_b: fmtPct(gross.b, revB) },
      operating_profit: { a: Math.round(operating.a), b: Math.round(operating.b), margin_a: fmtPct(operating.a, revA), margin_b: fmtPct(operating.b, revB) },
      profit_before_tax: { a: Math.round(profit.a), b: Math.round(profit.b), margin_a: fmtPct(profit.a, revA), margin_b: fmtPct(profit.b, revB) },
      biggest_expense_changes: accounts
        .filter(r => ['OPEX', 'GA', 'FIN'].includes(r.section_code))
        .map(r => ({ line: r.account_name, a: Math.round(r.a_amt), b: Math.round(r.b_amt), gap: Math.round(r.a_amt - r.b_amt), change: fmtChange(r.a_amt, r.b_amt) }))
        .sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap))
        .slice(0, 3),
      ...(branch ? { note: 'דוח סניף: ללא הוצאות מטה (הנהלה וכלליות, ריבית, הכנסות אחרות)' } : {}),
    },
  };
}

/** One P&L line (or a whole section) split across the branches, HQ included. */
async function lineByBranch(pool, a, b, lineQuery) {
  const q = String(lineQuery || '').trim();
  if (!q) return { error: 'missing_line', message: 'Which P&L line? e.g. דמי ניהול, שכר דירה, הוצאות תפעול.' };
  const { rows: matches } = await pool.query(
    `SELECT 'account' AS kind, account_code::text AS code, account_name AS name FROM aspect.fin_accounts WHERE account_name ILIKE $1
     UNION ALL
     SELECT 'section', section_code, section_name FROM aspect.fin_sections WHERE section_name ILIKE $1
     ORDER BY 1, 3`,
    [`%${q}%`]
  );
  if (!matches.length) {
    const { rows } = await pool.query(`SELECT account_name FROM aspect.fin_accounts ORDER BY line_order`);
    return { error: 'line_not_found', message: `No P&L line matches "${q}".`, available_lines: rows.map(r => r.account_name) };
  }
  // Prefer an exact name, then an account over a section.
  const m = matches.find(x => x.name === q) || matches.find(x => x.kind === 'account') || matches[0];
  const filter = m.kind === 'account' ? 'l.account_code = $5::int' : 'a.section_code = $5';

  const { rows } = await pool.query(
    `WITH x AS (
       SELECT l.store_id,
              COALESCE(SUM(l.amount) FILTER (WHERE ${inPeriod('$1::date', '$2::date')}), 0)::float AS a_amt,
              COALESCE(SUM(l.amount) FILTER (WHERE ${inPeriod('$3::date', '$4::date')}), 0)::float AS b_amt
         FROM aspect.fin_ledger l JOIN aspect.fin_accounts a USING (account_code)
        WHERE ${filter}
        GROUP BY l.store_id
     ), rev AS (
       SELECT store_id, COALESCE(SUM(amount) FILTER (WHERE month BETWEEN $1 AND $2), 0)::float AS rev_a
         FROM aspect.fin_ledger WHERE account_code = 1010 GROUP BY store_id
     )
     SELECT COALESCE(s.name_he, '${HQ_NAME}') AS branch, x.a_amt, x.b_amt, rev.rev_a
       FROM x LEFT JOIN aspect.stores s ON s.store_id = x.store_id
              LEFT JOIN rev ON rev.store_id IS NOT DISTINCT FROM x.store_id
      WHERE x.a_amt <> 0 OR x.b_amt <> 0
      ORDER BY x.a_amt DESC`,
    [`${a.from}-01`, `${a.to}-01`, `${b.from}-01`, `${b.to}-01`, m.code]
  );

  const tA = rows.reduce((s, r) => s + r.a_amt, 0);
  const tB = rows.reduce((s, r) => s + r.b_amt, 0);
  const tRev = rows.reduce((s, r) => s + (r.rev_a || 0), 0);
  const out = rows.map(r => [r.branch, fmtNum(r.a_amt), r.rev_a ? fmtPct(r.a_amt, r.rev_a) : '', fmtNum(r.b_amt), fmtNum(r.a_amt - r.b_amt), fmtChange(r.a_amt, r.b_amt)]);
  out.push(['סה"כ', fmtNum(tA), tRev ? fmtPct(tA, tRev) : '', fmtNum(tB), fmtNum(tA - tB), fmtChange(tA, tB)].map(bold));

  return {
    title: `${m.name} לפי סניף - ${a.label} מול ${b.label}`,
    columns: ['סניף', `${a.label} (₪)`, '% מהכנסות הסניף', `${b.label} (₪)`, 'הפרש (₪)', 'שינוי %'],
    rows: out,
    highlights: {
      line: m.name,
      total: { a: Math.round(tA), b: Math.round(tB), change: fmtChange(tA, tB) },
      highest_branch: rows[0] ? { branch: rows[0].branch, a: Math.round(rows[0].a_amt) } : null,
      branches: rows.length,
    },
  };
}

/** Branch contribution: revenue, gross profit, branch opex, branch operating profit. */
async function branchProfitability(pool, a, b) {
  const { rows } = await pool.query(
    `SELECT s.name_he AS branch,
            SUM(l.amount) FILTER (WHERE ${inPeriod('$1::date', '$2::date')} AND a.section_code = 'REV')::float AS rev_a,
            SUM(l.amount) FILTER (WHERE ${inPeriod('$1::date', '$2::date')} AND a.section_code = 'COGS')::float AS cogs_a,
            SUM(l.amount) FILTER (WHERE ${inPeriod('$1::date', '$2::date')} AND a.section_code = 'OPEX')::float AS opex_a,
            SUM(l.amount) FILTER (WHERE ${inPeriod('$3::date', '$4::date')} AND a.section_code = 'REV')::float AS rev_b,
            SUM(l.amount) FILTER (WHERE ${inPeriod('$3::date', '$4::date')} AND a.section_code = 'COGS')::float AS cogs_b,
            SUM(l.amount) FILTER (WHERE ${inPeriod('$3::date', '$4::date')} AND a.section_code = 'OPEX')::float AS opex_b
       FROM aspect.fin_ledger l
       JOIN aspect.fin_accounts a USING (account_code)
       JOIN aspect.stores s ON s.store_id = l.store_id
      GROUP BY s.name_he`,
    [`${a.from}-01`, `${a.to}-01`, `${b.from}-01`, `${b.to}-01`]
  );
  const data = rows.map(r => {
    const gpA = r.rev_a - r.cogs_a, opA = gpA - r.opex_a;
    const opB = (r.rev_b - r.cogs_b) - r.opex_b;
    return { ...r, gpA, opA, opB };
  }).sort((x, y) => y.opA - x.opA);

  const out = data.map(r => [r.branch, fmtNum(r.rev_a), fmtNum(r.gpA), fmtNum(r.opex_a), fmtNum(r.opA), fmtPct(r.opA, r.rev_a), fmtNum(r.opB), fmtNum(r.opA - r.opB)]);
  const sum = k => data.reduce((s, r) => s + (r[k] || 0), 0);
  out.push(['סה"כ סניפים', fmtNum(sum('rev_a')), fmtNum(sum('gpA')), fmtNum(sum('opex_a')), fmtNum(sum('opA')), fmtPct(sum('opA'), sum('rev_a')), fmtNum(sum('opB')), fmtNum(sum('opA') - sum('opB'))].map(bold));

  return {
    title: `רווחיות סניפים - ${a.label} (השוואה ל${b.label})`,
    columns: ['סניף', 'הכנסות (₪)', 'רווח גולמי (₪)', 'הוצאות תפעול (₪)', 'רווח תפעולי סניפי (₪)', '% רווח', `רווח תפעולי ${b.label} (₪)`, 'הפרש (₪)'],
    rows: out,
    highlights: {
      top: data.slice(0, 3).map(r => ({ branch: r.branch, operating_profit: Math.round(r.opA), margin: fmtPct(r.opA, r.rev_a) })),
      bottom: data.slice(-3).reverse().map(r => ({ branch: r.branch, operating_profit: Math.round(r.opA), margin: fmtPct(r.opA, r.rev_a) })),
      note: 'רווח תפעולי סניפי = רווח גולמי פחות הוצאות התפעול של הסניף, לפני הוצאות מטה',
    },
  };
}

/** The last 12 closed months up to the end of period A, chain or one branch. */
async function monthlyTrend(pool, a, branch) {
  const end = toIdx(a.to);
  const params = [`${fromIdx(end - 11)}-01`, `${a.to}-01`];
  let storeFilter = '';
  if (branch) { params.push(branch.store_id); storeFilter = 'AND l.store_id = $3'; }
  const { rows } = await pool.query(
    `SELECT to_char(l.month, 'YYYY-MM') AS ym,
            SUM(l.amount) FILTER (WHERE a.section_code = 'REV')::float AS rev,
            SUM(l.amount * -s.sign) FILTER (WHERE a.section_code = 'COGS')::float AS cogs,
            SUM(l.amount) FILTER (WHERE a.section_code IN ('OPEX', 'GA'))::float AS opex,
            SUM(l.amount * s.sign)::float AS net
       FROM aspect.fin_ledger l
       JOIN aspect.fin_accounts a USING (account_code)
       JOIN aspect.fin_sections s USING (section_code)
      WHERE l.month BETWEEN $1 AND $2 ${storeFilter}
      GROUP BY 1 ORDER BY 1`,
    params
  );
  const out = rows.map(r => {
    const gp = r.rev - r.cogs, op = gp - r.opex;
    return [periodLabel(r.ym, r.ym), fmtNum(r.rev), fmtNum(gp), fmtPct(gp, r.rev), fmtNum(r.opex), fmtNum(op), fmtPct(op, r.rev), fmtNum(r.net), fmtPct(r.net, r.rev)];
  });
  return {
    title: `מגמה חודשית - 12 חודשים${branch ? ` - סניף ${branch.name_he}` : ''}`,
    columns: ['חודש', 'הכנסות (₪)', 'רווח גולמי (₪)', '% גולמי', 'הוצאות תפעול והנהלה (₪)', 'רווח תפעולי (₪)', '% תפעולי', 'רווח לפני מס (₪)', '% נקי'],
    rows: out,
    highlights: {
      best_month: rows.length ? periodLabel(rows.reduce((m, r) => (r.net > m.net ? r : m)).ym, rows.reduce((m, r) => (r.net > m.net ? r : m)).ym) : null,
      worst_month: rows.length ? periodLabel(rows.reduce((m, r) => (r.net < m.net ? r : m)).ym, rows.reduce((m, r) => (r.net < m.net ? r : m)).ym) : null,
    },
  };
}

/**
 * The crew tool's entry point.
 * @returns {Promise<Object>} { success, title, periods, report_markdown, highlights } or { success:false, ... }
 */
async function getFinanceReport(params = {}, pool = getPool()) {
  const report = REPORTS.includes(params.report) ? params.report : 'pnl';
  const range = await ledgerRange(pool);
  if (!range?.last) return { success: false, error: 'no_ledger', message: 'The finance ledger is empty.' };

  const { a, b } = resolvePeriods({ preset: PRESETS.includes(params.preset) ? params.preset : 'last_month_vs_last_year', ...params }, range.first, range.last);

  let branch = null;
  if (params.branch && report !== 'branch_profitability') {
    branch = await findBranch(pool, params.branch);
    if (branch?.notFound) {
      const { rows } = await pool.query(`SELECT name_he FROM aspect.stores ORDER BY store_id`);
      return { success: false, error: 'branch_not_found', message: `No branch matches "${branch.notFound}".`, branches: rows.map(r => r.name_he) };
    }
  }

  let r;
  if (report === 'line_by_branch') r = await lineByBranch(pool, a, b, params.line);
  else if (report === 'branch_profitability') r = await branchProfitability(pool, a, b);
  else if (report === 'monthly_trend') r = await monthlyTrend(pool, a, branch);
  else r = await pnl(pool, a, b, branch);
  if (r.error) return { success: false, ...r };

  return {
    success: true,
    title: r.title,
    periods: { a: a.label, b: b.label, data_closed_through: periodLabel(range.last, range.last) },
    report_markdown: `**${r.title}**\n\n${markdownTable(r.columns, r.rows)}`,
    highlights: r.highlights,
  };
}

module.exports = { getFinanceReport, resolvePeriods, PRESETS, REPORTS };
