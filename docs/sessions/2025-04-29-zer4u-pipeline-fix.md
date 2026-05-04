# Zer4U Data Pipeline Fix — Session 2025-04-29

Task #582. Full rewrite of the import pipeline to support typed columns (DATE, INTEGER, NUMERIC)
with zero-downtime schema swap. All bugs discovered and fixed during local end-to-end testing.

---

## What changed

### `scripts/load-csv-to-db-copy.js`

| Fix | Root cause |
|-----|-----------|
| Added `splitCSVLines(buffer)` — quote-aware line splitter | `\n` inside quoted fields was treated as row delimiter; broke חנויות.csv |
| Strip `\r` at line boundary | Windows CRLF files left `\r` inside last field value → PostgreSQL "unquoted newline" error |
| Fixed `parseCSVLine` — break after last quoted field | Outer `while` re-entered after closing quote, pushing a phantom empty field → "extra data after last expected column" on מכירות.csv (55 fields instead of 54) |
| `SET statement_timeout = 0` before each COPY | DATABASE-level `statement_timeout = 30000ms` (ALTER DATABASE) killed COPY at ~30s / ~3M rows |
| Destroy upstream streams in `abort()` | Buffered chunk reaching `copyStream` after pg connection died → pg-copy-streams threw synchronous TypeError → server crash (uncaught exception) |
| Added `57P01` + `"terminating connection"` to `isRetryable` | Cloud SQL occasionally sends `admin_shutdown` (pg_terminate_backend); was not retried |
| Heartbeat, finalization timer, watchdog timers | Visibility into long-running COPYs |

### `scripts/create-materialized-views.js`

| Fix | Root cause |
|-----|-----------|
| Removed all `!= ''` conditions from MVs 1–7 | `revenue`, `cost`, `quantity` columns are now NUMERIC; `revenue != ''` fails at parse time with "invalid input syntax for type numeric" |

### `db/migrations/`

- `024_add_quality_stats.sql` + `run-024-add-quality-stats.js` — adds `quality_stats JSONB` column to `data_reload_runs`

### `scripts/reload-zer4u-zero-downtime.js`

- `file_progress` handler: shows "waiting for PostgreSQL commit (Ns)..." during finalization phase

---

## Key PostgreSQL findings

- `statement_timeout = 30000` was set at DATABASE level (`ALTER DATABASE`), not just session level.
  Session `SET statement_timeout = 0` overrides it correctly — verified before/after.
- Error code `57014` = query_canceled (statement/lock timeout).
- Error code `57P01` = admin_shutdown = `pg_terminate_backend()` — Cloud SQL connection recycling.
- COPY FROM STDIN with typed columns: empty string `''` = NULL in PostgreSQL COPY protocol.
  So `NULL ''` in COPY command means empty string becomes NULL — correct for typed columns.

---

## Import performance (after fixes, local dev)

| File | Rows | Duration |
|------|------|----------|
| LinkTable.csv | 26.4M | 231s |
| מכירות.csv | 9.9M | 1097s (~18 min) |
| SHOROT_KBLA.csv | 7.7M | ~120s |

---

## Cloud Scheduler

Six jobs paused manually on 2025-04-30 while debugging:
- `zer4u-ensure-indexed` (every 15 min)
- `zer4u-ensure-loaded-7h` through `zer4u-ensure-loaded-11h`

Re-enable when pipeline is confirmed working on prod:
```
gcloud scheduler jobs resume <job-name> --project=aspect-agents --location=europe-west1
```

---

## Two-phase reload process

### Phase 1 — Import (loadZer4u)
Goal: get all CSV data into `zer4u_new` cleanly, with correct types.

1. Scan GCS → read CSV headers → build schema definitions
2. Create UNLOGGED tables in `zer4u_new` (shadow schema)
3. COPY each CSV into its table with inline type conversion:
   - DATE columns: DD/MM/YYYY → ISO YYYY-MM-DD
   - INTEGER / NUMERIC columns: bad values → NULL (empty string in COPY = NULL)
   - TEXT columns: pass through unchanged
4. Report quality stats: which columns had values nullified

**Success criteria for Phase 1:**
- 30/30 files loaded, 0 file errors
- Date range on sales makes sense (e.g. 2019–2026)
- NULL counts on key columns (sale_date, revenue, quantity, store_id, customer_id) are within expected bounds
- Quality report: only known bad data is nullified (not systematic failures)

### Phase 2 — Index + Swap (indexZer4u)
Goal: make `zer4u_new` production-ready and swap it atomically.

1. Copy index DDL from live `zer4u` schema (if exists) → create same indexes on `zer4u_new`
   - Falls back to bootstrap index list if `zer4u` doesn't exist yet
2. Create helper SQL functions: `parse_date_ddmmyyyy(text)`, `parse_date_ddmmyyyy(date)` (identity),
   `to_int_safe(text)`, `to_int_safe(integer)` (identity)
3. Create materialized views (parallel): mv_sales_by_store, mv_sales_by_customer,
   mv_sales_by_product, mv_sales_by_year, mv_sales_by_month, mv_sales_by_store_month,
   mv_sales_by_day, mv_inventory_by_item
4. DataReloadService does the atomic schema swap: DROP zer4u → RENAME zer4u_new → zer4u

**NOTE:** Phase 1 must pass perfectly before touching Phase 2.

---

## Run 122 results (2026-04-30, local dev against Cloud SQL)

Phase 1 completed: **30/30 files, 68,998,830 total rows, 23m 50s**

| Table | Rows | Size | Duration |
|-------|------|------|----------|
| sales | 9,937,410 | 4.3 GB | 755s |
| inventory | 22,158,602 | 2.0 GB | 300s |
| linktable | 26,434,079 | 2.6 GB | 264s |
| shorot_kbla | 7,686,268 | 688 MB | 88s |
| customers | 1,417,382 | 108 MB | 7.5s |
| … (25 more) | | | |

Quality: 19 values nullified across 1 table — pending investigation.
Phase 2 was cancelled manually to focus on verifying Phase 1 first.

---

## Status

- Phase 1 fixes done and confirmed working (run 122)
- Phase 2 (indexing + MVs) not yet confirmed — to be tested separately
- Cloud Scheduler jobs paused — re-enable after full Phase 2 confirmation on prod
- **NOT yet deployed to Cloud Run**
