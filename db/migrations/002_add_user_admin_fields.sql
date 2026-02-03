-- Migration: Add admin-related fields to users and conversations tables
-- Description: Supports user management admin page with role, source, subscription, tenant, and channel tracking

-- =====================================================
-- USERS TABLE: Add new columns for admin management
-- =====================================================

-- Phone number field (for WhatsApp users or linked accounts)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

-- Role field (user/admin) - for future auth, not enforced yet
ALTER TABLE users
ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';

-- Source field - where user was created (web/whatsapp)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'web';

-- Subscription level (demo/pro)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS subscription VARCHAR(20) NOT NULL DEFAULT 'demo';

-- Tenant - organization/company context for customized prompts
ALTER TABLE users
ADD COLUMN IF NOT EXISTS tenant VARCHAR(100);

-- WhatsApp conversation ID - reference to user's single WhatsApp conversation
ALTER TABLE users
ADD COLUMN IF NOT EXISTS whatsapp_conversation_id INTEGER;

-- Last activity timestamp
ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;

-- =====================================================
-- CONVERSATIONS TABLE: Add channel column
-- =====================================================

-- Channel field (web/whatsapp)
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'web';

-- =====================================================
-- INDEXES for better query performance
-- =====================================================

-- Index for filtering by source
CREATE INDEX IF NOT EXISTS idx_users_source
ON users(source);

-- Index for filtering by tenant
CREATE INDEX IF NOT EXISTS idx_users_tenant
ON users(tenant)
WHERE tenant IS NOT NULL;

-- Index for filtering by subscription
CREATE INDEX IF NOT EXISTS idx_users_subscription
ON users(subscription);

-- Index for filtering by phone
CREATE INDEX IF NOT EXISTS idx_users_phone
ON users(phone)
WHERE phone IS NOT NULL;

-- Index for filtering conversations by channel
CREATE INDEX IF NOT EXISTS idx_conversations_channel
ON conversations(channel);

-- =====================================================
-- COMMENTS for documentation
-- =====================================================

COMMENT ON COLUMN users.phone IS 'Phone number for WhatsApp users or linked web users';
COMMENT ON COLUMN users.role IS 'User role: user (default) or admin - for future auth enforcement';
COMMENT ON COLUMN users.source IS 'Where user was created: web or whatsapp';
COMMENT ON COLUMN users.subscription IS 'Subscription level: demo (default) or pro';
COMMENT ON COLUMN users.tenant IS 'Organization/company context for customized agent behavior';
COMMENT ON COLUMN users.whatsapp_conversation_id IS 'Reference to the single WhatsApp conversation for this user';
COMMENT ON COLUMN users.last_active_at IS 'Timestamp of last user activity';
COMMENT ON COLUMN conversations.channel IS 'Communication channel: web or whatsapp';

-- =====================================================
-- UPDATE EXISTING DATA: Set source based on externalId pattern
-- =====================================================

-- Set source to 'whatsapp' for users with wa_ prefix in externalId
UPDATE users
SET source = 'whatsapp'
WHERE external_id LIKE 'wa_%' AND source = 'web';

-- Extract phone from externalId for WhatsApp users (wa_<phone> or wa_<phone>_<uuid>)
UPDATE users
SET phone = SUBSTRING(external_id FROM 4 FOR POSITION('_' IN SUBSTRING(external_id FROM 4)) - 1)
WHERE external_id LIKE 'wa_%'
  AND phone IS NULL
  AND POSITION('_' IN SUBSTRING(external_id FROM 4)) > 0;

-- For wa_<phone> without UUID suffix
UPDATE users
SET phone = SUBSTRING(external_id FROM 4)
WHERE external_id LIKE 'wa_%'
  AND phone IS NULL
  AND POSITION('_' IN SUBSTRING(external_id FROM 4)) = 0;

-- Set channel to 'whatsapp' for conversations with wa_ prefix in externalId
UPDATE conversations
SET channel = 'whatsapp'
WHERE external_id LIKE 'wa_%' AND channel = 'web';
