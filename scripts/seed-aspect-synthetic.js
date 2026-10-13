/**
 * One-off generator for the Aspect demo agent's Intelligence dataset —
 * task #73 ("Make the Intelligence Center work for our demo agent, Aspect").
 *
 * Unlike every other dataset (zer4u, hypertoy, superhist, ...), "aspect" has
 * no real client feed: the demo agent's Technology/FMCG/Fashion crews answer
 * purely from prompt text (see agents/aspect/AGENT.md), there is nothing to
 * import from GCS. This script instead CREATEs the `aspect` schema and fills
 * it with synthetic data for the Technology vertical only (TechZone — 28
 * branches, ~8,000 SKUs, ~120M NIS/month, per AGENT.md), so numbers roughly
 * match what the chat crew already narrates about the same fictional
 * business. FMCG and Fashion are out of scope for this pass (see task
 * discussion — one vertical to start).
 *
 * Safe to re-run: DROPs and recreates the schema each time (same pattern as
 * scripts/create-superhist-schema.js), so tuning the generator doesn't leave
 * stale rows behind.
 *
 * Finance (task #112, 2026-10-13): a P&L ledger for the demo, so the
 * Intelligence Center chat can show financial statements from data instead of
 * inventing them per request. It is DERIVED from the generated sales —
 * revenue and cost of sales are the sales lines' own sums — and the rest
 * (stock, purchases, operating / G&A expenses, financing, depreciation, other
 * income) is generated per branch per month on top. Line names are Hebrew and
 * follow the client's Qlik finance model (task #112 screenshots). Only CLOSED
 * months are booked; the current month is still open.
 *
 * Usage (through the Cloud SQL Proxy, customer-data DB — port 5433):
 *   node scripts/seed-aspect-synthetic.js
 *   node scripts/seed-aspect-synthetic.js --dry   # generate only, print the P&L, no DB
 */

require('dotenv').config();
const DRY_RUN = process.argv.includes('--dry');
const { getPool } = DRY_RUN ? { getPool: null } : require('../services/db.zer4u');

// Deterministic PRNG (mulberry32) so re-runs produce the same data — makes
// diffing/debugging the generator sane instead of chasing a moving target.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260915);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const randFloat = (min, max) => min + rand() * (max - min);

