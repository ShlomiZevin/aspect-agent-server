-- Migration 009: Add knowledge_base_sources column to crew_members
-- Stores: string[] of KB names, null means use file-based config
ALTER TABLE crew_members
ADD COLUMN IF NOT EXISTS knowledge_base_sources JSONB;
