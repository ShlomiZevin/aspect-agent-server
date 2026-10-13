/**
 * Hard checks for the Aspect demo finance data and reports (task #112).
 *
 * Part A - the data ties out, every month and every branch, no sampling:
 *   ledger revenue / cost of sales = the sales table; opening stock = last
 *   month's closing stock; every balance sheet balances; balance-sheet stock =
 *   the ledger's closing stock; accumulated depreciation and retained earnings
 *   move by exactly the P&L depreciation and profit.
 * Part B - the reports agree with each other across every preset and many
 *   custom periods: P&L arithmetic, branch splits = P&L lines, the trend = the
 *   monthly P&Ls, cash flow = P&L + balance sheet, well-formed tables,
 *   determinism, error paths.
 *
 * Needs the Cloud SQL proxy to aspect-data-db on 5433 (.env ZER4U_DB_*).
 *   node scripts/test-aspect-finance.js
 */

require('dotenv').config({ quiet: true });
const { getPool } = require('../services/db.aspect');
const { getFinanceReport, PRESETS } = require('../agents/aspect/finance-reports');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
}

// ── table parsing ──────────────────────────────────────────────────────────
const num = s => {
  const t = String(s ?? '').replace(/\*\*/g, '').replace(/,/g, '').replace('%', '').trim();
  return t === '' ? null : Number(t);
};
function parseTable(md) {
  const lines = md.split('\n').filter(l => l.startsWith('|'));
  const split = l => l.slice(1, -1).split('|').map(c => c.trim());
  const header = split(lines[0]);
  const rows = lines.slice(2).map(split);
  return { header, rows, byLabel: new Map(rows.map(r => [r[0].replace(/\*\*/g, ''), r])) };
}
function wellFormed(name, md) {
  const { header, rows } = parseTable(md);
  check(`${name}: unique column names`, new Set(header).size === header.length, header.join(' | '));
  check(`${name}: every row has ${header.length} cells`, rows.every(r => r.length === header.length));
  check(`${name}: no NaN/undefined/Infinity/null`, !/NaN|undefined|Infinity|null/.test(md));
  check(`${name}: has rows`, rows.length > 0);
}

