const { pgTable, serial, text, timestamp, varchar, jsonb, boolean, integer, date } = require('drizzle-orm/pg-core');

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
  urlSlug: varchar('url_slug', { length: 50 }), // URL path slug (e.g., 'freeda', 'aspect')
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

// Crew member prompts - versioned prompts for crew members
const crewPrompts = pgTable('crew_prompts', {
  id: serial('id').primaryKey(),
  agentId: integer('agent_id').references(() => agents.id).notNull(),
  crewMemberName: varchar('crew_member_name', { length: 100 }).notNull(), // e.g., "receptionist", "general"
  version: integer('version').notNull(), // Version number (1, 2, 3, ...)
  name: varchar('name', { length: 255 }), // Version name/tag (e.g., "Added empathy guidelines")
  prompt: text('prompt').notNull(), // The actual prompt text
  transitionSystemPrompt: text('transition_system_prompt'), // System prompt injected once when transitioning to this crew
  isActive: boolean('is_active').default(false).notNull(), // Only one version should be active per crew member
  createdBy: integer('created_by').references(() => users.id), // Who created this version
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Context data - generic context storage for user/conversation level data
const contextData = pgTable('context_data', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  conversationId: integer('conversation_id').references(() => conversations.id), // NULL for user-level context
  namespace: varchar('namespace', { length: 100 }).notNull(), // e.g., 'journey', 'preferences', 'profiler'
  data: jsonb('data').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// User symptoms - domain-specific symptom tracking (Freeda)
const userSymptoms = pgTable('user_symptoms', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  conversationId: integer('conversation_id').references(() => conversations.id),

  // What the user said (their exact words)
  userProvidedName: text('user_provided_name').notNull(),

  // System-mapped standard symptom (filled later by categorization process)
  systemSymptomName: varchar('system_symptom_name', { length: 100 }),

  // Classification
  symptomGroup: varchar('symptom_group', { length: 50 }), // emotional, cognitive, physical
  crewMember: varchar('crew_member', { length: 100 }),    // Which crew collected it

  // Impact & timing (nullable - collected when user provides)
  impact: varchar('impact', { length: 20 }),   // low, medium, high
  timing: varchar('timing', { length: 50 }),   // recent, ongoing, fluctuating

  reportedAt: timestamp('reported_at').defaultNow().notNull(),
});

// Crew members - DB-based crew member definitions (for dashboard-created crews)
// These work alongside file-based crews. File crews take precedence over DB crews with same name.
const crewMembers = pgTable('crew_members', {
  id: serial('id').primaryKey(),
  agentId: integer('agent_id').references(() => agents.id).notNull(),

  // Identity
  name: varchar('name', { length: 100 }).notNull(), // Unique per agent, snake_case (e.g., 'billing_support')
  displayName: varchar('display_name', { length: 200 }).notNull(),
  description: text('description'),
  isDefault: boolean('is_default').default(false).notNull(),

  // LLM config
  guidance: text('guidance').notNull(), // The main prompt/instructions
  model: varchar('model', { length: 50 }).default('gpt-4o').notNull(),
  maxTokens: integer('max_tokens').default(2048).notNull(),

  // Knowledge base (optional) - { enabled: boolean, storeId: string }
  knowledgeBase: jsonb('knowledge_base'),

  // Fields to collect (optional) - [{ name: string, description: string }]
  fieldsToCollect: jsonb('fields_to_collect'),

  // Transitions (optional)
  transitionTo: varchar('transition_to', { length: 100 }), // Target crew name
  transitionSystemPrompt: text('transition_system_prompt'), // System message on transition

  // Tools (by reference name) - ["tool_name", ...]
  tools: jsonb('tools'),

  // Status
  isActive: boolean('is_active').default(true).notNull(),

  // Metadata
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// =============================================================================
// TASK BOARD MODULE (Separate from agent system)
// =============================================================================

// Task board assignees
const taskAssignees = pgTable('task_assignees', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Tasks
const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 50 }).notNull().default('todo'), // todo, in_progress, done
  priority: varchar('priority', { length: 20 }).notNull().default('medium'), // low, medium, high, critical
  type: varchar('type', { length: 20 }).notNull().default('feature'), // bug, feature, idea
  domain: varchar('domain', { length: 50 }).notNull().default('general'), // general, freeda, aspect, etc.
  assignee: varchar('assignee', { length: 100 }), // assignee name
  dueDate: date('due_date'),
  atRisk: boolean('at_risk').default(false).notNull(), // Flag for tasks at risk of missing deadline
  isCompleted: boolean('is_completed').default(false).notNull(), // PM approval - task fully completed and reviewed
  dependsOn: integer('depends_on'), // ID of task this depends on (must be done first)
  tags: jsonb('tags').default([]), // array of strings
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// =============================================================================
// DEMO MOCKUP MODULE (Customer demo tool)
// =============================================================================

// Demo mockups - fake conversation screenshots for customer demos
const demoMockups = pgTable('demo_mockups', {
  id: serial('id').primaryKey(),
  publicId: varchar('public_id', { length: 50 }).notNull().unique(), // UUID for public sharing
  title: varchar('title', { length: 255 }).notNull().default('Untitled Mockup'),
  viewMode: varchar('view_mode', { length: 20 }).notNull().default('regular'), // 'whatsapp' | 'regular'
  config: jsonb('config').notNull().default({}), // { agentName, agentLogoUrl, senderName, colorScheme, language }
  messages: jsonb('messages').notNull().default([]), // [{ id, senderName, text, side, timestamp }]
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
  thinkingSteps,
  messageFeedback,
  feedbackTags,
  crewPrompts,
  contextData,
  userSymptoms,
  crewMembers,
  taskAssignees,
  tasks,
  demoMockups,
};