// ── Stores: 28 physical branches + one online channel ──────────────────────
const CITIES = ['Tel Aviv', 'Jerusalem', 'Haifa', 'Rishon LeZion', 'Petah Tikva', 'Ashdod', 'Netanya', 'Beer Sheva', 'Holon', 'Bnei Brak', 'Ramat Gan', 'Bat Yam', 'Rehovot', 'Herzliya', 'Kfar Saba', 'Modiin', 'Ashkelon', 'Nahariya', 'Eilat', 'Tiberias'];
// Hebrew branch names for the finance reports (task #112 — Hebrew only), same order as CITIES.
const CITIES_HE = ['תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'אשדוד', 'נתניה', 'באר שבע', 'חולון', 'בני ברק', 'רמת גן', 'בת ים', 'רחובות', 'הרצליה', 'כפר סבא', 'מודיעין', 'אשקלון', 'נהריה', 'אילת', 'טבריה'];
const STORES = [];
for (let i = 1; i <= 28; i++) {
  const c = (i - 1) % CITIES.length;
  const n = Math.floor((i - 1) / CITIES.length) + 1;
  STORES.push({ store_id: i, name: `TechZone ${CITIES[c]} ${n}`, name_he: n > 1 ? `${CITIES_HE[c]} ${n}` : CITIES_HE[c], city: CITIES[c], format: i <= 4 ? 'flagship' : 'standard', is_online: false });
}
STORES.push({ store_id: 0, name: 'TechZone Online', name_he: 'אונליין', city: null, format: 'online', is_online: true });

// ── Products: ~8,000 SKUs across categories, priced by band ────────────────
const CATEGORIES = [
  { name: 'Smartphones', share: 0.14, priceMin: 1200, priceMax: 8500, marginPct: [0.10, 0.18], accessory: false, warranty: false },
  { name: 'Laptops', share: 0.10, priceMin: 2500, priceMax: 13000, marginPct: [0.12, 0.20], accessory: false, warranty: false },
  { name: 'Tablets', share: 0.08, priceMin: 900, priceMax: 5500, marginPct: [0.12, 0.20], accessory: false, warranty: false },
  { name: 'TVs', share: 0.09, priceMin: 1500, priceMax: 16000, marginPct: [0.10, 0.16], accessory: false, warranty: false },
  { name: 'Audio', share: 0.10, priceMin: 150, priceMax: 3500, marginPct: [0.20, 0.35], accessory: false, warranty: false },
  { name: 'Gaming', share: 0.09, priceMin: 200, priceMax: 3800, marginPct: [0.15, 0.25], accessory: false, warranty: false },
  { name: 'Smart Home', share: 0.07, priceMin: 150, priceMax: 2200, marginPct: [0.20, 0.32], accessory: false, warranty: false },
  { name: 'Wearables', share: 0.06, priceMin: 300, priceMax: 3200, marginPct: [0.15, 0.25], accessory: false, warranty: false },
  { name: 'Accessories', share: 0.20, priceMin: 30, priceMax: 600, marginPct: [0.35, 0.55], accessory: true, warranty: false },
  { name: 'Extended Warranty', share: 0.07, priceMin: 80, priceMax: 1200, marginPct: [0.55, 0.75], accessory: false, warranty: true },
];
const BRANDS_BY_CATEGORY = {
  Smartphones: ['Apple', 'Samsung', 'Xiaomi', 'Google'],
  Laptops: ['Apple', 'Dell', 'HP', 'Lenovo', 'Asus'],
  Tablets: ['Apple', 'Samsung', 'Lenovo'],
  TVs: ['Samsung', 'LG', 'Sony', 'TCL'],
  Audio: ['Sony', 'JBL', 'Bose', 'Apple'],
  Gaming: ['Sony', 'Microsoft', 'Nintendo', 'Razer'],
  'Smart Home': ['Google', 'Amazon', 'Philips', 'TP-Link'],
  Wearables: ['Apple', 'Samsung', 'Garmin', 'Fitbit'],
  Accessories: ['Belkin', 'Anker', 'Spigen', 'Generic'],
  'Extended Warranty': ['TechZone Care'],
};

const TOTAL_SKUS = 8000;
const PRODUCTS = [];
let skuSeq = 1;
for (const cat of CATEGORIES) {
  const count = Math.round(TOTAL_SKUS * cat.share);
  for (let i = 0; i < count; i++) {
    const brand = pick(BRANDS_BY_CATEGORY[cat.name]);
    const price = Math.round(randFloat(cat.priceMin, cat.priceMax) / 10) * 10;
    const margin = randFloat(cat.marginPct[0], cat.marginPct[1]);
    const cost = Math.round(price * (1 - margin));
    PRODUCTS.push({
      sku: `TZ-${String(skuSeq).padStart(6, '0')}`,
      name: `${brand} ${cat.name.replace(/s$/, '')} ${pick(['Pro', 'Plus', 'Max', 'Lite', 'X', '2', '3', 'Air', ''])}`.trim(),
      category: cat.name,
      brand,
      is_accessory: cat.accessory,
      is_warranty: cat.warranty,
      price,
      cost,
    });
    skuSeq++;
  }
}

// ── Sales: 26 months of history with seasonality ───────────────────────────
// Ends "today" (server clock) so recency-window questions ("last N weeks")
// have real rows to answer against, same expectation dataThroughDate serves
// for the real clients. 26 months (was 14) so the finance reports can compare
// year-to-date against the previous year's same months (task #112).
const END_DATE = new Date();
END_DATE.setHours(12, 0, 0, 0); // midday, so toISOString() never slips a day across UTC
const START_DATE = new Date(END_DATE);
START_DATE.setMonth(START_DATE.getMonth() - 26);
START_DATE.setDate(1); // whole first month, so it can be booked in the ledger

/** Seasonality multiplier for a given date — iPhone launch (Sep), back-to-
 *  school (Aug-Sep), Black Friday (late Nov), per agents/aspect/AGENT.md. */
function seasonalityMultiplier(date) {
  const month = date.getMonth(); // 0-indexed
  const day = date.getDate();
  let mult = 1.0;
  if (month === 7) mult *= 1.15; // August: back-to-school ramp
  if (month === 8) mult *= 1.45; // September: iPhone launch + back-to-school peak
  if (month === 10 && day >= 20) mult *= 1.9; // Black Friday week
  const dow = date.getDay(); // 0=Sun..6=Sat — Israeli weekend is Fri/Sat, Thu-Fri lighter retail peak
  if (dow === 5) mult *= 1.25; // Friday
  if (dow === 6) mult *= 0.55; // Saturday (mostly closed)
  return mult;
}

const NON_ACCESSORY_PRODUCTS = PRODUCTS.filter(p => !p.is_accessory && !p.is_warranty);
const ACCESSORY_PRODUCTS = PRODUCTS.filter(p => p.is_accessory);
const WARRANTY_PRODUCTS = PRODUCTS.filter(p => p.is_warranty);

// Baseline: ~120M NIS/month / 30 days / 28.4 "store-equivalents" (28 stores +
// online counted as ~1.4x a branch) ≈ 140 device-anchored transactions/day
// per store-equivalent at typical basket sizes below. Calibrated empirically
// (5 undershot to ~23M/month — devices + accessory/warranty attach nets a
// lower basket than the naive per-store math suggests).
const BASE_TRANSACTIONS_PER_STORE_DAY = 26;

let txnSeq = 1;
// "YYYY-MM|store_id" -> { revenue, cogs } — the ledger's revenue and cost of
// sales are these sums, so finance and sales answers agree to the shekel.
const SALES_BY_STORE_MONTH = new Map();
function* generateSales() {
  for (let d = new Date(START_DATE); d <= END_DATE; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const seasonality = seasonalityMultiplier(d);
    // ~6% a year of growth, so period comparisons show a real gap (task #112).
    const growth = Math.pow(1.06, (d - START_DATE) / (365.25 * 86400000));
    // Black Friday week sells at 10% off (not the warranty plans), which is
    // what makes November's margin dip instead of every month being identical.
    const blackFriday = d.getMonth() === 10 && d.getDate() >= 20;
    for (const store of STORES) {
      const storeWeight = store.is_online ? 1.4 : (store.format === 'flagship' ? 1.8 : 1.0);
      const txnCount = Math.max(0, Math.round(BASE_TRANSACTIONS_PER_STORE_DAY * storeWeight * seasonality * growth * randFloat(0.75, 1.25)));
      for (let t = 0; t < txnCount; t++) {
        const transactionId = `TXN${txnSeq++}`;
        const anchor = pick(NON_ACCESSORY_PRODUCTS);
        const lines = [{ product: anchor, qty: 1 }];
        // Attach rate 60-75% (target per AGENT.md) — roll per transaction.
        if (rand() < 0.68) lines.push({ product: pick(ACCESSORY_PRODUCTS), qty: randInt(1, 2) });
        // Extended warranty attach 25-40%.
        if (rand() < 0.32) lines.push({ product: pick(WARRANTY_PRODUCTS), qty: 1 });
        for (const line of lines) {
          const unitPrice = blackFriday && !line.product.is_warranty
            ? Math.round(line.product.price * 0.9 * 100) / 100
            : line.product.price;
          const key = `${date.slice(0, 7)}|${store.store_id}`;
          const acc = SALES_BY_STORE_MONTH.get(key) || { revenue: 0, cogs: 0 };
          acc.revenue += line.qty * unitPrice;
          acc.cogs += line.qty * line.product.cost;
          SALES_BY_STORE_MONTH.set(key, acc);
          yield {
            sale_date: date,
            store_id: store.store_id,
            sku: line.product.sku,
            transaction_id: transactionId,
            qty: line.qty,
            unit_price: unitPrice,
            unit_cost: line.product.cost,
          };
        }
      }
    }
  }
}

// ── Finance: chart of accounts (task #112) ─────────────────────────────────
// Sections and lines follow the client's Qlik P&L ("מודל פיננסי") in its
// order. `sign` is how a section enters profit: revenue and other income add,
// everything else subtracts. Amounts are stored as shown in that model:
// expenses positive, and closing stock NEGATIVE inside cost of sales so the
// section sums to opening + purchases - closing.
// `level`: 'store' lines are booked per branch; 'hq' lines on the head office
// (store_id NULL).
const SECTIONS = [
  { code: 'REV', name: 'הכנסות', order: 1, sign: 1 },
  { code: 'COGS', name: 'עלות מכר', order: 2, sign: -1 },
  { code: 'OPEX', name: 'הוצאות תפעול', order: 4, sign: -1 },
  { code: 'GA', name: 'הוצאות הנהלה וכלליות', order: 5, sign: -1 },
  { code: 'FIN', name: 'מימון', order: 7, sign: -1 },
  { code: 'DEP', name: 'פחת', order: 8, sign: -1 },
  { code: 'OTH', name: 'הכנסות אחרות', order: 9, sign: 1 },
];
const ACCOUNTS = [
  { code: 1010, section: 'REV', name: 'הכנסות ממכירות בארץ', level: 'store' },
  { code: 2010, section: 'COGS', name: 'מלאי פתיחה', level: 'store' },
  { code: 2020, section: 'COGS', name: 'קניות', level: 'store' },
  { code: 2030, section: 'COGS', name: 'מלאי סגירה', level: 'store' },
  { code: 3010, section: 'OPEX', name: 'הוצאות שכר', level: 'store' },
  { code: 3020, section: 'OPEX', name: 'שכר דירה', level: 'store' },
  { code: 3030, section: 'OPEX', name: 'דמי ניהול', level: 'store' },
  { code: 3040, section: 'OPEX', name: 'ארנונה ומים', level: 'store' },
  { code: 3050, section: 'OPEX', name: 'הוצאות חשמל', level: 'store' },
  { code: 3060, section: 'OPEX', name: 'הובלות ומשלוחים', level: 'store' },
  { code: 3070, section: 'OPEX', name: 'אחזקת רכב', level: 'store' },
  { code: 3080, section: 'OPEX', name: 'אחזקה', level: 'store' },
  { code: 3090, section: 'OPEX', name: 'הוצאות ניקיון', level: 'store' },
  { code: 3100, section: 'OPEX', name: 'כיבודים', level: 'store' },
  { code: 3110, section: 'OPEX', name: 'עלויות יבוא', level: 'store' },
  { code: 4010, section: 'GA', name: 'שכר הנהלה', level: 'hq' },
  { code: 4020, section: 'GA', name: 'פרסום ושיווק', level: 'hq' },
  { code: 4030, section: 'GA', name: 'מחשוב ותוכנה', level: 'hq' },
  { code: 4040, section: 'GA', name: 'ייעוץ מקצועי', level: 'hq' },
  { code: 4050, section: 'GA', name: 'ביטוחים', level: 'hq' },
  { code: 5010, section: 'FIN', name: 'עמלות כרטיסי אשראי', level: 'store' },
  { code: 5020, section: 'FIN', name: 'ריבית והוצאות בנק', level: 'hq' },
  { code: 6010, section: 'DEP', name: 'הוצאות פחת', level: 'store' },
  { code: 7010, section: 'OTH', name: 'הכנסות אחרות', level: 'hq' },
];

// Its own PRNG, so changing the ledger never reshuffles the sales.
const frand = mulberry32(20261013);
const noise = (spread) => 1 + (frand() * 2 - 1) * spread;

/**
 * Books every CLOSED month (the current one is still open) from the sales
 * totals: revenue and cost of sales exactly, plus generated stock, purchases
 * and expenses per branch. Fixed costs (rent, property tax, depreciation, a
 * base salary) come from each branch's average revenue and rise 3% each
 * January; variable ones follow the month's revenue, so margins move with the
 * season the way a real chain's do.
 * @returns {{month: string, store_id: number|null, account_code: number, amount: number}[]}
 */
function generateLedger() {
  const firstOpen = `${END_DATE.getFullYear()}-${String(END_DATE.getMonth() + 1).padStart(2, '0')}`;
  const months = [...new Set([...SALES_BY_STORE_MONTH.keys()].map(k => k.split('|')[0]))]
    .filter(m => m < firstOpen).sort();
  const rows = [];
  const book = (month, storeId, code, amount) =>
    rows.push({ month: `${month}-01`, store_id: storeId, account_code: code, amount: Math.round(amount) });

  // Per-branch fixed-cost base from its first year's average monthly revenue.
  const base = new Map();
  for (const s of STORES) {
    const firstYear = months.slice(0, 12).map(m => SALES_BY_STORE_MONTH.get(`${m}|${s.store_id}`)?.revenue || 0);
    base.set(s.store_id, firstYear.reduce((a, b) => a + b, 0) / Math.max(1, firstYear.length));
  }
  const yearsIn = (month) => Number(month.slice(0, 4)) - Number(months[0].slice(0, 4));
  const escalate = (month) => Math.pow(1.03, yearsIn(month));

  const closing = new Map(); // store_id -> last closing stock
  for (const month of months) {
    const mm = Number(month.slice(5, 7));
    let chainRevenue = 0;
    for (const s of STORES) {
      const sales = SALES_BY_STORE_MONTH.get(`${month}|${s.store_id}`) || { revenue: 0, cogs: 0 };
      const rev = sales.revenue;
      chainRevenue += rev;
      const b = base.get(s.store_id) * escalate(month);
      const online = s.is_online;
      const flagship = s.format === 'flagship';

      // Revenue, and cost of sales split the way the Qlik model shows it.
      // Stock is held at ~1.2-1.5 months of cost (inventory turn 8-10x/yr).
      book(month, s.store_id, 1010, rev);
      const opening = closing.has(s.store_id) ? closing.get(s.store_id) : sales.cogs * 1.35;
      const close = sales.cogs * (1.2 + frand() * 0.3);
      closing.set(s.store_id, close);
      const purchases = sales.cogs + close - opening;
      book(month, s.store_id, 2010, opening);
      book(month, s.store_id, 2020, purchases);
      book(month, s.store_id, 2030, -close);

      // Operating expenses.
      // Calibrated to an electronics chain: opex ~13-14% of revenue against a
      // ~20% gross margin, so operating profit is a thin ~4% that swings with
      // the season (and goes negative in a weak month for a weak branch).
      book(month, s.store_id, 3010, (b * (online ? 0.025 : 0.033) + rev * 0.022) * noise(0.03));
      book(month, s.store_id, 3020, b * (online ? 0.006 : flagship ? 0.034 : 0.030));
      book(month, s.store_id, 3030, rev * 0.015);
      book(month, s.store_id, 3040, b * (online ? 0.002 : 0.007) * noise(0.02));
      book(month, s.store_id, 3050, b * (online ? 0.003 : 0.0055) * (mm >= 6 && mm <= 9 ? 1.35 : mm === 1 || mm === 2 ? 1.15 : 1) * noise(0.06));
      book(month, s.store_id, 3060, rev * (online ? 0.03 : 0.005) * noise(0.08));
      book(month, s.store_id, 3070, b * (online ? 0.005 : 0.002) * noise(0.15));
      book(month, s.store_id, 3080, b * 0.003 * noise(0.35));
      book(month, s.store_id, 3090, b * (online ? 0.001 : 0.002) * noise(0.05));
      book(month, s.store_id, 3100, b * 0.0005 * noise(0.4));
      book(month, s.store_id, 3110, purchases * 0.011 * noise(0.1));

      // Card fees on every branch's takings; depreciation of its fit-out.
      book(month, s.store_id, 5010, rev * 0.0068 * noise(0.04));
      book(month, s.store_id, 6010, b * (online ? 0.006 : flagship ? 0.013 : 0.011));
    }

    // Head office. Marketing peaks with the season (iPhone launch, Black Friday).
    const hqBase = [...base.values()].reduce((a, b) => a + b, 0) * escalate(month);
    book(month, null, 4010, hqBase * 0.012 * noise(0.02));
    book(month, null, 4020, chainRevenue * 0.007 * (mm === 11 ? 1.9 : mm === 9 ? 1.5 : mm === 8 ? 1.2 : 1) * noise(0.1));
    book(month, null, 4030, hqBase * 0.004 * noise(0.05));
    book(month, null, 4040, hqBase * 0.0015 * noise(0.5));
    book(month, null, 4050, hqBase * 0.0015);
    book(month, null, 5020, hqBase * 0.003 * noise(0.1));
    book(month, null, 7010, chainRevenue * 0.003 * noise(0.3));
  }
  return rows;
}

const DDL = `
DROP SCHEMA IF EXISTS aspect CASCADE;
CREATE SCHEMA aspect;

CREATE TABLE aspect.stores (
  store_id  INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  name_he   TEXT NOT NULL,
  city      TEXT,
  format    TEXT NOT NULL,
  is_online BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE aspect.fin_sections (
  section_code  TEXT PRIMARY KEY,
  section_name  TEXT NOT NULL,
  section_order INTEGER NOT NULL,
  sign          INTEGER NOT NULL
);

CREATE TABLE aspect.fin_accounts (
  account_code INTEGER PRIMARY KEY,
  section_code TEXT NOT NULL REFERENCES aspect.fin_sections(section_code),
  account_name TEXT NOT NULL,
  line_order   INTEGER NOT NULL,
  level        TEXT NOT NULL
);

-- One row per month x branch x account. store_id NULL = head office.
CREATE TABLE aspect.fin_ledger (
  month        DATE NOT NULL,
  store_id     INTEGER REFERENCES aspect.stores(store_id),
  account_code INTEGER NOT NULL REFERENCES aspect.fin_accounts(account_code),
  amount       NUMERIC(14,0) NOT NULL
);
CREATE INDEX idx_aspect_fin_ledger_month ON aspect.fin_ledger(month);

CREATE TABLE aspect.products (
  sku          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  brand        TEXT NOT NULL,
  is_accessory BOOLEAN NOT NULL DEFAULT false,
  is_warranty  BOOLEAN NOT NULL DEFAULT false,
  price        NUMERIC(10,2) NOT NULL,
  cost         NUMERIC(10,2) NOT NULL
);

CREATE TABLE aspect.sales (
  id             BIGSERIAL PRIMARY KEY,
  sale_date      DATE NOT NULL,
  store_id       INTEGER NOT NULL REFERENCES aspect.stores(store_id),
  sku            TEXT NOT NULL REFERENCES aspect.products(sku),
  transaction_id TEXT NOT NULL,
  qty            INTEGER NOT NULL,
  unit_price     NUMERIC(10,2) NOT NULL,
  unit_cost      NUMERIC(10,2) NOT NULL
);

CREATE INDEX idx_aspect_sales_date ON aspect.sales(sale_date);
CREATE INDEX idx_aspect_sales_store ON aspect.sales(store_id);
CREATE INDEX idx_aspect_sales_sku ON aspect.sales(sku);
CREATE INDEX idx_aspect_sales_txn ON aspect.sales(transaction_id);
CREATE INDEX idx_aspect_products_category ON aspect.products(category);
`;

async function insertBatch(pool, table, columns, rows) {
  if (rows.length === 0) return;
  const values = [];
  const params = [];
  let p = 1;
  for (const row of rows) {
    const placeholders = columns.map(() => `$${p++}`);
    values.push(`(${placeholders.join(',')})`);
    for (const col of columns) params.push(row[col]);
  }
  await pool.query(`INSERT INTO aspect.${table} (${columns.join(',')}) VALUES ${values.join(',')}`, params);
}

/** Chain P&L per month as % of revenue — the sanity check for the ledger. */
function printLedgerSummary(ledger) {
  const sectionOf = new Map(ACCOUNTS.map(a => [a.code, a.section]));
  const byMonth = new Map();
  for (const r of ledger) {
    const m = r.month.slice(0, 7);
    const t = byMonth.get(m) || {};
    const sec = sectionOf.get(r.account_code);
    t[sec] = (t[sec] || 0) + r.amount;
    byMonth.set(m, t);
  }
  const pct = (v, rev) => `${(100 * v / rev).toFixed(1)}%`;
  const table = [...byMonth].map(([m, t]) => {
    const gp = t.REV - t.COGS;
    const op = gp - t.OPEX - t.GA;
    const net = op - t.FIN - t.DEP + t.OTH;
    return { month: m, revenue: Math.round(t.REV), gross: pct(gp, t.REV), opex: pct(t.OPEX, t.REV), ga: pct(t.GA, t.REV), operating: pct(op, t.REV), net: pct(net, t.REV) };
  });
  console.table(table);
}

async function main() {
  if (DRY_RUN) {
    let total = 0;
    for (const _ of generateSales()) total++;
    const ledger = generateLedger();
    console.log(`[seed-aspect] DRY RUN: ${total.toLocaleString()} sale lines, ${ledger.length.toLocaleString()} ledger rows`);
    printLedgerSummary(ledger);
    return;
  }

  const pool = getPool();

  console.log('[seed-aspect] creating schema...');
  await pool.query(DDL);

  console.log(`[seed-aspect] inserting ${STORES.length} stores...`);
  await insertBatch(pool, 'stores', ['store_id', 'name', 'name_he', 'city', 'format', 'is_online'], STORES);

  console.log(`[seed-aspect] inserting ${PRODUCTS.length} products...`);
  const PRODUCT_COLUMNS = ['sku', 'name', 'category', 'brand', 'is_accessory', 'is_warranty', 'price', 'cost'];
  for (let i = 0; i < PRODUCTS.length; i += 500) {
    await insertBatch(pool, 'products', PRODUCT_COLUMNS, PRODUCTS.slice(i, i + 500));
  }

  console.log('[seed-aspect] generating and inserting sales (this streams in batches, may take a few minutes)...');
  const SALE_COLUMNS = ['sale_date', 'store_id', 'sku', 'transaction_id', 'qty', 'unit_price', 'unit_cost'];
  let batch = [];
  let total = 0;
  for (const row of generateSales()) {
    batch.push(row);
    if (batch.length >= 2000) {
      await insertBatch(pool, 'sales', SALE_COLUMNS, batch);
      total += batch.length;
      process.stdout.write(`\r[seed-aspect] ${total.toLocaleString()} sale lines inserted...`);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertBatch(pool, 'sales', SALE_COLUMNS, batch);
    total += batch.length;
  }
  console.log(`\n[seed-aspect] done: ${total.toLocaleString()} sale lines.`);

  console.log('[seed-aspect] inserting the finance ledger...');
  await insertBatch(pool, 'fin_sections', ['section_code', 'section_name', 'section_order', 'sign'],
    SECTIONS.map(s => ({ section_code: s.code, section_name: s.name, section_order: s.order, sign: s.sign })));
  await insertBatch(pool, 'fin_accounts', ['account_code', 'section_code', 'account_name', 'line_order', 'level'],
    ACCOUNTS.map((a, i) => ({ account_code: a.code, section_code: a.section, account_name: a.name, line_order: i + 1, level: a.level })));
  const ledger = generateLedger();
  for (let i = 0; i < ledger.length; i += 2000) {
    await insertBatch(pool, 'fin_ledger', ['month', 'store_id', 'account_code', 'amount'], ledger.slice(i, i + 2000));
  }
  console.log(`[seed-aspect] ${ledger.length.toLocaleString()} ledger rows.`);
  printLedgerSummary(ledger);

  // Without this the planner works off the pre-load (empty-table) row
  // estimates until autovacuum gets around to it — a plain category/month
  // aggregate over the full table took 39s on stale stats vs. 0.5s after.
  console.log('[seed-aspect] running ANALYZE...');
  await pool.query('ANALYZE aspect.sales; ANALYZE aspect.products; ANALYZE aspect.stores; ANALYZE aspect.fin_ledger;');

  const revCheck = await pool.query(`
    SELECT to_char(sale_date, 'YYYY-MM') AS month, ROUND(SUM(qty * unit_price)) AS revenue
    FROM aspect.sales GROUP BY 1 ORDER BY 1 DESC LIMIT 6
  `);
  console.log('[seed-aspect] last 6 months revenue (sanity check):');
  console.table(revCheck.rows);

  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed-aspect] FAILED:', err);
    process.exit(1);
  });
}

// For offline tests of agents/aspect/finance-reports.js (a throwaway Postgres
// gets the same DDL and rows without touching the real database).
module.exports = { DDL, STORES, SECTIONS, ACCOUNTS, generateSales, generateLedger };
