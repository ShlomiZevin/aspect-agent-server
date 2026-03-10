/**
 * Migration 014: Add podcast_episodes table
 *
 * Stores podcast episode metadata, audio file references,
 * and the status/results of transcription and summarization jobs.
 *
 * Run via Cloud SQL Proxy:
 *   node db/migrations/run-014-add-podcast-episodes.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST_PROXY || '127.0.0.1',
  port: parseInt(process.env.DB_PORT_PROXY || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const SQL = `
-- Create podcast_episodes table
CREATE TABLE IF NOT EXISTS public.podcast_episodes (
  id                  SERIAL PRIMARY KEY,
  title               VARCHAR(500) NOT NULL,

  -- Audio file stored on GCS
  audio_file_name     VARCHAR(500),
  audio_file_url      TEXT,
  audio_file_size     BIGINT,
  audio_mime_type     VARCHAR(100),

  -- Transcription
  transcript_status   VARCHAR(50)  NOT NULL DEFAULT 'none',
  transcript_provider VARCHAR(50),
  transcript_url      TEXT,
  transcript_text     TEXT,
  transcript_error    TEXT,
  transcribed_at      TIMESTAMP,

  -- Summary
  summary_status      VARCHAR(50)  NOT NULL DEFAULT 'none',
  summary_provider    VARCHAR(50),
  summary_model       VARCHAR(100),
  summary_prompt      TEXT,
  summary_url         TEXT,
  summary_text        TEXT,
  summary_error       TEXT,
  summarized_at       TIMESTAMP,

  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_transcript_status
  ON public.podcast_episodes(transcript_status);

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_created_at
  ON public.podcast_episodes(created_at DESC);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_podcast_episodes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_podcast_episodes_updated_at ON public.podcast_episodes;
CREATE TRIGGER trg_podcast_episodes_updated_at
  BEFORE UPDATE ON public.podcast_episodes
  FOR EACH ROW EXECUTE FUNCTION update_podcast_episodes_updated_at();
`;

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running migration 014: add podcast_episodes table...');
    await client.query(SQL);
    console.log('✅ Migration 014 completed successfully.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
