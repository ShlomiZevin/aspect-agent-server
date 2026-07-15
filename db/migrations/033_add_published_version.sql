-- Migration 033: published version pointer for Builder V2.
--
-- Adds a customer-facing `published_version_id` to agents and crews,
-- decoupled from `active_version_id` (the builder/admin marker). The
-- public runtime (version:'published') resolves this pointer, falling
-- back to active→viewing when NULL, so customers never see an
-- unpublished draft. Moved only by an explicit Publish action — admins
-- can keep iterating and re-activating without touching live users.
--
-- Nullable + IF NOT EXISTS: existing agents/crews stay un-published,
-- which resolves to their active version (the pre-publish behavior),
-- so nothing changes for anyone until the first explicit Publish.

ALTER TABLE builder_agents ADD COLUMN IF NOT EXISTS published_version_id VARCHAR(64);
ALTER TABLE builder_crews  ADD COLUMN IF NOT EXISTS published_version_id VARCHAR(64);
