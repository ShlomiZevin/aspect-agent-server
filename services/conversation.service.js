const db = require('./db.pg');
const { agents, users, conversations, messages, thinkingSteps } = require('../db/schema');
const { eq, and, desc, asc } = require('drizzle-orm');

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

    // Extract source and phone from metadata if provided
    const source = userData.metadata?.source || 'web';
    const phone = userData.metadata?.phone || userData.phone || null;

    // Create new user
    const [newUser] = await this.drizzle
      .insert(users)
      .values({
        externalId,
        email: userData.email || null,
        name: userData.name || null,
        phone,
        source,
        metadata: userData.metadata || null
      })
      .returning();

    console.log(`✅ Created new user: ${newUser.id} (${externalId}), source=${source}`);
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
   * Get agent by ID
   * @param {number} agentId - Agent ID
   * @returns {Promise<Object|null>} - Agent object or null
   */
  async getAgentById(agentId) {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    return result.length > 0 ? result[0] : null;
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
   * @returns {Promise<Array>} - Array of messages with thinking steps
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

    // Get thinking steps for all messages in this conversation
    const allThinkingSteps = await this.drizzle
      .select()
      .from(thinkingSteps)
      .where(eq(thinkingSteps.conversationId, conversation[0].id))
      .orderBy(asc(thinkingSteps.stepOrder));

    // Group thinking steps by messageId
    const stepsByMessageId = {};
    for (const step of allThinkingSteps) {
      if (!stepsByMessageId[step.messageId]) {
        stepsByMessageId[step.messageId] = [];
      }
      stepsByMessageId[step.messageId].push({
        stepType: step.stepType,
        description: step.stepDescription,
        stepOrder: step.stepOrder,
        metadata: step.metadata
      });
    }

    // Attach thinking steps to messages
    const messagesWithSteps = messageHistory.map(msg => ({
      ...msg,
      thinkingSteps: stepsByMessageId[msg.id] || []
    }));

    return messagesWithSteps.reverse(); // Return in chronological order
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
        channel: conversations.channel,
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

    // Update conversation (don't update updatedAt - that should only change with new messages)
    const [updated] = await this.drizzle
      .update(conversations)
      .set({
        metadata: newMetadata
      })
      .where(eq(conversations.id, conversation[0].id))
      .returning();

    return updated;
  }

  /**
   * Get conversation by external ID
   * @param {string} externalConversationId - External conversation ID
   * @returns {Promise<Object|null>} - Conversation object or null
   */
  async getConversationByExternalId(externalConversationId) {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, externalConversationId))
      .limit(1);

    return result.length > 0 ? result[0] : null;
  }

  /**
   * Update current crew member for a conversation
   * @param {string} externalConversationId - External conversation ID
   * @param {string} crewMemberName - Name of the crew member
   * @returns {Promise<Object>} - Updated conversation
   */
  async updateCurrentCrewMember(externalConversationId, crewMemberName) {
    if (!this.drizzle) this.initialize();

    const conversation = await this.getConversationByExternalId(externalConversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${externalConversationId}`);
    }

    // Update both the dedicated column and metadata
    const currentMetadata = conversation.metadata || {};
    const newMetadata = {
      ...currentMetadata,
      currentCrewMember: crewMemberName,
      lastCrewUpdate: new Date().toISOString()
    };

    const [updated] = await this.drizzle
      .update(conversations)
      .set({
        currentCrewMember: crewMemberName,
        metadata: newMetadata,
        updatedAt: new Date()
      })
      .where(eq(conversations.id, conversation.id))
      .returning();

    return updated;
  }

  /**
   * Find a user by phone number (WhatsApp users have externalId = 'wa_<phone>')
   * @param {string} phone - Phone number (digits only)
   * @returns {Promise<Object|null>} - User object or null
   */
  async getUserByPhone(phone) {
    if (!this.drizzle) this.initialize();

    const externalId = `wa_${phone}`;
    const result = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.externalId, externalId))
      .limit(1);

    return result.length > 0 ? result[0] : null;
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

  /**
   * Link an existing conversation to a phone number.
   * Updates the user's externalId to wa_<phone> format and updates conversation externalId.
   * @param {string} externalConversationId - Current external conversation ID
   * @param {string} phone - Phone number (digits only)
   * @returns {Promise<Object>} - { conversation, user, newExternalId } with updated records
   */
  async linkConversationToPhone(externalConversationId, phone) {
    if (!this.drizzle) this.initialize();

    // Find the conversation
    const conv = await this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, externalConversationId))
      .limit(1);

    if (conv.length === 0) {
      throw new Error(`Conversation not found: ${externalConversationId}`);
    }

    // Check if this phone already has a user with conversations
    const waExternalId = `wa_${phone}`;
    const existingWaUser = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.externalId, waExternalId))
      .limit(1);

    if (existingWaUser.length > 0) {
      const existingConvs = await this.drizzle
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.userId, existingWaUser[0].id))
        .limit(1);

      if (existingConvs.length > 0) {
        throw new Error(`phone_has_history: Phone ${phone} already has conversation history. Use "Fetch History" instead.`);
      }
      // If wa_user exists but has no conversations, delete it (we'll update current user instead)
      await this.drizzle
        .delete(users)
        .where(eq(users.id, existingWaUser[0].id));
      console.log(`🗑️ Deleted empty WhatsApp user ${waExternalId}`);
    }

    // Get the current user
    const currentUser = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.id, conv[0].userId))
      .limit(1);

    if (currentUser.length === 0) {
      throw new Error(`User not found for conversation: ${externalConversationId}`);
    }

    // Update the user's externalId to WhatsApp format
    const [updatedUser] = await this.drizzle
      .update(users)
      .set({
        externalId: waExternalId,
        phone: phone,
        metadata: { ...currentUser[0].metadata, phone, source: 'whatsapp' },
        updatedAt: new Date()
      })
      .where(eq(users.id, currentUser[0].id))
      .returning();

    // Generate new conversation externalId in WhatsApp format
    const crypto = require('crypto');
    const newExternalId = `wa_${phone}_${crypto.randomUUID()}`;

    // Update the conversation externalId (userId stays the same)
    const [updatedConv] = await this.drizzle
      .update(conversations)
      .set({
        externalId: newExternalId,
        updatedAt: new Date()
      })
      .where(eq(conversations.id, conv[0].id))
      .returning();

    console.log(`📱 Linked user ${currentUser[0].externalId} → ${waExternalId}, conversation → ${newExternalId}`);
    return { conversation: updatedConv, user: updatedUser, newExternalId };
  }

  /**
   * Update user's name
   * @param {number} userId - User ID (database primary key)
   * @param {string} name - New name to set
   * @returns {Promise<Object>} - Updated user
   */
  async updateUserName(userId, name) {
    if (!this.drizzle) this.initialize();

    const [updated] = await this.drizzle
      .update(users)
      .set({
        name,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();

    return updated;
  }

  /**
   * Delete a message and its associated thinking steps
   * @param {number} messageId - Database message ID
   * @returns {Promise<Object>} - Deletion result
   */
  async deleteMessage(messageId) {
    if (!this.drizzle) this.initialize();

    // First delete associated thinking steps
    await this.drizzle
      .delete(thinkingSteps)
      .where(eq(thinkingSteps.messageId, messageId));

    // Then delete the message
    const [deleted] = await this.drizzle
      .delete(messages)
      .where(eq(messages.id, messageId))
      .returning();

    if (!deleted) {
      throw new Error(`Message not found: ${messageId}`);
    }

    console.log(`🗑️ Deleted message ${messageId}`);
    return deleted;
  }

  /**
   * Delete multiple messages by IDs
   * @param {number[]} messageIds - Array of message IDs to delete
   * @returns {Promise<Object>} - Deletion result with count
   */
  async deleteMessages(messageIds) {
    if (!this.drizzle) this.initialize();
    if (!messageIds || messageIds.length === 0) {
      return { deletedCount: 0 };
    }

    const { inArray } = require('drizzle-orm');

    // First delete associated thinking steps
    await this.drizzle
      .delete(thinkingSteps)
      .where(inArray(thinkingSteps.messageId, messageIds));

    // Then delete the messages
    const result = await this.drizzle
      .delete(messages)
      .where(inArray(messages.id, messageIds))
      .returning();

    console.log(`🗑️ Deleted ${result.length} messages`);
    return { deletedCount: result.length, deleted: result };
  }

  /**
   * Delete messages from a specific point onwards in a conversation
   * Useful for "regenerate from here" functionality
   * @param {string} externalConversationId - External conversation ID
   * @param {number} fromMessageId - Delete this message and all after it
   * @returns {Promise<Object>} - Deletion result
   */
  async deleteMessagesFrom(externalConversationId, fromMessageId) {
    if (!this.drizzle) this.initialize();
    const { gte } = require('drizzle-orm');

    // Get conversation
    const conversation = await this.getConversationByExternalId(externalConversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${externalConversationId}`);
    }

    // Get the message to find its createdAt timestamp
    const [targetMessage] = await this.drizzle
      .select()
      .from(messages)
      .where(eq(messages.id, fromMessageId))
      .limit(1);

    if (!targetMessage) {
      throw new Error(`Message not found: ${fromMessageId}`);
    }

    // Get all messages from this point onwards
    const messagesToDelete = await this.drizzle
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          gte(messages.createdAt, targetMessage.createdAt)
        )
      );

    const messageIds = messagesToDelete.map(m => m.id);

    if (messageIds.length === 0) {
      return { deletedCount: 0 };
    }

    return this.deleteMessages(messageIds);
  }
}

// Export singleton instance
module.exports = new ConversationService();
