-- 002_add_domain_and_crew.sql
--
-- Restores two fields the original board's form has and this one dropped.
--
-- They were cut on the argument that `domain` is a free-text label rather than a
-- boundary and that `crew_member` is specific to a conversational agent. Both
-- points stand and neither was mine to act on: the board is a replacement, so a
-- field the form offers is a field the form offers.
--
-- `domain` keeps its old meaning — which part of the product a task belongs to
-- (general/engine, then per-client areas). `crew_member` names the crew a task
-- is about, free text because the crew list comes from whichever agent is being
-- worked on and is not a fixed set here.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS domain varchar(50) NOT NULL DEFAULT 'general';

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS crew_member varchar(100);

-- Filtering by domain is the reason it exists; the board does it on every load.
CREATE INDEX IF NOT EXISTS tasks_domain_idx ON tasks (domain) WHERE status <> 'done';
