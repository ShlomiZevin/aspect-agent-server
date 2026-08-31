-- 003_drop_domain_and_crew.sql
--
-- Removes the two columns 002 added.
--
-- `domain` duplicated a boundary that already exists: this board is a module
-- switched on per client, and the client is the database it lives in. A column
-- naming the client inside the client's own board is a second answer to a
-- question that already has one, and two answers drift.
--
-- `crew_member` names a crew member of a conversational agent. That is a
-- property of the thing the client's agent is built from, not of our work.
--
-- 002 was a mistake made while over-correcting for having dropped them in the
-- first place. Recorded rather than rewritten so the reasoning is visible.

DROP INDEX IF EXISTS tasks_domain_idx;

ALTER TABLE tasks DROP COLUMN IF EXISTS domain;

ALTER TABLE tasks DROP COLUMN IF EXISTS crew_member;
