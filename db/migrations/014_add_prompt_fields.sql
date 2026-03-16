-- Migration: Add extended fields to crew_prompts table
-- Adds: model, provider, kb_sources, persona, thinking_prompt

ALTER TABLE crew_prompts
  ADD COLUMN IF NOT EXISTS model VARCHAR(100),
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS kb_sources JSONB,
  ADD COLUMN IF NOT EXISTS persona TEXT,
  ADD COLUMN IF NOT EXISTS thinking_prompt TEXT;

-- Verify columns were added
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'crew_prompts'
  AND column_name IN ('model', 'provider', 'kb_sources', 'persona', 'thinking_prompt');
