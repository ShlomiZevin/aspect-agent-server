-- Migration 047: give a zero-match sweep somewhere to say WHY.
--
-- `trigger_status` recorded only a count, so the card said "nobody was
-- quiet enough" for every empty sweep — including the case where
-- conversations WERE quiet and had simply used up their nudge limit.
-- Those need opposite responses from an author (wait vs. raise the cap
-- or accept it is done), and they were reported identically.
--
-- One nullable text column. The phrasing is built by the dispatcher from
-- the trigger type's own clause names, so it stays correct for trigger
-- types that don't exist yet.

ALTER TABLE trigger_status ADD COLUMN IF NOT EXISTS last_reason text;