async function partA(pool) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const M = (await q('SELECT COUNT(DISTINCT month)::int AS n FROM aspect.fin_ledger'))[0].n;
  const S = (await q('SELECT COUNT(*)::int AS n FROM aspect.stores'))[0].n;

  const rev = await q(`
    WITH s AS (SELECT date_trunc('month', sale_date)::date AS m, store_id, SUM(qty*unit_price) AS rev, SUM(qty*unit_cost) AS cogs
                 FROM aspect.sales GROUP BY 1, 2),
         l AS (SELECT month AS m, store_id,
                      SUM(amount) FILTER (WHERE account_code = 1010) AS rev,
                      SUM(amount) FILTER (WHERE account_code IN (2010, 2020, 2030)) AS cogs
                 FROM aspect.fin_ledger WHERE store_id IS NOT NULL GROUP BY 1, 2)
    SELECT l.m::text, l.store_id, l.rev::float AS l_rev, s.rev::float AS s_rev, l.cogs::float AS l_cogs, s.cogs::float AS s_cogs
      FROM l LEFT JOIN s USING (m, store_id)`);
  check('A1 ledger has every store-month', rev.length === S * M, `got ${rev.length}, want ${S * M}`);
  const badRev = rev.filter(r => r.s_rev == null || Math.abs(r.l_rev - r.s_rev) > 0.5);
  check('A2 ledger revenue = sales revenue, every store-month', badRev.length === 0, JSON.stringify(badRev.slice(0, 3)));
  const badCogs = rev.filter(r => r.s_cogs == null || Math.abs(r.l_cogs - r.s_cogs) > 2);
  check('A3 ledger cost of sales = sales cost, every store-month', badCogs.length === 0, JSON.stringify(badCogs.slice(0, 3)));

  const roll = await q(`
    SELECT o.month::text, o.store_id, o.amount::float AS opening, -c.amount::float AS prev_closing
      FROM aspect.fin_ledger o
      JOIN aspect.fin_ledger c ON c.store_id = o.store_id AND c.account_code = 2030 AND c.month = (o.month - interval '1 month')
     WHERE o.account_code = 2010`);
  check('A4 opening-stock pairs found', roll.length === S * (M - 1), `got ${roll.length}`);
  check('A5 opening stock = previous closing stock, every store-month', roll.every(r => r.opening === r.prev_closing),
    JSON.stringify(roll.filter(r => r.opening !== r.prev_closing).slice(0, 3)));

  const bs = await q(`
    SELECT b.month::text,
           SUM(b.amount) FILTER (WHERE l.side = 'asset')::float AS assets,
           SUM(b.amount) FILTER (WHERE l.side <> 'asset')::float AS le,
           MAX(b.amount) FILTER (WHERE b.line_code = 1101)::float AS cash,
           MAX(b.amount) FILTER (WHERE b.line_code = 1103)::float AS inventory,
           MAX(b.amount) FILTER (WHERE b.line_code = 1202)::float AS accum_dep,
           MAX(b.amount) FILTER (WHERE b.line_code = 3102)::float AS retained
      FROM aspect.fin_balances b JOIN aspect.fin_bs_lines l USING (line_code)
     GROUP BY b.month ORDER BY b.month`);
  check('A6 balance snapshots = every month + opening', bs.length === M + 1, `got ${bs.length}`);
  check('A7 every balance sheet balances', bs.every(r => r.assets === r.le), JSON.stringify(bs.filter(r => r.assets !== r.le).slice(0, 2)));
  check('A8 cash never negative', bs.every(r => r.cash > 0), JSON.stringify(bs.filter(r => r.cash <= 0).slice(0, 2)));

  const led = await q(`
    SELECT l.month::text,
           (-SUM(l.amount) FILTER (WHERE l.account_code = 2030))::float AS closing,
           SUM(l.amount) FILTER (WHERE l.account_code = 6010)::float AS dep,
           SUM(l.amount * s.sign)::float AS profit
      FROM aspect.fin_ledger l JOIN aspect.fin_accounts a USING (account_code) JOIN aspect.fin_sections s USING (section_code)
     GROUP BY l.month ORDER BY l.month`);
  const bsBy = new Map(bs.map(r => [r.month, r]));
  const prevOf = m => { const d = new Date(`${m}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); };
  let invOk = 0, depOk = 0, reOk = 0;
  for (const m of led) {
    const cur = bsBy.get(m.month), prev = bsBy.get(prevOf(m.month));
    if (cur && cur.inventory === m.closing) invOk++;
    if (cur && prev && prev.accum_dep - cur.accum_dep === m.dep) depOk++;
    if (cur && prev && cur.retained - prev.retained === m.profit) reOk++;
  }
  check('A9 balance-sheet stock = ledger closing stock, every month', invOk === led.length, `${invOk}/${led.length}`);
  check('A10 accumulated depreciation moves by P&L depreciation, every month', depOk === led.length, `${depOk}/${led.length}`);
  check('A11 retained earnings move by P&L profit, every month', reOk === led.length, `${reOk}/${led.length}`);

  const nulls = await q(`SELECT COUNT(*)::int AS n FROM aspect.fin_ledger WHERE amount IS NULL OR month IS NULL`);
  check('A12 no NULL ledger rows', nulls[0].n === 0);
}

async function partB(pool) {
  const R = p => getFinanceReport(p, pool);
  const presets = PRESETS.filter(p => p !== 'custom');
  const customs = [
    ['2026-01', '2026-01'], ['2026-02', '2026-04'], ['2025-06', '2025-06'], ['2025-11', '2025-11'],
    ['2026-07', '2026-09'], ['2025-01', '2025-12'], ['2025-08', '2025-08'], ['2026-09', '2026-09'],
  ].map(([f, t]) => ({ preset: 'custom', a_from: f, a_to: t }));
  // Explicit comparison periods, not a year apart.
  customs.push({ preset: 'custom', a_from: '2026-09', a_to: '2026-09', b_from: '2026-06', b_to: '2026-06' });
  customs.push({ preset: 'custom', a_from: '2026-04', a_to: '2026-06', b_from: '2026-01', b_to: '2026-03' });
  const periods = [...presets.map(p => ({ preset: p })), ...customs];

  for (const per of periods) {
    const tag = JSON.stringify(per);
    const pnl = await R({ report: 'pnl', ...per });
    check(`B pnl ok ${tag}`, pnl.success, JSON.stringify(pnl).slice(0, 200));
    if (!pnl.success) continue;
    wellFormed(`pnl ${tag}`, pnl.report_markdown);
    const t = parseTable(pnl.report_markdown).byLabel;
    for (const col of [1, 3]) {
      const v = l => num(t.get(l)?.[col]);
      const rev = v('הכנסות ממכירות בארץ');
      const cogs = v('סה"כ עלות מכר'), gp = v('רווח גולמי');
      const opex = v('סה"כ הוצאות תפעול'), ga = v('סה"כ הוצאות הנהלה וכלליות'), op = v('רווח תפעולי');
      const fin = v('סה"כ מימון'), dep = v('הוצאות פחת'), oth = v('הכנסות אחרות'), pbt = v('רווח (הפסד) לפני מס');
      check(`B1 gross = revenue - cost of sales ${tag} col${col}`, Math.abs(rev - cogs - gp) <= 1, `${rev}-${cogs}!=${gp}`);
      check(`B2 operating = gross - opex - G&A ${tag} col${col}`, Math.abs(gp - opex - ga - op) <= 1);
      check(`B3 PBT = operating - financing - depreciation + other ${tag} col${col}`, Math.abs(op - fin - dep + oth - pbt) <= 1);
      const stock = v('מלאי פתיחה') + v('קניות') + v('מלאי סגירה');
      check(`B4 opening + purchases - closing = cost of sales ${tag} col${col}`, Math.abs(stock - cogs) <= 1);
      check(`B5 revenue % is 100% ${tag} col${col}`, num(t.get('הכנסות ממכירות בארץ')?.[col + 1]) === 100);
    }
    const gap = num(t.get('הכנסות ממכירות בארץ')[5]);
    check(`B6 gap = A - B ${tag}`, gap === num(t.get('הכנסות ממכירות בארץ')[1]) - num(t.get('הכנסות ממכירות בארץ')[3]));

    // Branch splits must add up to the P&L line.
    for (const line of ['דמי ניהול', 'שכר דירה', 'הוצאות שכר', 'הוצאות תפעול', 'הכנסות ממכירות בארץ']) {
      const lb = await R({ report: 'line_by_branch', line, ...per });
      check(`B7 line_by_branch ok ${line} ${tag}`, lb.success);
      if (!lb.success) continue;
      wellFormed(`line_by_branch ${line} ${tag}`, lb.report_markdown);
      const total = parseTable(lb.report_markdown).byLabel.get('סה"כ');
      const pnlLabel = line === 'הוצאות תפעול' ? 'סה"כ הוצאות תפעול' : line;
      check(`B8 branch split total = P&L "${line}" A ${tag}`, num(total[1]) === num(t.get(pnlLabel)[1]), `${total[1]} vs ${t.get(pnlLabel)[1]}`);
      check(`B9 branch split total = P&L "${line}" B ${tag}`, num(total[3]) === num(t.get(pnlLabel)[3]));
    }

    const bp = await R({ report: 'branch_profitability', ...per });
    check(`B10 branch_profitability ok ${tag}`, bp.success);
    if (bp.success) {
      wellFormed(`branch_profitability ${tag}`, bp.report_markdown);
      const tot = parseTable(bp.report_markdown).byLabel.get('סה"כ סניפים');
      check(`B11 branch revenue total = P&L revenue ${tag}`, num(tot[1]) === num(t.get('הכנסות ממכירות בארץ')[1]));
      check(`B12 branch gross total = P&L gross ${tag}`, Math.abs(num(tot[2]) - num(t.get('רווח גולמי')[1])) <= 1);
      check(`B13 branch opex total = P&L opex ${tag}`, num(tot[3]) === num(t.get('סה"כ הוצאות תפעול')[1]));
    }

    const cf = await R({ report: 'cash_flow', ...per });
    check(`B14 cash_flow ok ${tag}`, cf.success, JSON.stringify(cf).slice(0, 200));
    const bsr = await R({ report: 'balance_sheet', ...per });
    check(`B15 balance_sheet ok ${tag}`, bsr.success, JSON.stringify(bsr).slice(0, 200));
    if (cf.success && bsr.success) {
      wellFormed(`cash_flow ${tag}`, cf.report_markdown);
      wellFormed(`balance_sheet ${tag}`, bsr.report_markdown);
      const c = parseTable(cf.report_markdown).byLabel;
      const b = parseTable(bsr.report_markdown).byLabel;
      for (const col of [1, 2]) {
        const pc = col === 1 ? 1 : 3;
        check(`B16 cash-flow profit = P&L PBT ${tag} col${col}`, num(c.get('רווח (הפסד) לפני מס')[col]) === num(t.get('רווח (הפסד) לפני מס')[pc]));
        check(`B17 cash-flow depreciation = P&L depreciation ${tag} col${col}`, num(c.get('פחת')[col]) === num(t.get('הוצאות פחת')[pc]));
        const open = num(c.get('יתרת מזומנים לתחילת התקופה')[col]), chg = num(c.get('שינוי במזומנים')[col]), close = num(c.get('יתרת מזומנים לסוף התקופה')[col]);
        check(`B18 opening cash + change = closing cash ${tag} col${col}`, Math.abs(open + chg - close) <= 1);
        check(`B19 cash-flow closing cash = balance-sheet cash ${tag} col${col}`, close === num(b.get('מזומנים ושווי מזומנים')[col === 1 ? 1 : 3]));
        const ops = ['רווח (הפסד) לפני מס', 'פחת', 'שינוי במלאי', 'שינוי בלקוחות', 'שינוי בספקים ונותני שירותים', 'שינוי בזכאים ויתרות זכות'];
        check(`B20 operating = sum of its lines ${tag} col${col}`, Math.abs(ops.reduce((s, l) => s + num(c.get(l)[col]), 0) - num(c.get('מזומנים נטו מפעילות שוטפת')[col])) <= 2);
      }
      check(`B21 total assets = liabilities + equity ${tag}`, num(b.get('סה"כ נכסים')[1]) === num(b.get('סה"כ התחייבויות והון עצמי')[1]) && num(b.get('סה"כ נכסים')[3]) === num(b.get('סה"כ התחייבויות והון עצמי')[3]));
      check(`B22 balance-sheet stock = P&L closing stock ${tag}`, num(b.get('מלאי')[1]) === -num(t.get('מלאי סגירה')[1]));
    }

    // Determinism.
    const again = await R({ report: 'pnl', ...per });
    check(`B23 same call, same table ${tag}`, again.report_markdown === pnl.report_markdown);
  }

  // The 12-month trend matches the single-month P&Ls.
  const tr = await R({ report: 'monthly_trend' });
  check('B24 trend ok', tr.success);
  if (tr.success) {
    wellFormed('trend', tr.report_markdown);
    const rows = parseTable(tr.report_markdown).rows;
    check('B25 trend has 12 months', rows.length === 12, `got ${rows.length}`);
    const last = (await R({ report: 'pnl' })).periods.data_closed_through;
    check('B26 trend ends at the last closed month', rows[rows.length - 1][0] === last, `${rows[rows.length - 1][0]} vs ${last}`);
    let i = 0;
    for (const r of rows) {
      // Walk back from the last closed month.
      const months = rows.length - 1 - i++;
      const { first, last: lastYm } = (await pool.query(`SELECT to_char(MAX(month), 'YYYY-MM') AS last, to_char(MIN(month), 'YYYY-MM') AS first FROM aspect.fin_ledger`)).rows[0];
      const idx = Number(lastYm.slice(0, 4)) * 12 + Number(lastYm.slice(5, 7)) - 1 - months;
      const ym = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
      const p = parseTable((await R({ report: 'pnl', preset: 'custom', a_from: ym, a_to: ym })).report_markdown).byLabel;
      check(`B27 trend revenue = P&L revenue ${ym}`, num(r[1]) === num(p.get('הכנסות ממכירות בארץ')[1]));
      check(`B28 trend PBT = P&L PBT ${ym}`, num(r[7]) === num(p.get('רווח (הפסד) לפני מס')[1]));
      void first;
    }
  }

  // Year to date = the sum of its months.
  const ytd = await R({ report: 'pnl', preset: 'ytd_vs_last_ytd' });
  const ytdRev = num(parseTable(ytd.report_markdown).byLabel.get('הכנסות ממכירות בארץ')[1]);
  const lastYm = (await pool.query(`SELECT to_char(MAX(month), 'YYYY-MM') AS m FROM aspect.fin_ledger`)).rows[0].m;
  let sum = 0;
  for (let m = 1; m <= Number(lastYm.slice(5, 7)); m++) {
    const ym = `${lastYm.slice(0, 4)}-${String(m).padStart(2, '0')}`;
    sum += num(parseTable((await R({ report: 'pnl', preset: 'custom', a_from: ym, a_to: ym })).report_markdown).byLabel.get('הכנסות ממכירות בארץ')[1]);
  }
  check('B29 YTD revenue = sum of monthly revenue', sum === ytdRev, `${sum} vs ${ytdRev}`);

  // Branch P&L adds up to the chain on store-level lines.
  const chain = parseTable((await R({ report: 'pnl' })).report_markdown).byLabel;
  const { rows: stores } = await pool.query(`SELECT name_he FROM aspect.stores`);
  let branchRev = 0;
  for (const s of stores) {
    const r = await R({ report: 'pnl', branch: s.name_he });
    check(`B30 branch P&L ok ${s.name_he}`, r.success && r.title.includes(s.name_he), r.title || JSON.stringify(r).slice(0, 120));
    if (r.success) branchRev += num(parseTable(r.report_markdown).byLabel.get('הכנסות ממכירות בארץ')[1]);
  }
  check('B31 sum of branch P&L revenue = chain revenue', branchRev === num(chain.get('הכנסות ממכירות בארץ')[1]), `${branchRev}`);

  // Error paths.
  const badBranch = await R({ report: 'pnl', branch: 'גבעתיים' });
  check('B32 unknown branch is refused with the branch list', !badBranch.success && badBranch.error === 'branch_not_found' && badBranch.branches.length === 29);
  const badLine = await R({ report: 'line_by_branch', line: 'משכורות' });
  check('B33 unknown line is refused with the line list', !badLine.success && badLine.error === 'line_not_found' && badLine.available_lines.length > 0);
  const future = await R({ report: 'pnl', preset: 'custom', a_from: '2027-03', a_to: '2027-03' });
  check('B34 a future month clamps to the last closed month', future.success && future.periods.a === future.periods.data_closed_through);
  // The model passes B explicitly; B must move with A (live bug: "Sep 2026 vs Oct 2025").
  const octVsOct = await R({ report: 'pnl', preset: 'custom', a_from: '2026-10', a_to: '2026-10', b_from: '2025-10', b_to: '2025-10' });
  check('B39 unclosed month: A and B shift together (same month a year apart)', octVsOct.success && octVsOct.periods.a === 'ספטמבר 2026' && octVsOct.periods.b === 'ספטמבר 2025', JSON.stringify(octVsOct.periods));
  check('B40 unclosed month: a notice tells the model', octVsOct.success && /closed through/.test(octVsOct.notice || ''));
  const partly = await R({ report: 'pnl', preset: 'custom', a_from: '2026-07', a_to: '2026-12' });
  check('B41 partly-future range: A cut to the closed months, B the same length', partly.success && partly.periods.a === 'יולי-ספטמבר 2026' && partly.periods.b === 'יולי-ספטמבר 2025', JSON.stringify(partly.periods));
  const normal = await R({ report: 'pnl', preset: 'custom', a_from: '2026-03', a_to: '2026-03' });
  check('B42 a closed period carries no notice', normal.success && !normal.notice);
  const bsNet = parseTable((await R({ report: 'balance_sheet' })).report_markdown).byLabel;
  check('B43 fixed assets: cost - accumulated depreciation = net total',
    num(bsNet.get('רכוש קבוע בעלות')[1]) - num(bsNet.get('בניכוי: פחת שנצבר')[1]) === num(bsNet.get('סה"כ רכוש קבוע, נטו')[1]));
  // Period columns (amount + % for A and B) never negative - the cell the model dropped.
  const bsRows = parseTable((await R({ report: 'balance_sheet' })).report_markdown).rows;
  check('B44 no negative amount/% in the balance sheet period columns', bsRows.every(r => [1, 2, 3, 4].every(c => !String(r[c]).replace(/\*\*/g, '').startsWith('-'))),
    JSON.stringify(bsRows.filter(r => [1, 2, 3, 4].some(c => String(r[c]).replace(/\*\*/g, '').startsWith('-')))));
  const junk = await R({ report: 'nonsense', preset: 'nonsense' });
  check('B35 unknown report/preset falls back to the default P&L', junk.success && junk.title.startsWith('דוח רווח והפסד'));
  for (const report of ['pnl', 'balance_sheet', 'cash_flow', 'line_by_branch']) {
    const firstYm = (await pool.query("SELECT to_char(MIN(month), 'YYYY-MM') AS m FROM aspect.fin_ledger")).rows[0].m;
    const first = await R({ report, line: 'דמי ניהול', preset: 'custom', a_from: firstYm, a_to: firstYm });
    check(`B36 ${report}: first month has no comparison period -> refused, not a duplicate column`, !first.success && first.error === 'no_comparison_period', JSON.stringify(first).slice(0, 160));
  }
  const same = await R({ report: 'pnl', preset: 'custom', a_from: '2026-05', a_to: '2026-05', b_from: '2026-05', b_to: '2026-05' });
  check('B37 identical A and B are refused', !same.success && same.error === 'same_periods');
  const explicitB = await R({ report: 'pnl', preset: 'custom', a_from: '2026-09', b_from: '2026-06' });
  check('B38 explicit B month is honoured', explicitB.success && explicitB.periods.b === 'יוני 2026', JSON.stringify(explicitB.periods));
}

(async () => {
  const pool = getPool();
  const t0 = Date.now();
  await partA(pool);
  await partB(pool);
  console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const f of failures.slice(0, 40)) console.log('  FAIL ' + f);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
