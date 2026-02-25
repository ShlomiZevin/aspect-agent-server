-- Migration 008: Add Google KB support
-- Created: 2026-02-25
-- Adds multi-provider support (OpenAI + Google) to knowledge bases

-- Add provider column to knowledge_bases (default 'openai' for existing records)
ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS provider VARCHAR(50) NOT NULL DEFAULT 'openai';

-- Add Google corpus ID (File Search Store name)
ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS google_corpus_id VARCHAR(255);

-- Add sync tracking columns
ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS synced_from_id INTEGER REFERENCES knowledge_bases(id);

ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;

-- Add Google document ID to files table
ALTER TABLE knowledge_base_files
ADD COLUMN IF NOT EXISTS google_document_id VARCHAR(255);

-- Add original file URL for sync capability (points to GCS path)
ALTER TABLE knowledge_base_files
ADD COLUMN IF NOT EXISTS original_file_url VARCHAR(1024);
