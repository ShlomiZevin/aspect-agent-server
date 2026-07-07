# Aspect BI

A standalone, Aspect-owned **BI tool** over customer data schemas — a lightweight
"build your own Qlik" so Aspect can serve dashboards + ad-hoc analysis from its
own stack instead of depending on Qlik. First dataset: **hypertoy**.

It is **independent of the agent/crew system**. It shares the repo, tech stack,
and the same Cloud SQL data instance, but touches nothing under `agents/`,
`crew/`, or `builder/`. The only edit to existing code is one mount line in
`server.js` (`app.use('/api/bi', ...)`).

## Architecture

```
bi/
├── datasets/
│   └── hypertoy.dataset.js   # Semantic model: dimensions, measures, joins,
│                             #   record_type rules. The ONLY trusted SQL source.
├── services/
│   ├── query-compiler.js     # Structured spec → parameterized SQL. No free-text SQL.
│   └── dashboards.store.js    # Saved dashboards (bi_dashboards table, JSONB defs)
└── routes/
    └── bi.routes.js          # /api/bi/* endpoints
```

### Why it's safe
Clients never send SQL. They send a **spec** referencing whitelisted field ids
(`{ dimensions, measures, filters, sort, limit }`). The compiler:
- resolves ids against the dataset (unknown id → 400),
- emits column SQL only from the dataset definition (trusted code),
- binds **every** filter value as a `$n` parameter,
- caps dimensions (3), measures (8), filter values (200), and rows (5000),
- runs under a `statement_timeout` (`BI_QUERY_TIMEOUT_MS`, default 15s).

### The hypertoy quirk it bakes in
`hypertoy.facts` is a wide table mixing sales / inventory / targets discriminated
by `record_type`. Every measure declares which record types it needs, and the
compiler emits a per-measure `FILTER (WHERE record_type = $n)`, so e.g. revenue
(sales) and sales_target (targets) can appear in one query correctly. The `WHERE`
also narrows the scan to only the record types in play.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/bi/datasets` | list datasets |
| GET  | `/api/bi/datasets/:id` | semantic model (dimensions + measures) |
| POST | `/api/bi/query` | run a spec → `{ rows, columns, rowCount, duration, sql }` |
| GET  | `/api/bi/datasets/:id/values/:fieldId?search=` | distinct values for filter pickers |
| GET/POST/GET/PUT/DELETE | `/api/bi/dashboards[/:id]` | dashboard CRUD |

Query request body:
```json
{
  "dataset": "hypertoy",
  "measures": ["revenue", "profit", "margin_pct"],
  "dimensions": ["store"],
  "filters": [{ "field": "date_year", "op": "eq", "values": [2025] }],
  "sort": { "field": "revenue", "dir": "desc" },
  "limit": 10
}
```

## Client

Route `/bi` (and `/bi/:datasetId`), lazy-loaded (`src/pages/BIPage.tsx`).
Dependency-free — hand-rolled SVG charts, no charting library added.

```
src/components/bi/
├── BIShell.tsx            # header, Explore/Dashboards tabs, theme toggle
├── Explorer/              # field panel + filters + chart-type picker + Save
├── Dashboards/            # dashboard list, view (cross-filter), Widget, SaveWidgetModal
├── charts/ChartRenderer.tsx  # kpi / bar / grouped-bar / line / pie / table (SVG)
├── useBiQuery.ts, chartTypes.ts, format.ts, labels.ts
└── ...
src/services/biService.ts  # typed API client
src/types/bi.ts            # shared types
```

Cross-filtering: clicking a category (bar, pie slice, table row) on any dashboard
widget sets a dashboard-wide filter applied to all widgets.

## Adding a dataset
1. Add `bi/datasets/<name>.dataset.js` (copy hypertoy; define schema, joins,
   dimensions, measures).
2. Register it in the `DATASETS` map + its pool in `bi/routes/bi.routes.js`.
3. It appears automatically at `/api/bi/datasets` and `/bi/<name>`.

## Config
- `BI_QUERY_TIMEOUT_MS` — per-query statement timeout (default 15000).
- Uses the hypertoy pool (`services/db.hypertoy.js`) for data and the main
  platform pool (`services/db.pg.js`) for the `bi_dashboards` table (created
  lazily, no migration needed).
