-- Migration: Add currentCrewMember column to conversations table
-- Description: Tracks which crew member is currently handling the conversation

-- Add the currentCrewMember column
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS current_crew_member VARCHAR(100);

-- Create index for faster lookups by crew member
CREATE INDEX IF NOT EXISTS idx_conversations_current_crew
ON conversations(current_crew_member)
WHERE current_crew_member IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN conversations.current_crew_member IS 'Name of the crew member currently handling this conversation';
