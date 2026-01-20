-- Create thinking_steps table to track thinking process per message
-- Used for logging and review purposes

CREATE TABLE IF NOT EXISTS thinking_steps (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  step_type VARCHAR(50) NOT NULL, -- message_received, function_call, kb_access, processing, etc.
  step_description TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  metadata JSONB, -- Additional data (function name, params, file names, etc.)
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_thinking_steps_message_id ON thinking_steps(message_id);
CREATE INDEX IF NOT EXISTS idx_thinking_steps_conversation_id ON thinking_steps(conversation_id);
CREATE INDEX IF NOT EXISTS idx_thinking_steps_step_type ON thinking_steps(step_type);
