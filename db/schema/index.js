const { pgTable, serial, text, timestamp, varchar, jsonb, boolean, integer } = require('drizzle-orm/pg-core');

/**
 * Multi-Agent Platform Database Schema
 *
 * This schema supports multiple agent domains (menopause, fitness, nutrition, etc.)
 * and manages conversations, messages, and agent-specific data.
 */

// Connection test table (for health checks)
const connectionTest = pgTable('connection_test', {
  id: serial('id').primaryKey(),
  message: text('message').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Agents table - defines different agent types
const agents = pgTable('agents', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  domain: varchar('domain', { length: 100 }).notNull(), // menopause, fitness, nutrition, etc.
  description: text('description'),
  config: jsonb('config'), // Agent-specific configuration (includes promptId, vectorStoreId, etc.)
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Users table - platform users
const users = pgTable('users', {
  id: serial('id').primaryKey(),
  externalId: varchar('external_id', { length: 255 }).unique(), // Firebase UID, anon_xxx, wa_phone, etc.
  email: varchar('email', { length: 255 }),
  name: varchar('name', { length: 255 }),
  phone: varchar('phone', { length: 50 }), // Phone number (for WhatsApp users or linked accounts)
  role: varchar('role', { length: 20 }).default('user').notNull(), // user, admin (for future use)
  source: varchar('source', { length: 20 }).default('web').notNull(), // web, whatsapp
  subscription: varchar('subscription', { length: 20 }).default('demo').notNull(), // demo, pro
  tenant: varchar('tenant', { length: 100 }), // Organization/company context
  whatsappConversationId: integer('whatsapp_conversation_id'), // Reference to WhatsApp conversation (1 per user)
  lastActiveAt: timestamp('last_active_at'), // Last activity timestamp
  metadata: jsonb('metadata'), // Additional user data
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Conversations table - tracks conversations across agents
const conversations = pgTable('conversations', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  agentId: integer('agent_id').references(() => agents.id).notNull(),
  externalId: varchar('external_id', { length: 255 }).unique(), // External conversation ID
  openaiConversationId: varchar('openai_conversation_id', { length: 255 }), // OpenAI conversation ID
  currentCrewMember: varchar('current_crew_member', { length: 100 }), // Current crew member handling this conversation
  channel: varchar('channel', { length: 20 }).default('web').notNull(), // web, whatsapp
  status: varchar('status', { length: 50 }).default('active').notNull(), // active, archived, deleted
  metadata: jsonb('metadata'), // Additional conversation data (includes crew transition history)
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Messages table - stores all messages in conversations
const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').references(() => conversations.id).notNull(),
  role: varchar('role', { length: 50 }).notNull(), // user, assistant, system
  content: text('content').notNull(),
  metadata: jsonb('metadata'), // Additional message data (tokens, citations, etc.)
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Agent knowledge bases - track uploaded files and knowledge
const knowledgeBases = pgTable('knowledge_bases', {
  id: serial('id').primaryKey(),
  agentId: integer('agent_id').references(() => agents.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  vectorStoreId: varchar('vector_store_id', { length: 255 }), // OpenAI vector store ID
  fileCount: integer('file_count').default(0),
  totalSize: integer('total_size').default(0), // Total size of all files in bytes
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Knowledge base files - individual files in knowledge bases
const knowledgeBaseFiles = pgTable('knowledge_base_files', {
  id: serial('id').primaryKey(),
  knowledgeBaseId: integer('knowledge_base_id').references(() => knowledgeBases.id).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  fileSize: integer('file_size'),
  fileType: varchar('file_type', { length: 100 }),
  openaiFileId: varchar('openai_file_id', { length: 255 }),
  status: varchar('status', { length: 50 }).default('processing').notNull(), // processing, completed, failed
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Thinking steps - tracks thinking process per message for logging/review
const thinkingSteps = pgTable('thinking_steps', {
  id: serial('id').primaryKey(),
  messageId: integer('message_id').references(() => messages.id).notNull(),
  conversationId: integer('conversation_id').references(() => conversations.id).notNull(),
  stepType: varchar('step_type', { length: 50 }).notNull(), // message_received, function_call, kb_access, processing, etc.
  stepDescription: text('step_description').notNull(),
  stepOrder: integer('step_order').notNull(),
  metadata: jsonb('metadata'), // Additional data (function name, params, file names, etc.)
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Message feedback - stores feedback/comments on assistant messages
const messageFeedback = pgTable('message_feedback', {
  id: serial('id').primaryKey(),
  assistantMessageId: integer('assistant_message_id').references(() => messages.id).notNull(),
  userMessageId: integer('user_message_id').references(() => messages.id), // preceding user message (auto-resolved)
  feedbackText: text('feedback_text'),
  tags: jsonb('tags'), // Array of { name: string, color: string }
  crewMember: varchar('crew_member', { length: 100 }), // denormalized from message metadata
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Feedback tags - for autocomplete in chat (simple name + color registry)
const feedbackTags = pgTable('feedback_tags', {
  id: serial('id').primaryKey(),
  agentId: integer('agent_id').references(() => agents.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  color: varchar('color', { length: 20 }).notNull(), // hex color e.g. #10b981
  usageCount: integer('usage_count').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Export all tables
module.exports = {
  connectionTest,
  agents,
  users,
  conversations,
  messages,
  knowledgeBases,
  knowledgeBaseFiles,
  thinkingSteps,
  messageFeedback,
  feedbackTags,
};
