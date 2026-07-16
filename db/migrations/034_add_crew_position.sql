-- Migration 034: author-controlled crew order.
--
-- Adds a nullable `position` to builder_crews so the builder sidebar
-- can be drag-reordered and the order persists. Hydrate sorts by
-- `position NULLS LAST, created_at`, so existing crews keep their
-- current (createdAt) order until the author drags them.
--
-- Purely visual: the starting crew is the agent's defaultCrewId and
-- transitions drive the rest — order has no runtime effect. Additive +
-- IF NOT EXISTS, so nothing changes until the first reorder.

ALTER TABLE builder_crews ADD COLUMN IF NOT EXISTS position INTEGER;
