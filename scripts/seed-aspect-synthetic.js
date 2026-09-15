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
 * Usage (through the Cloud SQL Proxy, customer-data DB — port 5433):
 *   node scripts/seed-aspect-synthetic.js
 */

require('dotenv').config();
const { getPool } = require('../services/db.zer4u');

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
const STORES = [];
for (let i = 1; i <= 28; i++) {
  STORES.push({ store_id: i, name: `TechZone ${CITIES[(i - 1) % CITIES.length]} ${Math.floor((i - 1) / CITIES.length) + 1}`, city: CITIES[(i - 1) % CITIES.length], format: i <= 4 ? 'flagship' : 'standard', is_online: false });
}
STORES.push({ store_id: 0, name: 'TechZone Online', city: null, format: 'online', is_online: true });

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

// ── Sales: 14 months of history with seasonality ───────────────────────────
// Ends "today" (server clock) so recency-window questions ("last N weeks")
// have real rows to answer against, same expectation dataThroughDate serves
// for the real clients.
const END_DATE = new Date();
const START_DATE = new Date(END_DATE);
START_DATE.setMonth(START_DATE.getMonth() - 14);

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
function* generateSales() {
  for (let d = new Date(START_DATE); d <= END_DATE; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const seasonality = seasonalityMultiplier(d);
    for (const store of STORES) {
      const storeWeight = store.is_online ? 1.4 : (store.format === 'flagship' ? 1.8 : 1.0);
      const txnCount = Math.max(0, Math.round(BASE_TRANSACTIONS_PER_STORE_DAY * storeWeight * seasonality * randFloat(0.75, 1.25)));
      for (let t = 0; t < txnCount; t++) {
        const transactionId = `TXN${txnSeq++}`;
        const anchor = pick(NON_ACCESSORY_PRODUCTS);
        const lines = [{ product: anchor, qty: 1 }];
        // Attach rate 60-75% (target per AGENT.md) — roll per transaction.
        if (rand() < 0.68) lines.push({ product: pick(ACCESSORY_PRODUCTS), qty: randInt(1, 2) });
        // Extended warranty attach 25-40%.
        if (rand() < 0.32) lines.push({ product: pick(WARRANTY_PRODUCTS), qty: 1 });
        for (const line of lines) {
          yield {
            sale_date: date,
            store_id: store.store_id,
            sku: line.product.sku,
            transaction_id: transactionId,
            qty: line.qty,
            unit_price: line.product.price,
            unit_cost: line.product.cost,
          };
        }
      }
    }
  }
}

const DDL = `
DROP SCHEMA IF EXISTS aspect CASCADE;
CREATE SCHEMA aspect;

CREATE TABLE aspect.stores (
  store_id  INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  city      TEXT,
  format    TEXT NOT NULL,
  is_online BOOLEAN NOT NULL DEFAULT false
);

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

async function main() {
  const pool = getPool();

  console.log('[seed-aspect] creating schema...');
  await pool.query(DDL);

  console.log(`[seed-aspect] inserting ${STORES.length} stores...`);
  await insertBatch(pool, 'stores', ['store_id', 'name', 'city', 'format', 'is_online'], STORES);

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

  // Without this the planner works off the pre-load (empty-table) row
  // estimates until autovacuum gets around to it — a plain category/month
  // aggregate over the full table took 39s on stale stats vs. 0.5s after.
  console.log('[seed-aspect] running ANALYZE...');
  await pool.query('ANALYZE aspect.sales; ANALYZE aspect.products; ANALYZE aspect.stores;');

  const revCheck = await pool.query(`
    SELECT to_char(sale_date, 'YYYY-MM') AS month, ROUND(SUM(qty * unit_price)) AS revenue
    FROM aspect.sales GROUP BY 1 ORDER BY 1 DESC LIMIT 6
  `);
  console.log('[seed-aspect] last 6 months revenue (sanity check):');
  console.table(revCheck.rows);

  await pool.end();
}

main().catch((err) => {
  console.error('[seed-aspect] FAILED:', err);
  process.exit(1);
});
