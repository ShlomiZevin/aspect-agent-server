> **SUPERSEDED — 2026-08-27.** This work shipped as the first Aspect Module.
> Live plan and per-step verification:
> `tasks/pending/aspect-modules.md` and
> `verification/modules-replenishment/README.md`.
> Feature docs: `docs/features/modules.md`, `docs/features/replenishment.md`.
>
> Kept because its Step 4 engine spec and its eight named edge cases are the
> literal source the shipped engine was written from, and section 3's
> limitations are quoted verbatim on every surface. Where this file and the
> module docs disagree, the module docs are current.

# ZolStock — Smart Replenishment (what to order · how much · when)

> **Narrative version of this spec** (product framing, diagrams, rationale):
> `/aspect/zolstock-purchasing` — `aspect-react-client/src/pages/ZolstockPurchasingSpecPage.tsx`
> **Customer-facing Hebrew companion:** `/aspect/zolstock-purchasing-he`
>
> This file is the **working copy for a Claude Code session**: contracts, file
> paths, and ordered steps with per-step verification. Read the page for *why*;
> read this for *what to type*. If they disagree, the page is authoritative on
> scope and limitations — update both.

---

## 0 · Execution constraints

- **Read first:** `CLAUDE.md` (conventions), `docs/features/insights.md`,
  `agents/zolstock/AGENT.md`, `services/schema-rules/zolstock.rules.js`,
  `services/dataset-manifest/zolstock.manifest.js`.
- **One step at a time.** Every step below has a verification clause. Do not
  start step N+1 until step N verifies.
- **Never mutate dataset config while a suite is running** (a concurrent
  `setConfig` killed two cases mid-run during the 2026-08 work).
- **Never persist to a repo-relative path** — `COPY . .` bakes it into the image
  and every deploy resets it. Postgres or GCS only.
- Verification output goes in `verification/zolstock-replenishment/` with a
  `README.md`. A results file in the repo root is a bug.

---

## 0A · Facts established during scoping — do not re-investigate

| Fact | Consequence |
|---|---|
| `zolstock.facts` = 29,910,277 rows, five row kinds via generated `record_type` | Always filter `record_type` |
| sales 26,905,987 · store_inventory 2,983,200 · warehouse_inventory 8,924 · customer_order 11,488 · purchase_order 677 | PO volume is tiny — do not assume it is a rich signal |
| Sales key `facts.item_number_sales` → `items.item_number` (99.9%); replenishment key `facts.sku` → `items.sku` | Demand and stock must be bridged through `items` |
| **Only 14,649 of 298,555 items have a sku** | Items without one have no replenishment identity. Sized per supplier in step 1 |
| `items.positive_supplier` = the supplying company (what a buyer means by ספק). `items.supplier` = manufacturer, Latin values stored **character-reversed** | Use `positive_supplier`. The sales MVs currently carry the wrong one |
| `items` is NOT unique on `item_number` — 1,859 repeat, 4,953 extra rows | Dedup with `GROUP BY item_number + MAX()`, never untied `DISTINCT ON` |
| `items.safety_stock` populated on 15,067 / 303,508 | Needs a computed fallback |
| Inventory rows carry **NULL row_date** — snapshot only, no history | Demand from sales only |
| PO rows have **no status**, and nothing in the feed records goods receipt | Lead time can never be measured; "on order" may over-count |
| Sales run 2025-01-01 → 2026-08-17; last delivered day can be partial | Anchor everything to sales max date, never `CURRENT_DATE` |
| VAT for this dataset is exactly **1.18**, sourced from the manifest | Never hardcode a VAT number elsewhere |
| 99 of 5,015 warehouse skus have no `items` row | NULL name/supplier; `ORDER BY … DESC NULLS LAST` |
| The `zolstock` schema is dropped + rebuilt behind an atomic swap on every reload | **Nothing user-entered may live there** |

---

## 1 · Scope

**In:** Purchasing — for **all suppliers found in the data**. Three surfaces:
a screen, a chat tool, an Intelligence report.

**Out:** ordering integration, alerts, push, WhatsApp/email delivery,
scheduling, auth. Nothing runs ahead of the user except the data preparation
inside the reload that already runs. This is an *answering* product.

**Later, and agreed with the client:** proactive push — alerts and
recommendations that reach the buyer without opening the product — once the
screen and the agent are approved and the numbers are trusted. Not built now,
but **design for it**: the calculation must be callable with no user in front
of it (a plain function over stored settings, no request context, no session).
Done right, the push phase is a scheduler plus a delivery channel — the
self-checking `scheduler-tick.service.js` pattern and the existing
`whatsapp/provider.js` — not a rewrite.

