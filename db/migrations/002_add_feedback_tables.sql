-- Migration: Add feedback tables for message commenting/feedback system
-- Tables: message_feedback, feedback_tags
-- Date: 2026-02-03

-- Feedback tags - registry of tags for autocomplete in chat
-- Each agent has its own set of tags
CREATE TABLE IF NOT EXISTS feedback_tags (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20) NOT NULL, -- hex color e.g. #10b981
  usage_count INTEGER DEFAULT 0 NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for feedback_tags
CREATE INDEX IF NOT EXISTS idx_feedback_tags_agent_id ON feedback_tags(agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_tags_name ON feedback_tags(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_tags_agent_name ON feedback_tags(agent_id, name);

-- Message feedback - stores feedback/comments on assistant messages
CREATE TABLE IF NOT EXISTS message_feedback (
  id SERIAL PRIMARY KEY,
  assistant_message_id INTEGER NOT NULL REFERENCES messages(id),
  user_message_id INTEGER REFERENCES messages(id), -- preceding user message (auto-resolved)
  feedback_text TEXT,
  tags JSONB, -- Array of { name: string, color: string }
  crew_member VARCHAR(100), -- denormalized from message metadata for quick queries
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for message_feedback
CREATE INDEX IF NOT EXISTS idx_message_feedback_assistant_message_id ON message_feedback(assistant_message_id);
CREATE INDEX IF NOT EXISTS idx_message_feedback_crew_member ON message_feedback(crew_member);
CREATE INDEX IF NOT EXISTS idx_message_feedback_created_at ON message_feedback(created_at);

-- GIN index for tags JSONB column (for filtering by tag)
CREATE INDEX IF NOT EXISTS idx_message_feedback_tags ON message_feedback USING GIN (tags);
