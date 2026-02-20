-- Migration 005: Add Query Optimizer tables
-- Supports slow query logging and index optimization job tracking

CREATE TABLE IF NOT EXISTS public.slow_queries (
  id SERIAL PRIMARY KEY,
  agent_name TEXT NOT NULL,
  schema_name TEXT,
  question TEXT,
  sql TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  rows_returned INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  analyzed_at TIMESTAMP,
  dismissed_at TIMESTAMP,
  recommendation JSONB
);

CREATE INDEX IF NOT EXISTS idx_slow_queries_agent ON public.slow_queries(agent_name);
CREATE INDEX IF NOT EXISTS idx_slow_queries_created ON public.slow_queries(created_at DESC);

CREATE TABLE IF NOT EXISTS public.optimization_jobs (
  id SERIAL PRIMARY KEY,
  slow_query_id INTEGER REFERENCES public.slow_queries(id),
  agent_name TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'create_index',
  description TEXT,
  sql TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_optimization_jobs_status ON public.optimization_jobs(status);
CREATE INDEX IF NOT EXISTS idx_optimization_jobs_agent ON public.optimization_jobs(agent_name);
