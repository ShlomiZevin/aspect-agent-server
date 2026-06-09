# Zol Stock Agent Setup

New customer: **Zol Stock** (זול סטוק, https://zolstock.co.il) — a discount retail
chain in Israel. Same BI-over-SQL pattern as zer4u / thestock / hypertoy.

> ⚠️ NOT the same as **The Stock** (הסטוק, hastok-sale.com). Different customer.
> slug `zolstock`, schema `zolstock`, theme `theme-zolstock` (blue + yellow).

## Phase A — Scaffolding (DONE, data-independent)

### Client (aspect-agent-client-react)
- [x] `public/img/zolstock-logo.png` (+ `zolstock-logo-source.png`) — official logo from site
- [x] `src/styles/themes/zolstock-theme.css` — cobalt blue + yellow palette
- [x] `src/styles/global.css` — `@import` the theme
- [x] `src/agents/zolstock.config.ts`
- [x] `src/agents/index.ts` — export config
- [x] `src/agents/agentRegistry.ts` — import + `zolstock` registry entry
- [x] `src/pages/ZolStockPage.tsx`
- [x] `src/pages/index.ts` — export page
- [x] `src/App.tsx` — import + `/zolstock` routes
- [x] `src/i18n/translations.ts` — EN + HE quick-question blocks

### Server (aspect-agent-server)
- [x] `agents/zolstock/AGENT.md`
- [x] `agents/zolstock/crew/index.js`
- [x] `agents/zolstock/crew/zolstock.crew.js` — crew + `fetch_zolstock_data` tool
- [x] `agents/zolstock/data-reload.js` — registers reloader (DISABLED by default)
- [x] `services/db.zolstock.js` — re-exports zer4u pool
- [x] `scripts/seed-zolstock-agent.js`
- [x] `scripts/reload-zolstock.js` — skeleton (FILE_TO_TABLE empty)
- [x] `scripts/column-aliases-zolstock.js` — skeleton (COLUMN_MAP empty)
- [x] `scripts/create-zolstock-schema.js` — data-agnostic, ready as-is
- [x] `scripts/create-zolstock-indexes.js` — skeleton (INDEXES empty)
- [x] `server.js` — register `agents/zolstock/data-reload`
- [x] `services/sql-generator.service.js` — placeholder `zolstock` branch (returns '')

### DB (main agents table)
- [ ] Run `node scripts/seed-zolstock-agent.js` (needs cloud-sql-proxy on 5432) — inserts the `zolstock` agent row

## Phase B — Data

### Facts modeled (DONE)
`Facts_ZolStock_CSV.csv` analyzed: ~39.46M rows, 52 columns, wide table with a
`Fact Type` → `record_type` discriminator: `מכירות` (sales 34.76M), `מלאי`
(inventory 2.77M), `''` (empty = agent/branch sales 1.93M). Decision: single
`facts` table + indexes + materialized views (no per-record-type split).
- [x] `FILE_TO_TABLE` → `Facts_ZolStock_CSV.csv: 'facts'` + `GCS_FOLDER = 'zolstock/'`
- [x] `COLUMN_MAP.facts` — all 52 columns (Hebrew → English, typed). Revenue ex-VAT = `line_total`, cost = `cogs`, profit = `line_total - cogs`.
- [x] `INDEXES` — `(record_type, transaction_date)` composite + store/item/seller/customer/sale_id
- [x] `create-zolstock-mvs.js` — `mv_sales_daily` / `_item` / `_store` / `_seller` (revenue, cogs, profit, qty); wired into `indexZolStock` Phase 2
- [x] crew "AVAILABLE DATA" section + examples updated
- [x] `zolstock` rules block in `sql-generator.service.js` (record_type, revenue/profit, MV usage, examples)

### To run the facts load
1. [ ] Upload `Facts_ZolStock_CSV.csv` to GCS under the `zolstock/` prefix.
2. [ ] Capacity check on aspect-data-db (two-phase reload doubles storage; ~8GB CSV).
3. [ ] Set `ZOLSTOCK_RELOAD_ENABLED=true` in `.env` / prod env file.
4. [ ] Kosta runs Phase 1 + Phase 2 reload from the admin UI (never via API).
5. [ ] Smoke-test queries (revenue/profit this month, top items, top stores, margin).
6. [ ] Deploy (client: Firebase; server: `./deploy.sh aspect`) — ask first.

### When dimension files arrive (products / customers / stores / calendar)
- [ ] Add their `COLUMN_MAP` entries + `FILE_TO_TABLE` mappings.
- [ ] Add lookup indexes; add JOINs in the crew guidance + `sql-generator` rules so
      item/store/customer **names** (not just numbers) appear in answers.
- [ ] Update quick questions in `zolstock.config.ts` + `translations.ts`.

## Notes
- Reload stays DISABLED (`ZOLSTOCK_RELOAD_ENABLED !== 'true'`) until Phase B, so the
  empty skeletons never execute and server boot is unaffected.
- `db.zolstock.js` re-exports the zer4u pool — data lives in the shared aspect-data-db
  instance alongside zer4u / newdeli / thestock / hypertoy.