**Designed for, not built now:** warehouse grain and per-branch grain. Do not
hardcode "warehouse" into the math — pass the stock source in.

---

## 2 · Steps, each with its verification

### Step 0 — Fresh baseline
Run and record: `node scripts/test-insights-unit.js`,
`node scripts/test-schema-contract.js`, `node scripts/test-stage2-unit.js`,
`node scripts/test-stage3-unit.js`.

**Verify:** all four pass, or the pre-existing failures are written down.

---

### Step 1 — Phase 0 data audit + Hebrew gap report  ⚠ GATE
New: `scripts/zolstock-replenishment-audit.js`. Read-only, no LLM.
Writes `verification/zolstock-replenishment/audit-<date>.json` + `README.md`.
Supports `--format=hebrew` for a plain-Hebrew "what is missing" summary that
Shlomi sends manually to the BI developer and the customer.

Must measure:

| # | Measurement |
|---|---|
| A1 | Distinct `positive_supplier`; items per supplier; % NULL |
| A2 | Same for `supplier_code`; is `supplier_code` → `positive_supplier` 1:1? (decides the settings key) |
| A3 | **Per supplier: item count vs item-count-with-a-sku** |
| A4 | Per supplier: skus with warehouse stock, skus sold in 365d, and the overlap ("actionable skus") |
| A5 | `purchase_order`: distinct skus/order ids, date range, qty range, any column that could imply status |
| A6 | Any evidence of goods receipt / GRN / arrival date anywhere in the four files |
| A7 | `items.safety_stock` coverage overall and per supplier |
| A8 | `items.units_per_carton` coverage + value distribution |
| A9 | Distinct `facts.warehouse` values and rows per warehouse |
| A10 | Sales date range; last-day completeness via `services/coverage.service.js` |
| A11 | Warehouse skus with no `items` row |
| A12 | `customer_order` date range vs sales max date — open demand or historical? |

**Verify:** A3, A5, A6 have real numbers. **Stop and review with Shlomi.** If A3
shows most suppliers have almost no sku-bearing items, re-scope rather than
ship a screen that recommends nothing.

---

### Step 2 — Materialized views
Edit `scripts/create-zolstock-mvs.js`:

1. Add `positive_supplier` and `sku` to `ITEM_DIM`, and propagate both into
   `mv_sales_monthly_item` and `mv_sales_item_total`. *(Correctness fix in its
   own right — "sales by supplier" currently groups by the reversed-text
   manufacturer column.)*
2. Add **`mv_suppliers`** — grain: supplier.
   `supplier, supplier_code, item_count, sku_item_count, warehouse_units,
   warehouse_value_ex_vat, units_sold_365d, revenue_list_ex_vat_365d`
3. Add **`mv_replenishment_base`** — grain: `sku` (~14.6k rows).
   `sku, item_number, item_name, category, subcategory, supplier (=positive_supplier),
   supplier_code, units_per_carton, safety_stock_data, consumer_price, cost_ex_vat,
   warehouse_qty, store_qty_total, on_order_qty, on_order_order_count,
   on_order_last_date, committed_qty, qty_sold_28d, qty_sold_90d, qty_sold_365d,
   first_sold, last_sold, data_through`

Rules: dedup `items` before every join; UNIQUE index on both views (required for
`REFRESH … CONCURRENTLY`); anchor trailing windows to
`(SELECT MAX(row_date) FROM zolstock.facts WHERE record_type='sales')`.

> A full `facts` scan is fine **at build time** (this runs in reload phase 2
> alongside `mv_sales_monthly_item`). It remains forbidden at request time.

**Verify:** build against a scratch schema first, not live. Row counts match
step 1. `node scripts/test-schema-contract.js` passes. A full reload still
completes.

---

### Step 3 — Migration 039 + settings service
`db/migrations/039_add_supplier_settings.sql` + `run-039-supplier-settings.js`
+ a Drizzle definition in `db/schema/index.js`. **Platform DB** (`services/db.pg`).

