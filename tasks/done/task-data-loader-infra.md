# Task: Data Loader Infrastructure — Auto Reload + Monitoring Dashboard

## Background

Zer4U's data pipeline currently works as a one-time POC: Qlik exports CSV files to Google Cloud Storage (`aspect-clients-data/zer4u/`), and we run `reload-zer4u-data.js` manually to load them into the `zer4u` PostgreSQL schema. This drops the entire schema and recreates it, causing downtime.

We need two things:
1. **Zer4U-specific:** Automated daily reload with zero downtime (shadow schema swap)
2. **Platform infrastructure:** A **Data Loader** dashboard page — generic monitoring UI for any data-connected agent that loads from CSV files. The reload logic itself is client-specific (zer4u has its own scripts, a future client like yohananhuf will have its own), but the dashboard screens (source files, live progress, logs, history) are shared infrastructure that works for any CSV-loading process.

### Design Principle: Generic Dashboard, Client-Specific Loaders

```
┌──────────────────────────────────────────────┐
│         Data Loader Dashboard (generic)       │  ← shared UI infrastructure
│  Source Files | Live Progress | Run History   │     works for any client
├──────────────────────────────────────────────┤
│         DataReloadService (generic)           │  ← shared orchestration shell
│  state tracking, SSE streaming, DB logging    │     client-agnostic
├──────────────────────────────────────────────┤
│      Client Reload Logic (per-client)         │  ← zer4u, yohananhuf, etc.
│  zer4u: GCS CSV → COPY → indexes → views     │     each client has its own
│  future: could be API, S3, different schema   │     reload steps & scripts
└──────────────────────────────────────────────┘
```

The `DataReloadService` receives a **reload function** per schema — it doesn't know or care about the internals (GCS, COPY, indexes). It just runs it, tracks state, streams logs, and persists history. Each client registers its reload logic.

### What Already Exists

- **GCS bucket:** `aspect-clients-data` — Qlik exports land in `zer4u/` folder as CSVs
- **GCS service** (`services/gcs.service.js`) — `listCSVFiles(folder)` returns `{ name, basename, size, created, updated }` per file
- **Scripts (all in `scripts/`):**
  - `scan-csv-files.js` — analyzes CSV structure, saves to `data/zer4u-schema-analysis.json`
  - `create-zer4u-schema.js` — creates tables from analysis JSON (drops + recreates)
  - `load-csv-to-db-copy.js` — bulk loads via PostgreSQL COPY (fast path, progress tracking)
  - `create-zer4u-indexes-v2.js` — creates expression indexes + 3 helper functions
  - `create-materialized-views.js` — creates `mv_sales_by_store`, `mv_sales_by_customer`, `mv_sales_by_product`
  - `db/migrations/run-017-zer4u-date-materialized-views.js` — creates `mv_sales_by_year`, `mv_sales_by_month`, `mv_sales_by_store_month`
  - `reload-zer4u-data.js` — orchestrator that calls clean → create → load (but NOT indexes or materialized views)
- **Database schema:** `zer4u` with ~8 tables, 6 materialized views, 15+ indexes, 3 helper functions
- **Dashboard infrastructure:** `DashboardLayout` with sidebar nav, conditional items. Pages registered in `DashboardPage.tsx` routes. Admin APIs in `server.js` under `/api/admin/*`.
- **Agent config `database` field:** Currently only `aspect` and `zer4u` configs have `database: { schema: 'zer4u' }`. This is how the system knows an agent is data-connected.

### Data-Connected Agents

An agent is "data-connected" when its config has a `database.schema` field. Currently:

| Agent | Schema | Data Source | Status |
|-------|--------|-------------|--------|
| Aspect Insight | `zer4u` | GCS CSVs from Qlik | Active |
| Zer4U | `zer4u` | GCS CSVs from Qlik | Active |
| Yohananhuf | `yohananhuf` | TBD (Qlik → GCS) | Future — requires new agent setup |

