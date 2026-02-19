# Task: Query Optimizer (Admin Dashboard)

## Goal
Provide admins visibility into slow queries and manual tools to analyze and optimize them via the admin dashboard.

## Problem
- Users ask unpredictable questions
- Some queries run slow due to missing indexes
- Need visibility into which queries are slow
- Need controlled way to analyze and fix

## Solution: Slow Query Logger + Admin Query Optimizer

**Key principle:** Nothing automatic. Admin sees slow queries, analyzes them, decides to optimize.

### How It Works

```
User Question → SQL Executed → Duration > 5s?
                                    ↓ YES
                          [Log to slow_queries table]
                                    ↓
                          Admin sees in dashboard
                                    ↓
                          Admin clicks "Analyze"
                                    ↓
                          System runs EXPLAIN → shows recommendation
                                    ↓
                          Admin clicks "Execute"
                                    ↓
                          Job added to optimization_jobs table
                                    ↓
                          Admin can track status (poll/refresh)
```

---

## Implementation

### 1. Slow Query Logging (Server-Side)

#### Database Table
```sql
-- Only logs queries that exceed threshold
CREATE TABLE public.slow_queries (
  id SERIAL PRIMARY KEY,
  agent_name TEXT NOT NULL,           -- 'aspect', 'zer4u', etc.
  schema_name TEXT,                   -- 'zer4u' (for DB-connected agents)
  question TEXT,                      -- Original user question
  sql TEXT NOT NULL,                  -- Generated SQL
  duration_ms INTEGER NOT NULL,       -- How long it took
  rows_returned INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  analyzed_at TIMESTAMP,              -- When admin ran analysis
  recommendation JSONB                -- Filled after analysis
);

CREATE INDEX idx_slow_queries_agent ON public.slow_queries(agent_name);
CREATE INDEX idx_slow_queries_created ON public.slow_queries(created_at DESC);
```

#### Modify data-query.service.js
```javascript
// After query execution, if slow:
if (duration > SLOW_QUERY_THRESHOLD_MS) {
  await this.logSlowQuery({
    agentName: 'aspect',
    schemaName: 'zer4u',
    question,
    sql,
    durationMs: duration,
    rowsReturned: result.rows.length
  });
}
```

#### Config
```bash
SLOW_QUERY_THRESHOLD_MS=5000   # Log queries slower than 5s
```

---

### 2. Optimization Jobs Table

```sql
-- Tracks index creation jobs triggered by admin
CREATE TABLE public.optimization_jobs (
  id SERIAL PRIMARY KEY,
  slow_query_id INTEGER REFERENCES public.slow_queries(id),
  agent_name TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  job_type TEXT NOT NULL,             -- 'create_index', 'create_mv', etc.
  description TEXT,                   -- "Create index on sales(store, date)"
  sql TEXT NOT NULL,                  -- The CREATE INDEX statement
  status TEXT DEFAULT 'pending',      -- pending/running/completed/failed
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by TEXT                     -- Admin username
);

CREATE INDEX idx_optimization_jobs_status ON public.optimization_jobs(status);
```

---

### 3. Admin Dashboard: Query Optimizer

#### Location
`/admin/query-optimizer`

**Only visible for agents with DB connection** (check agent config for `schema` or `database` field).
Currently: `aspect` agent only.

#### UI Sections

##### Section 1: Slow Queries Table
| Column | Description |
|--------|-------------|
| Time | When query ran |
| Agent | aspect |
| Question | "מכירות חנות 15 בחודש האחרון" |
| Duration | 8.2s |
| SQL | `SELECT ... FROM sales ...` (expandable) |
| Status | ⚪ New / 🔍 Analyzed / ✅ Optimized |
| Actions | [Analyze] [Dismiss] |

##### Section 2: Analysis Panel (after clicking Analyze)
Shows:
- EXPLAIN ANALYZE output
- Detected issue: "Sequential scan on sales (9.4M rows)"
- **Recommendation:** "Create composite index on (store, date)"
- Suggested SQL:
  ```sql
  CREATE INDEX idx_sales_store_date ON zer4u.sales (
    zer4u.to_int_safe("מס.חנות SALES"),
    zer4u.parse_date_ddmmyyyy("תאריך מקורי SALES") DESC
  );
  ```
- [Execute Optimization] button

##### Section 3: Optimization Jobs Table
| Column | Description |
|--------|-------------|
| ID | Job ID |
| Type | create_index |
| Description | "Index on sales(store, date)" |
| Status | 🟡 Running / ✅ Completed / ❌ Failed |
| Started | 14:32:05 |
| Duration | 2m 34s |
| Actions | [View Details] |

