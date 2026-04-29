-- Add quality_stats column to data_reload_runs.
-- Stores per-table type conversion report: which columns had values that
-- could not be converted to the target type (became NULL) during import.
-- Format: { "tableName": { "colName": { "type": "DATE", "nullified": 42, "samples": ["bad1","bad2"] } } }
ALTER TABLE public.data_reload_runs
  ADD COLUMN IF NOT EXISTS quality_stats JSONB;