Both Aspect and Zer4U share the same `zer4u` schema. The Data Loader dashboard should appear for both. Future data-connected agents (like yohananhuf) will get it automatically once they have `database.schema` in their config.

---

## Part 1: Zero-Downtime Reload Engine (Zer4U-Specific)

### Strategy: Shadow Schema Swap

Instead of `DROP zer4u → recreate zer4u`, we:

1. Create a parallel `zer4u_new` schema
2. Load all data into `zer4u_new`
3. Create indexes + materialized views on `zer4u_new`
4. Atomic swap: `zer4u → zer4u_old`, `zer4u_new → zer4u`
5. Drop `zer4u_old`

The agent queries `zer4u.*` throughout — it only sees the swap as an instant schema rename.

### Step 1: Parameterize existing scripts

The existing scripts hardcode `zer4u` as the schema name. Add an optional `schemaName` parameter to the exported functions:

| Script | Exported Function | Change |
|--------|-------------------|--------|
| `create-zer4u-schema.js` | `createSchema(schemaName?)` | Default `'zer4u'`, use param in all SQL |
| `load-csv-to-db-copy.js` | `loadAllCSVFiles(schemaName?, onProgress?)` | Default `'zer4u'`, add progress callback |
| `create-zer4u-indexes-v2.js` | `createIndexes(schemaName?)` | Default `'zer4u'`, use param in all SQL |
| `create-materialized-views.js` | `createAllViews(schemaName?)` | Default `'zer4u'`, consolidate all 6 views |

**Important:** `load-csv-to-db-copy.js` already tracks per-file progress internally (row counts, throughput). Add an `onProgress(event)` callback so `DataReloadService` can capture these events without parsing console output.

### Step 2: Create Zer4U reload function

```js
// scripts/reload-zer4u-zero-downtime.js (or services/reloaders/zer4u.reloader.js)

async function reloadZer4u(targetSchema, emitLog) {
  // 1. emitLog('scanning', 'Listing CSV files from GCS...')
  //    List + analyze CSV files from GCS bucket zer4u/ folder
  //
  // 2. emitLog('creating_schema', 'Creating tables...')
  //    createSchema(targetSchema)  — creates tables in {schema}_new
  //
  // 3. emitLog('loading_data', 'Loading sales.csv...')
  //    loadAllCSVFiles(targetSchema, onProgress)  — COPY each file
  //    emitLog per file start/complete with row counts
  //
  // 4. emitLog('creating_indexes', 'Creating helper functions + indexes...')
  //    createIndexes(targetSchema)  — 3 functions + 15 indexes
  //
  // 5. emitLog('creating_views', 'Creating materialized views...')
  //    createAllViews(targetSchema)  — all 6 materialized views
  //
  // Returns: { totalFiles, totalRows, fileResults: [...] }
}
```

This function knows **nothing** about the shadow swap — it just loads into whatever schema name it's given. The generic `DataReloadService` handles the swap wrapper.

### Step 3: Scheduling

**Approach: Admin endpoint + Cloud Scheduler**

- `POST /api/admin/data-loader/:schema/reload` endpoint (part of generic infra, see Part 3)
- Cloud Scheduler hits this daily at 03:00 AM Israel time
- Returns immediately with `{ runId, status: 'running' }` — reload runs in background
- If already running, returns `409 Conflict`

---

## Part 2: DataReloadService (Generic Infrastructure)

This is the **generic orchestration service** — shared across all data-connected agents. It doesn't know about GCS, COPY, or zer4u-specific details. It provides:

- State tracking (current run, step, progress)
- SSE log streaming to dashboard
- DB persistence of run history
- Shadow schema swap wrapper
- Client reload function registry

### Service Design