```sql
CREATE TABLE IF NOT EXISTS supplier_settings (
  id              BIGSERIAL PRIMARY KEY,
  dataset_id      TEXT        NOT NULL,
  supplier_key    TEXT        NOT NULL,
  supplier_label  TEXT,
  lead_time_days  INTEGER,
  review_days     INTEGER,
  safety_days     INTEGER,
  min_order_units INTEGER,
  notes           TEXT,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, supplier_key)
);
CREATE INDEX IF NOT EXISTS idx_supplier_settings_dataset ON supplier_settings (dataset_id);
```

Dataset defaults go in `provider_config` under `replenishment_config_zolstock`:
```json
{ "defaultLeadTimeDays": 90, "defaultReviewDays": 30, "defaultSafetyDays": 14,
  "velocityWindowDays": 90, "includeStoreStock": false, "enabled": true }
```

New `insights/services/supplier-settings.service.js`:
`listSuppliers · getSettings · upsertSettings · getDefaults · setDefaults`.
Resolution chain, implemented once: **supplier override → dataset default →
code constant**, and every resolved value carries which level it came from.

**Verify:** run the runner; upsert a supplier; **run a full zolstock reload**;
confirm the setting survived. That check is what proves the storage rule was
respected.

---

### Step 4 — The engine
New `insights/services/replenishment.service.js`. Pure math exported separately
for offline testing (same pattern as `detectSuspiciousResult` /
`reconcileImpactValue` in `investigation.service.js`). `today` is a parameter —
never read a clock inside the function.

```
window        = velocityWindowDays
velocityDaily = qtySold{window} / window
onHand        = warehouseQty + (includeStoreStock ? storeQtyTotal : 0)
netAvailable  = onHand + onOrderQty - committedQty
safetyStock   = safetyStockData ?? ceil(velocityDaily * safetyDays)
reorderPoint  = velocityDaily * leadTimeDays + safetyStock
daysOfCover   = velocityDaily > 0 ? netAvailable / velocityDaily : null
orderByDate   = dataThrough + (daysOfCover - leadTimeDays) days
daysLate      = today - orderByDate
targetStock   = velocityDaily * (leadTimeDays + reviewDays) + safetyStock
rawQty        = max(0, targetStock - netAvailable)
orderQty      = unitsPerCarton > 0 ? ceil(rawQty / unitsPerCarton) * unitsPerCarton
                                   : ceil(rawQty)
orderQty      = max(orderQty, rawQty > 0 ? (minOrderUnits ?? 0) : 0)
status        = daysLate > 0 ? 'overdue'
              : daysOfCover === null ? 'no_demand'
              : orderByDate <= today + horizonDays ? 'due_soon' : 'ok'
```

Output row also carries: `leadTimeSource`, `safetyStockSource`, `velocityBasis`,
`onOrderIsUnverified`, `onOrderLastDate`, `orderQtyRounding`,
`estimatedCostExVat`, `dataThrough`, and **`notes[]`** — the single place every
caveat is worded (screen, chat and report all quote it rather than re-deriving).

**Required edge cases** (each a named assertion in
`scripts/test-replenishment-unit.js`, offline, no DB, no LLM):

| Case | Behaviour |
|---|---|
| Zero velocity, stock on hand | `no_demand`, orderQty 0, flag dead stock |
| Zero velocity, zero stock | Excluded from the list |
| Negative `netAvailable` | Report it, do NOT clamp (ראש העין carries −802,918 units) |
| `unitsPerCarton` NULL/0 | No rounding; note "carton size unknown" |
| Sku missing from `items` | Include, NULL name/supplier, "unmatched" bucket |
| New item, first sale inside the window | Velocity over days-since-first-sale; flag thin history |
| `lastSold` older than the window | `no_demand` even if 365d qty is non-zero |
| Lead time inherited | `leadTimeSource: 'dataset_default'` |

**Verify:** battery passes; then **hand-check 10 real skus** against the raw
tables with a calculator and write the result into
`verification/zolstock-replenishment/`.

---

### Step 5 — Router
New `insights/routes/replenishment.routes.js`, **one mount line** in
`server.js` (the `bi/` · `insights/` · `hq/` · `builder/` pattern — do not add
to the inline-route pile).

| Method | Path |
|---|---|
| GET | `/api/replenishment/:datasetId/suppliers` |
| PUT | `/api/replenishment/:datasetId/suppliers/:key` |
| GET/PUT | `/api/replenishment/:datasetId/defaults` |
| GET | `/api/replenishment/:datasetId/recommendations?supplier=&horizonDays=&onlyDue=&limit=` |
| GET | `/api/replenishment/:datasetId/recommendations/:sku` |

