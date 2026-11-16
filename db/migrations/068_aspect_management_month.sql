-- Aspect Management (#116, after #115): what Itzik asked for once V0 was in use.
--
-- A report row now says when the work started and ended; its hours are
-- computed from the two. Rows sent before this keep their hours and no times.
-- Task type and billing type are stored as codes; the Hebrew labels belong to
-- the UI. A project's billing type wins over its client's, which covers the
-- hours reported with no project.
ALTER TABLE am_time_entries ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE am_time_entries ADD COLUMN IF NOT EXISTS end_time   TIME;
ALTER TABLE am_time_entries ADD COLUMN IF NOT EXISTS task_type  VARCHAR(20)
  CHECK (task_type IN ('maintenance', 'development'));

ALTER TABLE am_projects ADD COLUMN IF NOT EXISTS billing_type VARCHAR(20)
  CHECK (billing_type IN ('retainer', 'hourly', 'fixed'));
ALTER TABLE am_clients  ADD COLUMN IF NOT EXISTS billing_type VARCHAR(20)
  CHECK (billing_type IN ('retainer', 'hourly', 'fixed'));

-- The month report reads one month of entries at a time.
CREATE INDEX IF NOT EXISTS am_time_entries_date_idx ON am_time_entries (entry_date);