```js
class DataReloadService {
  // ─── Registry: each schema registers its reload logic ───────
  reloaders = {};  // { 'zer4u': { reloadFn, getSourceFiles, gcsFolderPrefix } }

  registerReloader(schemaName, config) {
    // config.reloadFn(targetSchema, emitLog) → Promise<result>
    // config.getSourceFiles() → Promise<GCSFile[]>  (optional — for file-based loaders)
    // config.gcsFolderPrefix → string (e.g. 'zer4u/')
  }

  // ─── State ──────────────────────────────────────────────────
  currentRuns = {};  // { 'zer4u': { id, status, step, ... } }

  // ─── Public API (called by admin endpoints) ─────────────────
  async startReload(schemaName, triggeredBy)  // → run ID; rejects if already running
  async getStatus(schemaName)                 // → current run or last completed
  async getHistory(schemaName, limit)         // → past runs from DB
  async getSourceFiles(schemaName)            // → delegates to registered reloader
  subscribeLogs(schemaName, callback)         // → returns unsubscribe fn

  // ─── Internal: shadow swap wrapper ──────────────────────────
  async _executeReload(runId, schemaName) {
    const reloader = this.reloaders[schemaName];
    const shadowSchema = `${schemaName}_new`;

    try {
      // 1. Create shadow schema
      await db.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`);
      await db.query(`CREATE SCHEMA ${shadowSchema}`);

      // 2. Run client-specific reload into shadow schema
      const result = await reloader.reloadFn(shadowSchema, this._emitLog.bind(this, runId));

      // 3. Atomic swap
      this._emitLog(runId, 'swapping', 'Swapping schemas...');
      await db.query(`
        BEGIN;
          DROP SCHEMA IF EXISTS ${schemaName}_old CASCADE;
          ALTER SCHEMA ${schemaName} RENAME TO ${schemaName}_old;
          ALTER SCHEMA ${shadowSchema} RENAME TO ${schemaName};
        COMMIT;
      `);

      // 4. Cleanup
      this._emitLog(runId, 'cleanup', 'Dropping old schema...');
      await db.query(`DROP SCHEMA IF EXISTS ${schemaName}_old CASCADE`);

      // 5. Mark complete
      this._updateRun(runId, { status: 'completed' });

    } catch (err) {
      // On ANY error: drop shadow schema, live schema untouched
      await db.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`).catch(() => {});
      this._updateRun(runId, { status: 'failed', error: err.message });
    }
  }
}
```

### Structured Log Events

The service emits structured events (not console.log strings). Each event:
```js
{ timestamp, level, step, message, data? }
// data examples:
//   step='loading_data': { file: 'sales.csv', rowsLoaded: 1234567, totalFiles: 8, filesCompleted: 3 }
//   step='creating_indexes': { indexName: 'idx_sales_date_parsed', indexNumber: 5, totalIndexes: 15 }
```

Events are:
- Pushed to SSE subscribers in real-time (for dashboard)
- Accumulated in memory during the run
- Persisted to DB `data_reload_runs.log_entries` on completion

### Database table for reload history

```sql
CREATE TABLE public.data_reload_runs (
  id             SERIAL PRIMARY KEY,
  schema_name    TEXT NOT NULL,           -- 'zer4u', 'yohananhuf', etc.
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  triggered_by   TEXT NOT NULL,           -- 'manual' | 'scheduler'
  step           TEXT,                    -- current step name

  -- Timing
  started_at     TIMESTAMP DEFAULT NOW(),
  completed_at   TIMESTAMP,

  -- Progress
  total_files    INTEGER,
  files_loaded   INTEGER DEFAULT 0,
  total_rows     BIGINT DEFAULT 0,

  -- Per-file detail: [{ file, status, rows, durationMs }]
  file_progress  JSONB DEFAULT '[]'::jsonb,

  -- Logs: array of { timestamp, level, step, message, data? }
  log_entries    JSONB DEFAULT '[]'::jsonb,

  -- Error
  error_message  TEXT,
  error_step     TEXT                     -- which step failed
);

CREATE INDEX idx_data_reload_runs_schema ON public.data_reload_runs(schema_name, started_at DESC);
```

### Registration at Server Startup

```js
// In server.js init:
const dataReloadService = new DataReloadService(pool);

// Register zer4u reloader
dataReloadService.registerReloader('zer4u', {
  reloadFn: require('./scripts/reload-zer4u-zero-downtime').reloadZer4u,
  gcsFolderPrefix: 'zer4u/',
});

// Future: register yohananhuf reloader
// dataReloadService.registerReloader('yohananhuf', {
//   reloadFn: require('./scripts/reload-yohananhuf').reloadYohananhuf,
//   gcsFolderPrefix: 'yohananhuf/',
// });
```

---

## Part 3: Server API Endpoints (Generic)

All under `/api/admin/data-loader/`. Work for any registered schema.

```
GET  /api/admin/data-loader/:schema/files       → list source files (CSV from GCS) with metadata
GET  /api/admin/data-loader/:schema/status       → current run or last completed run
GET  /api/admin/data-loader/:schema/history      → past runs (query: ?limit=20)
POST /api/admin/data-loader/:schema/reload       → trigger new reload (body: { triggeredBy? })
GET  /api/admin/data-loader/:schema/logs         → SSE stream of live log events
GET  /api/admin/data-loader/:schema/runs/:id/log → log entries for a specific historical run
```

### SSE Log Streaming (`/logs`)

Same SSE pattern used by chat streaming. Event types:

```
event: log
data: {"timestamp":"...","level":"info","step":"loading_data","message":"Loading sales.csv..."}

event: progress
data: {"step":"loading_data","filesCompleted":2,"totalFiles":8,"currentFile":"customers.csv","currentFileRows":234567,"totalRows":10245891}

event: status
data: {"status":"running","step":"loading_data"}

event: complete
data: {"status":"completed","duration":754000,"totalRows":31200000}
```

On connect: if no reload is running, sends last status event + closes (or stays open waiting). If running, replays recent log buffer then streams live. `EventSource` handles reconnection automatically.

---

## Part 4: Data Loader Dashboard Page (Generic UI)

A new dashboard page at `/:agent/dashboard/data-loader`. **Shown for all data-connected agents** — any agent whose config has `database.schema`. Currently that's Aspect and Zer4U (both show zer4u schema data). Future agents like yohananhuf will get this page automatically.

### Visibility Condition

Uses the **same condition** as Query Optimizer: `!!config.database?.schema`. The `schema` value is passed to all API calls so the server knows which reloader to use.

### UI Layout — Three Sections

```
┌─────────────────────────────────────────────────────────────────────┐
│  Data Loader                                            [▶ Reload] │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─── Source Files ──────────────────────────────────────────────┐  │
│  │                                                               │  │
│  │  File              Table        Size      Last Modified       │  │
│  │  ─────────────────────────────────────────────────────────    │  │
│  │  מכירות.csv        sales        1.2 GB    25/03/2026 02:15   │  │
│  │  מלאי.csv          inventory    890 MB    25/03/2026 02:15   │  │
│  │  לקוחות.csv        customers    120 MB    25/03/2026 02:15   │  │
│  │  פריטים.csv        items        3.2 MB    25/03/2026 02:15   │  │
│  │  חנויות.csv        stores       45 KB     25/03/2026 02:15   │  │
│  │  ...                                                          │  │
│  │                                                               │  │
│  │  During a reload, an extra Status column appears:             │  │
│  │  ✅ 9.4M rows (2m 31s) | ⏳ Loading (1.2M rows) | ○ Pending │  │
│  │                                                               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─── Current Run ──────────────────────────────────────────────┐  │
│  │                                                               │  │
│  │  Status: ● Running          Step: Loading Data (3/8 files)   │  │
│  │  Started: 03:00:12          Elapsed: 4m 32s (ticking)        │  │
│  │  Triggered by: scheduler    Rows loaded: 10,245,891          │  │
│  │                                                               │  │
│  │  ┌─ Progress ───────────────────────────────────────────┐    │  │
│  │  │ ████████████████████░░░░░░░░░░░░░░░  38%  3/8 files │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  │                                                               │  │
│  │  ┌─ Live Log ───────────────────────────────────────────┐    │  │
│  │  │ 03:00:12  [start]    Starting reload for zer4u       │    │  │
│  │  │ 03:00:12  [scan]     Found 8 CSV files (2.3 GB)     │    │  │
│  │  │ 03:00:13  [schema]   Created 8 tables in zer4u_new  │    │  │
│  │  │ 03:00:14  [load]     Loading sales.csv...            │    │  │
│  │  │ 03:00:14  [load]     ⏳ 500,000 rows (125K/s)       │    │  │
│  │  │ 03:02:45  [load]     ✅ sales.csv — 9.4M rows       │    │  │
│  │  │ 03:02:46  [load]     Loading inventory.csv...        │    │  │
│  │  │ 03:04:31  [load]     ✅ inventory — 19.8M rows      │    │  │
│  │  │ 03:04:32  [load]     Loading customers.csv...        │    │  │
│  │  │ 03:04:32  [load]     ⏳ 234,567 rows (98K/s)        │    │  │
│  │  │                                              ▼ auto  │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  │                                                               │  │
│  │  When idle: shows last completed run summary instead.        │  │
│  │  If failed: error message + failed step shown prominently.   │  │
│  │                                                               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─── Run History ──────────────────────────────────────────────┐  │
│  │                                                               │  │
│  │  Date              Duration  Status     Files  Rows     By   │  │
│  │  ──────────────────────────────────────────────────────────   │  │
│  │  25/03/2026 03:00  12m 34s   ✅ Done    8/8   31.2M   sched │  │
│  │  24/03/2026 03:00  11m 58s   ✅ Done    8/8   31.1M   sched │  │
│  │  23/03/2026 15:42  —         ❌ Failed  3/8   10.2M   manual│  │
│  │  23/03/2026 03:00  12m 01s   ✅ Done    8/8   31.1M   sched │  │
│  │                                                    [View Log]│  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Section 1: Source Files

Shows the CSV files currently in GCS for this schema's folder. Tells the admin "what data is available" and "when Qlik last exported".

| Column | Source | Notes |
|--------|--------|-------|
| File | `gcsService.listCSVFiles(folderPrefix)` → `basename` | Original filename (often Hebrew) |
| Table | Hebrew-to-English table name mapping | e.g. `מכירות.csv` → `sales` |
| Size | `file.size` | Human-readable (KB/MB/GB) |
| Last Modified | `file.updated` | ISO timestamp from GCS — when Qlik last exported |
| Status | Cross-reference with `currentRun.file_progress` | Only shown during active reload |

**During an active reload** the Status column appears:
- `○ Pending` — not yet started
- `⏳ Loading... (1.2M rows)` — live row count updates
- `✅ 9,412,345 rows (2m 31s)` — completed with stats
- `❌ Error: connection timeout` — failed with reason

**When idle:** Status column either hidden or shows last run result per file from the most recent `file_progress`.

### Section 2: Current / Last Run

**When running** — live status:
- Status badge: `● Running` (green pulsing dot)
- Current step in plain English: `Scanning files` → `Creating tables` → `Loading data (3/8 files)` → `Creating indexes (5/15)` → `Creating views (2/6)` → `Swapping schemas` → `Cleanup`
- Start time + elapsed time (ticking)
- Triggered by: `scheduler` or `manual`
- Aggregate stats: total rows, files completed/total
- **Progress bar** — step-based:

| Step | Progress % |
|------|-----------|
| `scanning` | 5% |
| `creating_schema` | 10% |
| `loading_data` | 10% + (files_loaded/total_files * 70%) = 10-80% |
| `creating_indexes` | 80-90% |
| `creating_views` | 90-95% |
| `swapping` | 95-98% |
| `cleanup` | 98-100% |
| `completed` | 100% |

- **Live Log panel** — terminal-style, dark bg, monospace. Lines stream via SSE, auto-scrolls. Step badges color-coded.

**When idle** — shows last completed run:
- Status badge: `✅ Completed` or `❌ Failed`
- Completed time + total duration
- Final stats
- Collapsed log (expandable)
- If failed: error + failed step prominently shown

### Section 3: Run History

Table of past runs (last 20). Each row expandable to show full log.

| Column | Source |
|--------|--------|
| Date | `started_at` |
| Duration | `completed_at - started_at` |
| Status | `✅ Done` / `❌ Failed` |
| Files | `files_loaded / total_files` |
| Rows | `total_rows` (locale-formatted) |
| Triggered By | `triggered_by` |
| Actions | `[View Log]` — shows saved `log_entries` in same LogViewer |

### Reload Button

Top-right: `[▶ Reload Now]`
- When idle: primary button, enabled
- When running: disabled, shows `● Reloading...`
- On click: confirmation dialog: "Start a full data reload for {schema}? The live agent will not be affected."
- On confirm: `POST /api/admin/data-loader/:schema/reload` → page transitions to live view

---

## Part 5: Client Components & Wiring

### Files to Create

```
src/components/dashboard/DataLoaderPage/
├── DataLoaderPage.tsx            — main page, orchestrates sections + SSE connection
├── DataLoaderPage.module.css     — styles
├── SourceFilesTable.tsx          — Section 1: GCS files with live status overlay
├── CurrentRunPanel.tsx           — Section 2: live status, progress bar, log viewer
├── RunHistoryTable.tsx           — Section 3: past runs table with expandable logs
├── LogViewer.tsx                 — shared terminal-style log viewer (live + historical)
├── ProgressBar.tsx               — step-aware progress bar with percentage
└── StatusBadge.tsx               — reload status badge (running/completed/failed)
```

### Dashboard Wiring

**DashboardLayout.tsx** — add nav item:
```ts
const DATA_LOADER_ITEM = {
  path: 'data-loader',
  label: 'Data Loader',
  icon: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',  // download icon
};

// Add alongside query optimizer — both use same condition:
...(showQueryOptimizer ? [QUERY_OPTIMIZER_ITEM, DATA_LOADER_ITEM] : []),
```

**DashboardPage.tsx** — add route:
```tsx
{showQueryOptimizer && (
  <Route
    path="data-loader"
    element={<DataLoaderPage agentName={config.agentName} baseURL={config.baseURL} schemaName={config.database!.schema} />}
  />
)}
```

### DataLoaderPage.tsx — Main Orchestrator

```tsx
interface DataLoaderPageProps {
  agentName: string;
  baseURL: string;
  schemaName: string;   // e.g. 'zer4u' — passed to all API calls
}

// State:
//   sourceFiles: GCSFile[]         — from GET /files
//   currentRun: ReloadRun | null   — from GET /status
//   history: ReloadRun[]           — from GET /history
//   liveLogs: LogEntry[]           — accumulated from SSE
//   isReloading: boolean           — derived from currentRun?.status === 'running'

// On mount:
//   1. Fetch source files, current status, history (parallel)
//   2. If status is 'running', connect SSE to /logs
//   3. On SSE 'progress' events → update currentRun + sourceFiles status overlay
//   4. On SSE 'complete' event → refresh history + source files

// Reload button:
//   POST /reload → set isReloading → connect SSE → live updates flow in
```

---

## Out of Scope

- Incremental/delta loading (always full reload for now)
- Data validation / comparison between old and new schemas
- Slack/email notifications (structure for it, but don't implement)
- Schema change detection (if Qlik adds/removes columns, handle manually)
- Per-table selective reload (always reloads all files)
- Abort/cancel a running reload
- Yohananhuf agent setup (separate task — but note: will need a new agent created as a data-connected agent with its own schema, reloader, GCS folder, and Qlik export query)

---

## Files Touched — Complete List

### Server

| File | Action |
|------|--------|
| `services/data-reload.service.js` | **Create** — generic orchestration: state, SSE, DB logging, shadow swap, reloader registry |
| `scripts/reload-zer4u-zero-downtime.js` | **Create** — zer4u-specific reload function (scan + schema + load + indexes + views) |
| `scripts/create-zer4u-schema.js` | **Modify** — add optional `schemaName` parameter |
| `scripts/load-csv-to-db-copy.js` | **Modify** — add optional `schemaName` parameter + `onProgress` callback |
| `scripts/create-zer4u-indexes-v2.js` | **Modify** — add optional `schemaName` parameter |
| `scripts/create-materialized-views.js` | **Modify** — add optional `schemaName` parameter, consolidate all 6 views |
| `server.js` | **Modify** — add 6 endpoints under `/api/admin/data-loader/`, register zer4u reloader |
| `db/migrations/run-0XX-data-reload-runs.js` | **Create** — migration for `data_reload_runs` table |

### Client

| File | Action |
|------|--------|
| `components/dashboard/DataLoaderPage/DataLoaderPage.tsx` | **Create** |
| `components/dashboard/DataLoaderPage/DataLoaderPage.module.css` | **Create** |
| `components/dashboard/DataLoaderPage/SourceFilesTable.tsx` | **Create** |
| `components/dashboard/DataLoaderPage/CurrentRunPanel.tsx` | **Create** |
| `components/dashboard/DataLoaderPage/RunHistoryTable.tsx` | **Create** |
| `components/dashboard/DataLoaderPage/LogViewer.tsx` | **Create** |
| `components/dashboard/DataLoaderPage/ProgressBar.tsx` | **Create** |
| `components/dashboard/DataLoaderPage/StatusBadge.tsx` | **Create** |
| `components/dashboard/DashboardLayout/DashboardLayout.tsx` | **Modify** — add Data Loader nav item |
| `pages/DashboardPage.tsx` | **Modify** — add DataLoaderPage route |

---

## Acceptance Criteria

### Reload Engine (Zer4U)
- [ ] `node scripts/reload-zer4u-zero-downtime.js` loads all data into shadow schema, swaps atomically, drops old
- [ ] During reload, live agent (`/zer4u`) answers questions without errors
- [ ] All 6 materialized views recreated after each reload
- [ ] All 15+ indexes recreated after each reload
- [ ] Helper functions exist in the new schema
- [ ] Failure during any step does NOT affect the live schema (shadow dropped on error)
- [ ] `POST /api/admin/data-loader/zer4u/reload` triggers a reload and returns immediately
- [ ] Returns 409 if a reload is already running
- [ ] Reload runs daily via Cloud Scheduler at 03:00 AM Israel time

### DataReloadService (Generic)
- [ ] Reloader registry pattern works — zer4u registered at startup
- [ ] Shadow schema swap is handled generically (works for any schema name)
- [ ] Run history persisted to `data_reload_runs` table
- [ ] SSE streaming works for live log events
- [ ] Adding a new client (future yohananhuf) only requires writing a reloadFn + registering it

### Dashboard (Generic UI)
- [ ] Source Files table shows GCS CSV files with name, table, size, last modified
- [ ] During reload, file statuses update live (pending → loading with row count → loaded)
- [ ] Current Run panel shows live progress bar, step name, elapsed time, row count
- [ ] Live log streams entries in real-time via SSE (auto-scrolls, terminal style)
- [ ] When idle, Current Run shows last completed run summary
- [ ] Run History shows past 20 runs with duration, status, files, rows, triggered by
- [ ] Clicking "View Log" on a historical run shows its saved logs
- [ ] "Reload Now" button triggers reload with confirmation dialog
- [ ] "Reload Now" disabled while running
- [ ] Page appears in sidebar for Aspect and Zer4U dashboards (any agent with `database.schema`)

## How to Test

1. Open `/:agent/dashboard/data-loader` for both Aspect and Zer4U — should see Source Files with GCS file metadata
2. Click "Reload Now" → confirm → Current Run panel activates with live progress
3. Watch the log viewer — log lines stream in real-time
4. Watch Source Files table — statuses update as each file loads
5. Watch progress bar — advances through steps (scan → tables → load → indexes → views → swap)
6. After completion — summary shown, History updated, Source Files show final row counts
7. Click "View Log" on history entry — same log format
8. While reload runs, open `/zer4u` and ask a question — should respond normally
9. Kill server mid-reload — on restart, `/zer4u` still works (live schema untouched, shadow dropped)
