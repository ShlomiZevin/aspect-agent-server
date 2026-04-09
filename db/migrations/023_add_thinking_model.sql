-- Migration: Add thinking_model column to crew_prompts table
ALTER TABLE crew_prompts
  ADD COLUMN IF NOT EXISTS thinking_model VARCHAR(100);

-- Verify column was added
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'crew_prompts'
  AND column_name = 'thinking_model';
