-- Migration 006: Add error tracking to slow_queries table
-- Adds query_type (slow/error/timeout) and error_message columns

ALTER TABLE public.slow_queries
  ADD COLUMN IF NOT EXISTS query_type TEXT NOT NULL DEFAULT 'slow',
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- query_type values:
--   'slow'    - query completed but exceeded threshold
--   'error'   - query failed with SQL/runtime error
--   'timeout' - query was cancelled due to statement timeout

CREATE INDEX IF NOT EXISTS idx_slow_queries_type ON public.slow_queries(query_type);