**Verify:** unknown dataset ⇒ 404; a supplier with no settings returns
`leadTimeSource: 'dataset_default'`.

---

### Step 6 — The screen
`src/components/intelligence/Purchasing/` · route
`/intelligence/:datasetId/purchasing` · fourth nav item in
`IntelligenceShell.tsx` (add a `purchasingRoute` prop beside `reportsRoute`) ·
strings in `src/i18n/translations.ts` · typed client
`src/services/replenishmentService.ts` + `src/types/replenishment.ts`.

- **Tab A — Suppliers:** supplier · items/with-sku · warehouse value · sold 365d
  · **lead time** (with an inherited-value badge) · due-now count.
- **Tab B — What to order:** item/sku · velocity · available (`~` marker when
  on-order is unverified) · cover · **order by** · **order qty** · est. cost.
  Default sort most-overdue-first; default filter `onlyDue`. CSV export of the
  filtered view.
- **Row detail shows the full arithmetic** — every input, the formula, the
  result, and the source of each parameter. This is the trust surface.

House UI rules: **modal editing, not inline**; custom confirm modal, never
browser `confirm()`; notices render into a **fixed-height slot** so the modal
never resizes.

**Verify:** both languages render correctly (RTL/LTR); modal does not resize
when a notice appears; a lead-time change is reflected in Tab B without a
reload; row-detail arithmetic matches the step-4 hand-checked skus.

---

### Step 7 — Chat tool
Add `fetch_zolstock_replenishment` to `agents/zolstock/crew/zolstock.crew.js`
alongside `fetch_zolstock_data`. It calls the engine service with structured
args (`supplier? sku? horizonDays? onlyDue? limit?`) — **it does not generate
SQL**. Guidance teaches answer-first-then-flag: answer using the default lead
time, say that is what was used, and point at the suppliers screen.

Bilingual rule: mirror the prompt and nothing else. Hebrew **in the data**
(supplier names, categories) says nothing about the requested language.

**Verify:** `node scripts/test-chat-regression.js zolstock` and
`--hebrew`. Then ask the same question five ways in each language and confirm
**identical numbers** — that invariance is the reason the tool exists.

---

### Step 8 — Honesty layer + report
`services/dataset-manifest/zolstock.manifest.js`:
- `measures`: **replenishment need** (`estimate`), **estimated order cost** (`estimate`)
- `dimensions`: **supplier lead time** → `configured` (new status: user-supplied,
  not from data); **goods receipt / arrival** → `absent` + roadmap
- `vocabulary`: זמן אספקה · לי טיים · נקודת הזמנה · מלאי ביטחון · הזמנה פתוחה
- `dataFacts`: the sku-coverage fact; the unverified-PO fact
- `refusals`: high-precision triggers for arrival/receipt questions
  (*מתי הגיעה ההזמנה* / *when did the order arrive*). Precision beats recall —
  ambiguous phrasings fall through to the prompt.

`services/schema-rules/zolstock.rules.js`: replace the existing
"Replenishment / reorder / transfer questions" block — replenishment is now
answered by the tool, and generated SQL must **not** attempt the reorder
arithmetic. Keep the "never scan facts at item grain" guidance.

`insights/services/investigation.service.js`: PLAN gains a `replenishment`
category; when chosen, rows come from the engine instead of
`dataQueryService.queryByQuestion`. Everything downstream (digest, impact
reconciler, independent verifier, downgrade guard) is unchanged — they operate
on rows and a write-up and do not care where the rows came from. Reuse the
existing block palette; do not add a block type.