**Refresh:** Manual refresh button + optional slow polling (30s)

---

### 4. API Endpoints

```
# Slow Queries
GET  /api/admin/slow-queries              - List slow queries (paginated)
GET  /api/admin/slow-queries/:id          - Get single slow query
POST /api/admin/slow-queries/:id/analyze  - Run EXPLAIN, get recommendation
POST /api/admin/slow-queries/:id/dismiss  - Mark as dismissed

# Optimization Jobs
GET  /api/admin/optimization-jobs         - List all jobs
GET  /api/admin/optimization-jobs/:id     - Get job status
POST /api/admin/optimization-jobs         - Create new job (execute recommendation)
```

---

### 5. Services

#### slow-query.service.js
```javascript
class SlowQueryService {
  // Called by data-query.service when query is slow
  async logSlowQuery({ agentName, schemaName, question, sql, durationMs, rowsReturned }) { }

  // List slow queries for admin
  async getSlowQueries(agentName, options = { limit: 50 }) { }

  // Run EXPLAIN ANALYZE and generate recommendation
  async analyzeQuery(slowQueryId) { }
}
```

#### optimization-job.service.js
```javascript
class OptimizationJobService {
  // Create and execute optimization job
  async createJob({ slowQueryId, jobType, description, sql, createdBy }) { }

  // Get job status
  async getJobStatus(jobId) { }

  // List jobs
  async listJobs(agentName, options = {}) { }

  // Actually run the optimization (called async)
  async executeJob(jobId) { }
}
```

---

### 6. Index Recommendation Logic

When analyzing a slow query:

1. Run `EXPLAIN (ANALYZE, FORMAT JSON)` on the SQL
2. Parse output for sequential scans on tables > 10K rows
3. Extract columns from:
   - WHERE clauses
   - JOIN conditions
   - ORDER BY
4. Generate CREATE INDEX statement using helper functions:
   - `zer4u.parse_date_ddmmyyyy()` for date columns
   - `zer4u.to_int_safe()` for integer casts
   - `zer4u.to_numeric_safe()` for numeric casts
5. Check if similar index already exists
6. Return recommendation with confidence level

---

### 7. React Components

```
/admin/query-optimizer/
├── QueryOptimizerPage.tsx       - Main page
├── SlowQueriesTable.tsx         - List of slow queries
├── QueryAnalysisPanel.tsx       - EXPLAIN output + recommendation
├── OptimizationJobsTable.tsx    - Running/completed jobs
├── JobStatusBadge.tsx           - Status indicator
└── SqlPreview.tsx               - Expandable SQL display
```

---

### 8. Agent Configuration

For this feature to appear in admin, agent config needs:

```typescript
// agents/aspect.config.ts
export const aspectConfig = {
  name: 'aspect',
  // ... other config
  database: {
    schema: 'zer4u',        // Enables Query Optimizer in admin
    enableQueryLogging: true
  }
};
```

Generic check in admin:
```javascript
const showQueryOptimizer = agent.database?.schema != null;
```

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `services/slow-query.service.js` | Create |
| `services/optimization-job.service.js` | Create |
| `services/data-query.service.js` | Modify - add slow query logging |
| `db/migrations/xxx_add_slow_queries.sql` | Create |
| `routes/admin.routes.js` | Add endpoints |
| Client: `QueryOptimizerPage.tsx` + components | Create |

---

## Example Flow

```
1. User asks: "מכירות חנות 15 בחודש האחרון"

2. Query runs in 8.2 seconds → logged to slow_queries

3. Admin opens /admin/query-optimizer
   - Sees new slow query in table

4. Admin clicks [Analyze]
   - System runs EXPLAIN ANALYZE
   - Shows: "Seq Scan on sales, 9.4M rows"
   - Recommendation: "Create index on (store, date)"
   - Shows SQL: CREATE INDEX idx_sales_...

5. Admin clicks [Execute Optimization]
   - Job created in optimization_jobs (status: pending)
   - Background process picks up job
   - Status changes: pending → running → completed

6. Admin refreshes, sees job completed
   - Next similar query: 0.3 seconds ✅
```

---

## Priority: Medium

## Estimated Complexity
| Component | Effort |
|-----------|--------|
| Slow query logging | Low |
| Database tables | Low |
| EXPLAIN parsing | Medium |
| Recommendation logic | Medium |
| Admin UI | Medium |
| Job execution | Low |
| **Total** | **2-3 focused sessions** |
