-- Aspect Management (#115): mark demo rows, so a demo set can be shown to
-- Itzik and later removed without touching anything he entered himself.
-- scripts/aspect-management-demo.js seeds and wipes the rows that carry it.
ALTER TABLE am_people       ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE am_clients      ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE am_client_notes ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE am_projects     ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE am_time_entries ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE am_blockers     ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE am_quotes       ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
