-- Migration: Add prompt_id column to agents table
-- This allows each agent to have its own OpenAI prompt ID

-- Add prompt_id column
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS prompt_id VARCHAR(255);

-- Update Freeda 2.0 (id=1) with her specific prompt ID
UPDATE agents
SET prompt_id = 'pmpt_695cc633a8248193bfd1601116118463064124325ea89640'
WHERE id = 1;

-- Update Aspect (id=2) with his specific prompt ID
UPDATE agents
SET prompt_id = 'pmpt_6968b04b9d8c819695d296bc9593c145031da9cca78b9b13'
WHERE id = 2;

-- Verify the updates
SELECT id, name, prompt_id FROM agents ORDER BY id;
