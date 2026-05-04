# Task #606 — New Deli Agent Implementation Plan

## Status Legend
- [x] Done
- [ ] TODO — must do before demo
- [~] TODO — can do after demo

---

## Data Loading (run locally via Cloud SQL Proxy on port 5433)

### Step 1 — Create schema
```
node scripts/create-newdeli-schema.js
```
Creates `newdeli` schema + 8 tables in `zer4u_db`.
[x] Script created: `scripts/create-newdeli-schema.js`

### Step 2 — Load data from local CSVs
```
node scripts/load-newdeli-local.js --csv-dir=C:/Users/ziben/Downloads/CSV
```
Streams CSV files directly to PostgreSQL via COPY. ~1.6 GB total.
Estimated time: 5-15 min.
[x] Script created: `scripts/load-newdeli-local.js`

### Step 3 — Create indexes
```
node scripts/create-newdeli-indexes.js
```
Creates 9 indexes + converts tables from UNLOGGED to regular.
[x] Script created: `scripts/create-newdeli-indexes.js`

### Step 4 — Seed agent in main DB
```
node scripts/seed-newdeli-agent.js
```
Inserts `NewDeli` row in `agents` table (requires proxy on port 5432 for main DB).
[x] Script created: `scripts/seed-newdeli-agent.js`

### Step 5 — Generate schema description (for SQL generator)
```
# Via API call after server is running:
curl -X POST http://localhost:3000/api/admin/schema-description/newdeli/generate
```
Or can be called from the admin panel. Enables Claude to understand the newdeli schema.
[ ] Verify this API exists or run manually

---

## Server Side

[x] `services/db.newdeli.js` — re-exports zer4u pool (same DB, newdeli schema)
[x] `agents/newdeli/crew/newdeli.crew.js` — NewDeliCrew with `fetch_newdeli_data` tool
[x] `agents/newdeli/crew/index.js` — exports
[x] `agents/newdeli/data-reload.js` — registers newdeli reloader (disabled by default)
[x] `server.js` — added `require('./agents/newdeli/data-reload').register(dataReloadService)`

### Still TODO:
[ ] `agents/newdeli/AGENT.md` — documentation (can skip for demo)
[ ] Deploy server to Cloud Run (after local test passes)

---

## Client Side

[x] `src/styles/themes/newdeli-theme.css` — dark green (#2c5f2e) + gold (#e5b800)
[x] Update `src/styles/global.css` — added @import
[x] `src/agents/newdeli.config.ts` — agent config with New Deli branding
[x] `src/pages/NewDeliPage.tsx` — page component
[x] `src/agents/index.ts` — export newdeliConfig
[x] `src/pages/index.ts` — export NewDeliPage
[x] `src/App.tsx` — added /newdeli and /newdeli/conversations/:id routes
[x] `src/pages/DashboardPage.tsx` — newdeli added to agentConfigs map
[x] `src/i18n/translations.ts` — quick questions in English + Hebrew
[x] Logo: downloaded to `public/img/newdeli-logo.png` (New Deli rebrand banner)
[ ] Deploy client to Firebase (aspect-agents project) — after data load verified
[ ] Deploy server to Cloud Run — after data load verified

---

## Data Schema Notes (from inspecting actual CSV files)

### Key tables:
- `newdeli.facts` — 3.7M rows, 1.3 GB — all orders
- `newdeli.order_items` — 3.7M rows, 287 MB — items per order
- `newdeli.branches` — 44 rows — branch master (Egz + MiniDeli)
- `newdeli.measures` / `dimensions` — BI metadata
- `newdeli.comparison_dates`, `jewish_holidays`, `hebrew_dates` — calendar

### Key columns in facts:
- `"מזהה סניף"` — branch ID (TEXT hex string, join with branches)
- `"תאריך"` — date (TEXT DD/MM/YYYY)
- `"שנה וחודש"` — year-month (TEXT YYYY-MM), best for monthly grouping
- `"סכום הזמנה"` — order revenue (TEXT, CAST to NUMERIC)
- `"total"` — order total (TEXT, CAST to NUMERIC)
- `"סוג הזמנה"` — order type (TEXT: טייק אווי/דלפק, משלוח, ישיבה)
- `"אופן תשלום"` — payment method (TEXT: מזומן, אשראי)
- `"status"` — '2' = completed

### Sub-brands: Egz and MiniDeli (column `"חברה"` in branches)

---

## GCS Archive Issue
The user said data on GCS is in archive format. Need to clarify:
- If .gz: add `zlib.createGunzip()` pipe in `reload-newdeli.js`
- If .zip: need different approach

For the demo, use LOCAL loading (Step 2 above) — bypasses GCS entirely.

---

## Isolation — This does NOT affect other projects
- newdeli queries run on aspect-data-db (zer4u DB), NOT the main system DB
- Banking agent uses the main DB — zero interference
- Statement timeout (15s) protects against long queries on zer4u DB
- slow_queries table on main DB just logs — no blocking risk
- newdeli schema is namespaced separately from zer4u schema

---

## Run Order for Demo Setup (when proxy is active)

```bash
# Terminal 1: main DB proxy (port 5432) — for seed-newdeli-agent.js
# Terminal 2: zer4u DB proxy (port 5433) — for schema/load/index scripts

cd aspect-agent-server

# 1. Create schema
node scripts/create-newdeli-schema.js

# 2. Load ~1.6 GB of data (5-15 min)
node scripts/load-newdeli-local.js

# 3. Create indexes (~5 min)
node scripts/create-newdeli-indexes.js

# 4. Seed agent in main DB
node scripts/seed-newdeli-agent.js

# 5. Restart server
npm start
```

Then deploy client + server.
