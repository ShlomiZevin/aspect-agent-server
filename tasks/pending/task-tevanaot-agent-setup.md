# Teva Naot (טבע נאות) — New BI Agent Setup

**Customer:** Teva Naot — Israeli footwear (shoes) retail company. Site: tevanaot.co.il
**Slug / schema / theme:** `tevanaot` / `theme-tevanaot`. Display name: **Teva Naot**.
**Pattern:** copied from zer4u / hypertoy / zolstock (NL → SQL Generator → PostgreSQL).
**Source:** QlikSense export, GCS folder `aspect-clients-data/tevanaot/` (uploaded 2026-06-18).

---

## Data model (KEY)

QlikSense star schema. Fact tables carry only measures + a synthetic composite key;
every dimension component is embedded in the key, so we resolve by regexp/split_part and
**do NOT load** the LINK_TABLE (1.2GB bridge) or the Calendar files (12M empty rows).

| Fact key | Encodes |
|----------|---------|
| sales.`warhs_cust_part_date_key` | WARHS-CUST-PART-DATE (DATE = Excel serial) |
| inventory.`branch_part_key` | BRANCH-PART |
| inventory_in_date.`end_month_branch_part_key` | DATE(dd/mm/yyyy)-BRANCH-PART |
| orders.`part_cust_date_key` | PART-CUST-DATE |

`mv_sales` resolves the sales key once → typed `transaction_date` / `warhs` / `part` / `cust`
+ measures. The agent queries `mv_sales` / `mv_sales_daily` for sales.

**Loaded tables (10):** sales, parts, inventory, inventory_in_date, orders, customers,
sites, sales_rate, purchase_orders, suppliers.
**Skipped:** LINK_TABLE, Calendar, CalendarGroupA/B, Dynamic_Report_* (bridge/metadata/junk).

---

## What was built (Phase A — code scaffold)

### Server (aspect-agent-server)
- `scripts/column-aliases-tevanaot.js` — CSV header → English DB column map (10 tables)
- `scripts/create-tevanaot-schema.js` — generic table creation
- `scripts/create-tevanaot-indexes.js` — JOIN/lookup indexes
- `scripts/create-tevanaot-mvs.js` — `mv_sales` (resolved line-level) + `mv_sales_daily`
- `scripts/reload-tevanaot.js` — two-phase reload, GCS folder `tevanaot/`, FILE_TO_TABLE
- `scripts/seed-tevanaot-agent.js` — seeds `agents` row (name 'Teva Naot', slug 'tevanaot')
- `scripts/test-tevanaot-flow.js` — agent test harness (21 questions; AGENT_NAME = 'Teva Naot')
- `services/db.tevanaot.js` — shared aspect-data-db pool re-export
- `agents/tevanaot/crew/tevanaot.crew.js` + `index.js` — BI crew + `fetch_tevanaot_data`
- `agents/tevanaot/data-reload.js` — registers reloader (DISABLED until TEVANAOT_RELOAD_ENABLED=true)
- `agents/tevanaot/AGENT.md`
- `services/sql-generator.service.js` — added `tevanaot` rules block (key resolution, measures)
- `server.js` — registered `agents/tevanaot/data-reload`
- `services/provider-config.service.js` — added `tevanaot_import_months` ENV fallback

### Client (aspect-agent-client-react)
- `src/agents/tevanaot.config.ts` + export in `agents/index.ts`
- `src/pages/TevaNaotPage.tsx` + export in `pages/index.ts`
- `src/styles/themes/tevanaot-theme.css` (burgundy) + import in `global.css`
- `src/agents/agentRegistry.ts` — registry entry `tevanaot`
- `src/App.tsx` — routes `/tevanaot` + `/tevanaot/conversations/:id`
- `src/i18n/translations.ts` — quick.tevanaot.* keys (EN + HE)
- `public/img/tevanaot-logo.svg` — official logo from tevanaot.co.il

---

## Remaining (Phase B — data load + tuning)

1. **Deploy** server (gcloud) + client (firebase) — ASK USER FIRST, never auto-deploy.
2. **Seed** the agents row: `node scripts/seed-tevanaot-agent.js` (via Cloud SQL Proxy).
3. **Enable reload:** set `TEVANAOT_RELOAD_ENABLED=true` in `.env.production.aspect`.
   Check aspect-data-db storage first (two-phase reload doubles it).
4. **Kosta runs Phase 1 (load) + Phase 2 (index/MVs)** from the prod admin Data Loader UI
   (never via API). Verify mv_sales row count + that transaction_date resolved (sane min/max).
5. **Smoke test:** `node scripts/test-tevanaot-flow.js all` — verify revenue/top-models/
   top-stores/inventory/avg-basket. Tune the sql-generator `tevanaot` block against real data:
   - Confirm Excel-serial epoch (DATE '1899-12-30') gives correct dates.
   - Confirm WARHS = split_part(key,'-',1) maps to sites.warhs (positive store codes).
   - Validate part extraction `regexp_match(key, '-([^-]+)-[0-9]+$')` against parts.part.
6. Add product-attribute MVs if top-N by model/color/size is slow on mv_sales (~2.7M).
