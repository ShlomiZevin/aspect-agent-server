# Database Migrations

All migrations are plain SQL files with a Node.js runner script.

## Running a Migration

```bash
# Local (uses .env)
node db/migrations/run-XXX-name.js

# Production (uses .env.production)
NODE_ENV=production node db/migrations/run-XXX-name.js
```

---

## Migration History

### 001 — Add prompt_id to agents

Adds `prompt_id` column to the `agents` table so each agent can have its own OpenAI prompt ID.

```bash
node db/migrations/run-add-prompt-id.js
```

### 002–004 — (Internal schema migrations)

Earlier schema migrations for conversations, messages, crew_prompts, KB tables.

### 005 — Add Query Optimizer tables

Creates two new tables for the Query Optimizer admin feature:

```sql
-- public.slow_queries
-- Logs slow (>5s), failed, and timed-out queries
CREATE TABLE public.slow_queries (
  id              SERIAL PRIMARY KEY,
  agent_name      TEXT NOT NULL,
  schema_name     TEXT NOT NULL,
  question        TEXT,
  sql             TEXT,
  duration_ms     INTEGER NOT NULL,
  rows_returned   INTEGER,
  recommendation  JSONB,         -- Claude EXPLAIN recommendation
  analyzed_at     TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- public.optimization_jobs
-- Tracks async DDL jobs (CREATE INDEX CONCURRENTLY, etc.)
CREATE TABLE public.optimization_jobs (
  id              SERIAL PRIMARY KEY,
  slow_query_id   INTEGER REFERENCES public.slow_queries(id),
  agent_name      TEXT NOT NULL,
  schema_name     TEXT NOT NULL,
  job_type        TEXT NOT NULL,
  description     TEXT,
  sql             TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',  -- pending/running/completed/failed
  output          TEXT,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

```bash
node db/migrations/run-005-add-query-optimizer.js
```

### 006 — Add query_type and error_message to slow_queries

Extends `slow_queries` to track three types of bad queries:

| `query_type` | Meaning |
|---|---|
| `slow` | Query completed but exceeded `SLOW_QUERY_THRESHOLD_MS` (5s) |
| `error` | Query failed with a SQL or runtime error |
| `timeout` | Query was killed after exceeding `QUERY_TIMEOUT_MS` (15s) |

```sql
ALTER TABLE public.slow_queries
  ADD COLUMN IF NOT EXISTS query_type TEXT NOT NULL DEFAULT 'slow',
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_slow_queries_type ON public.slow_queries(query_type);
```

```bash
node db/migrations/run-006-add-query-error-columns.js
```

---

## Rollback

Migrations do not have automated rollbacks. Use `DROP COLUMN` / `DROP TABLE` manually if needed:

```sql
-- Rollback 006
ALTER TABLE public.slow_queries DROP COLUMN IF EXISTS query_type;
ALTER TABLE public.slow_queries DROP COLUMN IF EXISTS error_message;

-- Rollback 005
DROP TABLE IF EXISTS public.optimization_jobs;
DROP TABLE IF EXISTS public.slow_queries;

-- Rollback prompt_id
ALTER TABLE agents DROP COLUMN IF EXISTS prompt_id;
```
