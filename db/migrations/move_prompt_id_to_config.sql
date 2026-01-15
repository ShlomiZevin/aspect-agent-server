-- Migration: Move prompt_id from column to config JSON and drop the column
-- This consolidates agent configuration into a single JSON column

-- Step 1: Update Freeda 2.0 (id=1) - merge promptId and promptVersion into config JSON
UPDATE agents
SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('promptId', 'pmpt_695cc633a8248193bfd1601116118463064124325ea89640', 'promptVersion', '2')
WHERE id = 1;

-- Step 2: Update Aspect (id=2) - merge promptId and promptVersion into config JSON
UPDATE agents
SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('promptId', 'pmpt_6968b04b9d8c819695d296bc9593c145031da9cca78b9b13', 'promptVersion', '1')
WHERE id = 2;

-- Step 3: Drop the prompt_id column
ALTER TABLE agents
DROP COLUMN IF EXISTS prompt_id;

-- Verify the updates
SELECT id, name, config FROM agents ORDER BY id;
