-- Convert provider from varchar to jsonb array
-- Existing values: 'openai', 'google', 'both', 'anthropic'

-- Step 1: Add new jsonb column
ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS providers JSONB;

-- Step 2: Migrate existing data
UPDATE knowledge_bases SET providers = '["openai"]'::jsonb WHERE provider = 'openai';
UPDATE knowledge_bases SET providers = '["google"]'::jsonb WHERE provider = 'google';
UPDATE knowledge_bases SET providers = '["openai", "google"]'::jsonb WHERE provider = 'both';
UPDATE knowledge_bases SET providers = '["anthropic"]'::jsonb WHERE provider = 'anthropic';
UPDATE knowledge_bases SET providers = '["openai"]'::jsonb WHERE providers IS NULL;

-- Step 3: Set not null default
ALTER TABLE knowledge_bases ALTER COLUMN providers SET DEFAULT '["openai"]'::jsonb;
ALTER TABLE knowledge_bases ALTER COLUMN providers SET NOT NULL;

-- Step 4: Drop old column
ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS provider;
