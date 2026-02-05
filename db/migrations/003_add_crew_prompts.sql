-- Migration: Add crew_prompts table for versioned crew member prompts
-- Run with: node db/migrations/run-add-crew-prompts.js

-- Create crew_prompts table
CREATE TABLE IF NOT EXISTS crew_prompts (
    id SERIAL PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    crew_member_name VARCHAR(100) NOT NULL,
    version INTEGER NOT NULL,
    name VARCHAR(255),
    prompt TEXT NOT NULL,
    is_active BOOLEAN DEFAULT FALSE NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_crew_prompts_agent_crew ON crew_prompts(agent_id, crew_member_name);
CREATE INDEX IF NOT EXISTS idx_crew_prompts_active ON crew_prompts(agent_id, crew_member_name, is_active) WHERE is_active = TRUE;

-- Create unique constraint to ensure only one active version per crew member
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_prompts_unique_active
ON crew_prompts(agent_id, crew_member_name) WHERE is_active = TRUE;

-- Verify table was created
SELECT table_name FROM information_schema.tables WHERE table_name = 'crew_prompts';
