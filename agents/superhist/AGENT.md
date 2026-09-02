# הסופר החברתי — The Social Supermarket (`superhist`)

The Histadrut's members-only online grocery, **super-hist.co.il**. Members of
Israel's largest labour federation sign in with their ID number and buy everyday
goods at subsidised prices; the union uses its collective purchasing power to
lower members' cost of living. Slug follows the client's own domain.

**Online only.** No branches, no tills, no cashiers — and there never will be.
A question that assumes a shop floor has no answer here.

## The data model

An **order** model, not a point of sale:

```
orders ──< order_lines >── products ── (categories)
   │
   └── calendar (a date dimension, not a range of real days)
```

| table | rows (first delivery) | notes |
|---|---|---|
| `orders` | 19,062 | one per order; carries the DATE, the total and the member |
| `order_lines` | 654,370 | the fact table — **two row kinds**, see below |
| `products` | 16,537 | catalogue; 3,202 of them actually sold |
| `categories` | 110 | marketing collections, **not** a taxonomy |
| `calendar` | 367 | all of 2026 |

## Five things measured on 2026-09-02 that shape everything

**1. `order_lines` holds two kinds of row and the source has no discriminator.**
634,556 product lines and 19,814 shipping lines — one per order. A shipping row
has an empty line id, no quantity, and the delivery method's *name* where a
product id belongs. A generated `line_kind` column separates them at load
(`create-superhist-indexes.js`). Every item question must filter
`line_kind = 'product'`; without it a count overstates units by 3% and a join to
products silently drops exactly those rows.

**2. The money reconciles, and subsidy is not part of it.**
`line_total` = `quantity` × `unit_price` on every product line, exactly.
`orders.order_total` = its product lines + shipping, on 19,045 of 19,062 orders.
`subsidy` (₪511,647, ~6.1%) is the **union's contribution recorded alongside the
charge**, never deducted from it — subtracting it reconciles on 12 orders,
leaving it alone reconciles on 19,045. Report it as its own measure.

**3. There is no product category.** `products.category_id` is populated on 547
of 16,537 products (3.3%) and every one points at a **single** id. The
categories table is campaign collections — "חגיגת שבועות", "הסל שלנו". Sales by
category is unanswerable and the manifest refuses it rather than grouping by
something adjacent.

**4. There is no cost side.** No cost, COGS or supplier price in any file, and
`tax` is 0.0000 on all 654,370 lines. So no profit, no margin, and no VAT split.
Revenue exists; profit does not, not even approximately.

**5. The history is short and the last month is partial.** The first delivery is
42 days, 2026-07-01 to 2026-08-11 — July complete (15,758 orders, ₪6.94M),
August cut off on the 11th (3,304, ₪1.49M). No year-on-year, no seasonality.
A naive month-over-month reads as a 79% collapse that did not happen. The
calendar table covers the whole year and is **not** evidence that a date has
orders.

Also worth knowing: `order_status` and `display_status` **disagree on 7,176 of
19,062 orders**, and `counts_for_totals` is 1 on every row, so it filters
nothing despite its name.

## Files

Server:
- `agents/superhist/crew/superhist.crew.js` — the agent
- `agents/superhist/data-reload.js` — reloader registration; enabled from the
  Configuration tab (`superhist_reload_enabled` in `provider_config`)
- `scripts/column-aliases-superhist.js` — all 79 delivered headers, mapped
- `scripts/reload-superhist.js` — two-phase load; `FILE_TO_TABLE` carries the
  exact Hebrew basenames Qlik exports
- `scripts/create-superhist-{schema,indexes,mvs}.js`
- `services/schema-rules/superhist.rules.js` — SQL-generation rules
- `services/dataset-manifest/superhist.manifest.js` — the honesty layer
- `services/db.superhist.js` — re-exports the shared `zer4u` pool
- `scripts/seed-superhist-agent.js` — the `agents` table row

Client: `src/agents/superhist.config.ts`, `src/pages/SuperHistPage.tsx`,
routes `/superhist` and `/intelligence/superhist`.

## Materialized views

| view | grain | for |
|---|---|---|
| `mv_orders_daily` | day | revenue, orders, members, units, subsidy, shipping |
| `mv_sales_daily_item` | day × item | top sellers over a period |
| `mv_sales_item` | item, lifetime | best sellers, stock against demand |
| `mv_customers` | member | repeat rate, spend per member |
| `mv_orders_by_status` | day × status | both status columns, side by side |

## Bringing it up

1. Upload the five CSVs to the `superhist/` GCS folder under their **exact**
   delivered basenames — an upload whose name differs by a space is silently
   skipped.
2. `node scripts/seed-superhist-agent.js` (needs the Cloud SQL proxy).
3. Switch the reload on in the Data Loader **Configuration tab** — it writes
   `superhist_reload_enabled` to `provider_config` and takes effect at once.
   (Do not edit `.env`; that pattern was retired.)
4. Run Phase 1, then Phase 2, from the admin data-loader.

`scripts/test-schema-contract.js` reports `superhist: schema has no relations`
until step 4 completes. That is the test doing its job, not a defect — it goes
green with the first load.

## Not loaded, deliberately

`Dim`, `Dim1`, `Measure`, `Measures` are QlikSense's own dashboard metadata —
the field picker's sort order and a table of formula strings. They describe the
client's Qlik app, not their business, and loading them would put `$Measure` and
`Measure Formula` in front of an LLM as though they were data.
`OrderLine_Last_7_Days_1` is a single column of order ids, a Qlik filter helper;
the same rows are already in `OrderLine`.
