const db = require('./db.pg');
const { agents, users, conversations, messages } = require('../db/schema');
const { eq, and, desc } = require('drizzle-orm');

/**
 * Conversation Service
 *
 * Manages conversations and message history for the multi-agent platform
 */
class ConversationService {
  constructor() {
    this.drizzle = null;
  }

  /**
   * Initialize the service
   */
  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Get or create a user by external ID (e.g., Firebase UID)
   * @param {string} externalId - External user identifier
   * @param {Object} userData - Optional user data (email, name)
   * @returns {Promise<Object>} - User object
   */
  async getOrCreateUser(externalId, userData = {}) {
    if (!this.drizzle) this.initialize();

    // Try to find existing user
    const existing = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.externalId, externalId))
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    // Create new user
    const [newUser] = await this.drizzle
      .insert(users)
      .values({
        externalId,
        email: userData.email || null,
        name: userData.name || null,
        metadata: userData.metadata || null
      })
      .returning();

    console.log(`✅ Created new user: ${newUser.id} (${externalId})`);
    return newUser;
  }

  /**
   * Get agent by name
   * @param {string} agentName - Agent name (e.g., "Freeda 2.0")
   * @returns {Promise<Object>} - Agent object
   */
  async getAgentByName(agentName) {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .select()
      .from(agents)
      .where(eq(agents.name, agentName))
      .limit(1);

    if (result.length === 0) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    return result[0];
  }

  /**
   * Get or create a conversation
   * @param {string} externalId - External conversation ID (from client)
   * @param {number} agentId - Agent ID
   * @param {number} userId - User ID (optional)
   * @param {string} openaiConversationId - OpenAI conversation ID (optional)
   * @returns {Promise<Object>} - Conversation object
   */
  async getOrCreateConversation(externalId, agentId, userId = null, openaiConversationId = null) {
    if (!this.drizzle) this.initialize();

    // Try to find existing conversation
    const existing = await this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, externalId))
      .limit(1);

    if (existing.length > 0) {
      // Update OpenAI conversation ID if provided and different
      if (openaiConversationId && existing[0].openaiConversationId !== openaiConversationId) {
        const [updated] = await this.drizzle
          .update(conversations)
          .set({
            openaiConversationId,
            updatedAt: new Date()
          })
          .where(eq(conversations.id, existing[0].id))
          .returning();

        return updated;
      }
      return existing[0];
    }

    // Create new conversation
    const [newConversation] = await this.drizzle
      .insert(conversations)
      .values({
        externalId,
        agentId,
        userId,
        openaiConversationId,
        status: 'active'
      })
      .returning();

    console.log(`✅ Created new conversation: ${newConversation.id} (${externalId})`);
    return newConversation;
  }

  /**
   * Save a message to the database
   * @param {number} conversationId - Database conversation ID
   * @param {string} role - Message role (user, assistant, system)
   * @param {string} content - Message content
   * @param {Object} metadata - Additional metadata (tokens, citations, etc.)
   * @returns {Promise<Object>} - Message object
   */
  async saveMessage(conversationId, role, content, metadata = null) {
    if (!this.drizzle) this.initialize();

    const [message] = await this.drizzle
      .insert(messages)
      .values({
        conversationId,
        role,
        content,
        metadata
      })
      .returning();

    return message;
  }

  /**
   * Get conversation history
   * @param {string} externalId - External conversation ID
   * @param {number} limit - Maximum number of messages to retrieve
   * @returns {Promise<Array>} - Array of messages
   */
  async getConversationHistory(externalId, limit = 50) {
    if (!this.drizzle) this.initialize();

    // Get conversation
    const conversation = await this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, externalId))
      .limit(1);

    if (conversation.length === 0) {
      return [];
    }

    // Get messages
    const messageHistory = await this.drizzle
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation[0].id))
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    return messageHistory.reverse(); // Return in chronological order
  }

  /**
   * Complete workflow: Save user message, get/create conversation
   * @param {string} externalConversationId - External conversation ID
   * @param {string} agentName - Agent name
   * @param {string} userMessage - User's message
   * @param {string} userExternalId - User's external ID (optional)
   * @param {string} openaiConversationId - OpenAI conversation ID (optional)
   * @returns {Promise<Object>} - Conversation and message info
   */
  async saveUserMessage(externalConversationId, agentName, userMessage, userExternalId = null, openaiConversationId = null) {
    if (!this.drizzle) this.initialize();

    // Get agent
    const agent = await this.getAgentByName(agentName);

    // Get or create user if externalId provided
    let userId = null;
    if (userExternalId) {
      const user = await this.getOrCreateUser(userExternalId);
      userId = user.id;
    }

    // Get or create conversation
    const conversation = await this.getOrCreateConversation(
      externalConversationId,
      agent.id,
      userId,
      openaiConversationId
    );

    // Save user message
    const message = await this.saveMessage(
      conversation.id,
      'user',
      userMessage
    );

    return {
      conversation,
      message
    };
  }

  /**
   * Save assistant's response
   * @param {string} externalConversationId - External conversation ID
   * @param {string} assistantMessage - Assistant's response
   * @param {Object} metadata - Optional metadata (tokens, etc.)
   * @returns {Promise<Object>} - Message object
   */
  async saveAssistantMessage(externalConversationId, assistantMessage, metadata = null) {
    if (!this.drizzle) this.initialize();

    // Get conversation
    const conversation = await this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, externalConversationId))
      .limit(1);

    if (conversation.length === 0) {
      throw new Error(`Conversation not found: ${externalConversationId}`);
    }

    // Save assistant message
    const message = await this.saveMessage(
      conversation[0].id,
      'assistant',
      assistantMessage,
      metadata
    );

    // Update conversation timestamp
    await this.drizzle
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversation[0].id));

    return message;
  }

  /**
   * Get all conversations for a user
   * @param {string} userExternalId - User's external ID
   * @param {string} agentName - Optional agent name filter
   * @returns {Promise<Array>} - Array of conversations with metadata
   */
  async getUserConversations(userExternalId, agentName = null) {
    if (!this.drizzle) this.initialize();

    // Get user
    const user = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.externalId, userExternalId))
      .limit(1);

    if (user.length === 0) {
      return [];
    }

    // Build query
    let query = this.drizzle
      .select({
        id: conversations.id,
        externalId: conversations.externalId,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        metadata: conversations.metadata,
        agentName: agents.name,
        agentDomain: agents.domain
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          eq(conversations.userId, user[0].id),
          eq(conversations.status, 'active')
        )
      )
      .orderBy(desc(conversations.updatedAt));

    // Add agent filter if provided
    if (agentName) {
      query = query.where(
        and(
          eq(conversations.userId, user[0].id),
          eq(conversations.status, 'active'),
          eq(agents.name, agentName)
        )
      );
    }

    const conversationList = await query;

    // Get message counts and first message for each conversation
    const conversationsWithDetails = await Promise.all(
      conversationList.map(async (conv) => {
        const msgs = await this.drizzle
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conv.id))
          .orderBy(messages.createdAt)
          .limit(1);

        const messageCount = await this.drizzle
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conv.id));

        return {
          ...conv,
          messageCount: messageCount.length,
          firstMessage: msgs.length > 0 ? msgs[0].content : null,
          title: conv.metadata?.title || (msgs.length > 0 ? msgs[0].content.substring(0, 50) : 'New Chat')
        };
      })
    );

    return conversationsWithDetails;
  }

  /**
   * Update conversation metadata
   * @param {string} externalConversationId - External conversation ID
   * @param {Object} metadataUpdate - Metadata to update
   * @returns {Promise<Object>} - Updated conversation
   */
  async updateConversationMetadata(externalConversationId, metadataUpdate) {
    if (!this.drizzle) this.initialize();

    // Get current conversation
    const conversation = await this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, externalConversationId))
      .limit(1);

    if (conversation.length === 0) {
      throw new Error(`Conversation not found: ${externalConversationId}`);
    }

    // Merge metadata
    const currentMetadata = conversation[0].metadata || {};
    const newMetadata = { ...currentMetadata, ...metadataUpdate };

    // Update conversation
    const [updated] = await this.drizzle
      .update(conversations)
      .set({
        metadata: newMetadata,
        updatedAt: new Date()
      })
      .where(eq(conversations.id, conversation[0].id))
      .returning();

    return updated;
  }

  /**
   * Delete a conversation (soft delete by changing status)
   * @param {string} externalConversationId - External conversation ID
   * @returns {Promise<Object>} - Deleted conversation
   */
  async deleteConversation(externalConversationId) {
    if (!this.drizzle) this.initialize();

    const [deleted] = await this.drizzle
      .update(conversations)
      .set({
        status: 'deleted',
        updatedAt: new Date()
      })
      .where(eq(conversations.externalId, externalConversationId))
      .returning();

    if (!deleted) {
      throw new Error(`Conversation not found: ${externalConversationId}`);
    }

    return deleted;
  }
}

// Export singleton instance
module.exports = new ConversationService();
