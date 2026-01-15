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
  externalId: varchar('external_id', { length: 255 }).unique(), // Firebase UID, etc.
  email: varchar('email', { length: 255 }),
  name: varchar('name', { length: 255 }),
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
  status: varchar('status', { length: 50 }).default('active').notNull(), // active, archived, deleted
  metadata: jsonb('metadata'), // Additional conversation data
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

// Export all tables
module.exports = {
  connectionTest,
  agents,
  users,
  conversations,
  messages,
  knowledgeBases,
  knowledgeBaseFiles,
};