`insights/datasets/registry.js`: extend zolstock's `defaultDataModelDescription`
so PLAN knows replenishment is answerable; add example/bootstrap prompts
("מה צריך להזמין עכשיו", "אילו ספקים בסיכון חוסר", "Which suppliers have items
about to run out").

**Verify:** `test-schema-contract.js`, `test-stage2-unit.js`,
`test-stage3-unit.js`; a receipt question refuses with the manifest's reason;
`node scripts/test-insights-suite.js zolstock all` and `… hebrew`.

---

### Step 9 — Regression sweep
`node scripts/run-customer-replay.js` against the frozen corpus, then
`node scripts/compare-replays.js` against the last baseline.

**Verify:** zero regressions on the 74-question baseline. *(A 65-case suite
written from our own model of this data passed 65/65 while one real
18-question client session exposed two silently wrong answers. The replay is
the bar.)*

---

### Step 10 — Docs
New `docs/features/replenishment.md`; update `agents/zolstock/AGENT.md` with the
new capability and its limits; update `docs/INDEX.md`.

---

## 3 · Limitations to carry into every surface

Mirrors §11 of the spec page and §05 of the Hebrew customer page. If a ninth is
discovered in step 1, add it to all three.

1. **No goods receipt anywhere in the feed** → lead time is configured, never
   measured; open vs delivered POs are indistinguishable, so "on order" may
   over-count supply and cause under-ordering.
2. **Inventory is an undated snapshot** → no stock history or measured
   consumption; demand from sales only.
3. **Only 14,649 of 298,555 items have a sku** → no replenishment identity for
   the rest.
4. **No money in the fact data** → all values derived from list prices at 18%
   VAT, excluding discounts (+2.3–7.0%/month vs the client's own dashboard).
5. **~19 months of sales history** → one prior year; holidays flaggable from
   `calendar`, seasonality not modellable.
6. **Periodic export; last day can be partial** → every answer carries a
   data-through date.
7. **No MOQ / order calendar / container constraints in the data** → carton
   rounding only, anything else configured.
8. **Category mapping diverges from the client's Qlik** (2×–29× per category) →
   never reconcile replenishment by category against their dashboard.

---

## 4 · Files

**New:** `scripts/zolstock-replenishment-audit.js` ·
`scripts/test-replenishment-unit.js` ·
`db/migrations/039_add_supplier_settings.sql` + runner ·
`insights/services/replenishment.service.js` ·
`insights/services/supplier-settings.service.js` ·
`insights/routes/replenishment.routes.js` ·
`src/components/intelligence/Purchasing/*` ·
`src/services/replenishmentService.ts` · `src/types/replenishment.ts` ·
`verification/zolstock-replenishment/` · `docs/features/replenishment.md`

**Touched:** `scripts/create-zolstock-mvs.js` ·
`services/schema-rules/zolstock.rules.js` ·
`services/dataset-manifest/zolstock.manifest.js` ·
`agents/zolstock/crew/zolstock.crew.js` · `agents/zolstock/AGENT.md` ·
`insights/services/investigation.service.js` · `insights/datasets/registry.js` ·
`db/schema/index.js` · `server.js` · `src/App.tsx` ·
`src/components/intelligence/IntelligenceShell.tsx` · `src/i18n/translations.ts`

---

## 5 · Results

Shipped 2026-08-27 as **Smart Replenishment**, module #1 of the Aspect
Modules framework. Every step below transferred; file locations changed and
hardcoded zolstock references became the LLM-produced binding.

| ZS step | Where it lives now | Verified |
|---|---|---|
| 1 · audit + Hebrew gap report | `modules/replenishment/audit.js`, `scripts/run-replenishment-audit.js` | live run, 10 gaps, Hebrew renders |
| 2 · materialized views | `modules/replenishment/templates.js` (rendered from the binding) | 47/47 render battery, built on live data |
| 3 · supplier settings | migration 041 + `services/supplier-settings.service.js` | 20/20 |
| 4 · the engine | `modules/replenishment/engine.js` | **67/67**, all eight edge cases |
| 5 · router | `modules/replenishment/routes/replenishment.routes.js` | 34/34 |
| 6 · the screen | `src/components/intelligence/Purchasing/` | headless, both locales, RTL |
| 7 · chat tool | `modules/replenishment/chat-tool.js` | 43/43, five-ways invariance |
| 8 · honesty layer + report | manifest + rules + Insights category | 43/43, 21/21 |
| 9 · regression sweep | customer replay | see the verification README |
| 10 · docs | `docs/features/{modules,replenishment}.md` | — |

**The gate answer (step 1's stop-and-review):** only **2 of 446 suppliers**
have catalogue coverage you could order against. The re-scope this step
existed to force is a one- or two-supplier pilot, which independently
matches the feasibility brief's conclusion.

**Two things the plan did not anticipate**, both found by running against
real data rather than by testing:

1. A negative stock position divided by a slow item's velocity produced
   *"stock covers −5,400 days, order should have gone out on 2011-08-15"*.
   Quantity stays un-clamped (step 4's rule is unchanged); **time** is now
   clamped, so the same row reads "already out, 91 days late".
2. With the 90-day default lead time, **about half the catalogue reads as
   overdue**. Not a fault — it follows from the default — but it is the
   alert-fatigue risk with a number attached, and it makes real per-supplier
   lead times a precondition rather than a nicety.

