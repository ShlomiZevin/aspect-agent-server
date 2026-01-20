const db = require('./db.pg');
const { thinkingSteps, conversations, messages } = require('../db/schema');
const { eq, and } = require('drizzle-orm');

/**
 * Thinking Process Service
 *
 * Manages thinking steps for each message in a conversation.
 * Provides infrastructure to add thinking steps from anywhere in the code,
 * send them to the client in real-time, and save them to the database.
 */
class ThinkingService {
  constructor() {
    this.drizzle = null;
    // Active thinking contexts: conversationId -> { messageId, steps, sendCallback, stepOrder }
    this.activeContexts = new Map();
  }

  /**
   * Initialize the service
   */
  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Start a new thinking context for a message
   * @param {string} conversationExternalId - External conversation ID
   * @param {number} messageId - Database message ID (can be null initially, set later)
   * @param {Function} sendCallback - Function to send thinking step to client via SSE
   * @returns {string} - Context ID (uses conversationExternalId as key)
   */
  startContext(conversationExternalId, messageId = null, sendCallback = null) {
    const context = {
      conversationExternalId,
      messageId,
      steps: [],
      stepOrder: 0,
      sendCallback,
      startTime: Date.now()
    };

    this.activeContexts.set(conversationExternalId, context);
    console.log(`🧠 Started thinking context for conversation: ${conversationExternalId}`);
    return conversationExternalId;
  }

  /**
   * Set the message ID for an active context (called after user message is saved)
   * @param {string} conversationExternalId - External conversation ID
   * @param {number} messageId - Database message ID
   */
  setMessageId(conversationExternalId, messageId) {
    const context = this.activeContexts.get(conversationExternalId);
    if (context) {
      context.messageId = messageId;
    }
  }

  /**
   * Set the SSE send callback for an active context
   * @param {string} conversationExternalId - External conversation ID
   * @param {Function} sendCallback - Function to send thinking step to client
   */
  setSendCallback(conversationExternalId, sendCallback) {
    const context = this.activeContexts.get(conversationExternalId);
    if (context) {
      context.sendCallback = sendCallback;
    }
  }

  /**
   * Add a thinking step to the current context
   * This sends the step to the client immediately and queues it for database save
   * @param {string} conversationExternalId - External conversation ID
   * @param {string} stepType - Type of step (message_received, function_call, kb_access, etc.)
   * @param {string} description - Human-readable description of the step
   * @param {Object} metadata - Additional metadata (function name, params, etc.)
   * @returns {Object} - The created step object
   */
  addStep(conversationExternalId, stepType, description, metadata = null) {
    const context = this.activeContexts.get(conversationExternalId);
    if (!context) {
      console.warn(`⚠️ No active thinking context for: ${conversationExternalId}`);
      return null;
    }

    context.stepOrder++;
    const step = {
      stepType,
      stepDescription: description,
      stepOrder: context.stepOrder,
      metadata,
      createdAt: new Date()
    };

    context.steps.push(step);

    // Send to client immediately via SSE if callback is set
    if (context.sendCallback) {
      try {
        context.sendCallback({
          type: 'thinking_step',
          step: {
            stepType,
            description,
            stepOrder: context.stepOrder,
            metadata
          }
        });
      } catch (err) {
        console.error(`❌ Failed to send thinking step to client:`, err.message);
      }
    }

    console.log(`🧠 [${stepType}] ${description}`);
    return step;
  }

  /**
   * Add "Message received" step - call this when user message is received
   * @param {string} conversationExternalId - External conversation ID
   * @param {string} message - The user's message (truncated in description)
   */
  addMessageReceivedStep(conversationExternalId, message) {
    const preview = message.length > 50 ? message.substring(0, 50) + '...' : message;
    return this.addStep(
      conversationExternalId,
      'message_received',
      `Message received`,
      { messagePreview: preview }
    );
  }

  /**
   * Add "Function call" step - call this when a function is about to be executed
   * @param {string} conversationExternalId - External conversation ID
   * @param {string} functionName - Name of the function (e.g., report_symptom)
   * @param {Object} params - Function parameters
   * @param {string} description - Human-readable description (e.g., "Tracked symptom: headache")
   */
  addFunctionCallStep(conversationExternalId, functionName, params, description) {
    return this.addStep(
      conversationExternalId,
      'function_call',
      description,
      { functionName, params }
    );
  }

  /**
   * Add "Knowledge base access" step - call this when KB is being accessed
   * @param {string} conversationExternalId - External conversation ID
   * @param {string} vectorStoreId - Vector store ID being accessed
   * @param {Array} files - Optional list of files being searched
   */
  addKnowledgeBaseStep(conversationExternalId, vectorStoreId = null, files = null) {
    return this.addStep(
      conversationExternalId,
      'kb_access',
      'Accessing knowledge base',
      { vectorStoreId, files }
    );
  }

  /**
   * Add a custom processing step
   * @param {string} conversationExternalId - External conversation ID
   * @param {string} description - Description of what's being processed
   * @param {Object} metadata - Additional metadata
   */
  addProcessingStep(conversationExternalId, description, metadata = null) {
    return this.addStep(
      conversationExternalId,
      'processing',
      description,
      metadata
    );
  }

  /**
   * End the thinking context and save all steps to database
   * @param {string} conversationExternalId - External conversation ID
   * @returns {Promise<Array>} - Array of saved thinking steps
   */
  async endContext(conversationExternalId) {
    if (!this.drizzle) this.initialize();

    const context = this.activeContexts.get(conversationExternalId);
    if (!context) {
      console.warn(`⚠️ No active thinking context to end for: ${conversationExternalId}`);
      return [];
    }

    const duration = Date.now() - context.startTime;
    console.log(`🧠 Ending thinking context for ${conversationExternalId} (${context.steps.length} steps, ${duration}ms)`);

    // Send end signal to client
    if (context.sendCallback) {
      try {
        context.sendCallback({
          type: 'thinking_complete',
          totalSteps: context.steps.length,
          durationMs: duration
        });
      } catch (err) {
        console.error(`❌ Failed to send thinking complete to client:`, err.message);
      }
    }

    // Save to database if we have a message ID
    let savedSteps = [];
    if (context.messageId && context.steps.length > 0) {
      try {
        // Get conversation ID from external ID
        const conv = await this.drizzle
          .select()
          .from(conversations)
          .where(eq(conversations.externalId, conversationExternalId))
          .limit(1);

        if (conv.length > 0) {
          const conversationId = conv[0].id;

          // Save all steps
          for (const step of context.steps) {
            const [saved] = await this.drizzle
              .insert(thinkingSteps)
              .values({
                messageId: context.messageId,
                conversationId,
                stepType: step.stepType,
                stepDescription: step.stepDescription,
                stepOrder: step.stepOrder,
                metadata: step.metadata
              })
              .returning();

            savedSteps.push(saved);
          }

          console.log(`✅ Saved ${savedSteps.length} thinking steps to database`);
        }
      } catch (err) {
        console.error(`❌ Failed to save thinking steps:`, err.message);
      }
    }

    // Clean up context
    this.activeContexts.delete(conversationExternalId);
    return savedSteps;
  }

  /**
   * Get thinking steps for a message
   * @param {number} messageId - Database message ID
   * @returns {Promise<Array>} - Array of thinking steps
   */
  async getStepsForMessage(messageId) {
    if (!this.drizzle) this.initialize();

    const steps = await this.drizzle
      .select()
      .from(thinkingSteps)
      .where(eq(thinkingSteps.messageId, messageId))
      .orderBy(thinkingSteps.stepOrder);

    return steps;
  }

  /**
   * Get thinking steps for a conversation
   * @param {string} conversationExternalId - External conversation ID
   * @returns {Promise<Array>} - Array of thinking steps grouped by message
   */
  async getStepsForConversation(conversationExternalId) {
    if (!this.drizzle) this.initialize();

    // Get conversation
    const conv = await this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, conversationExternalId))
      .limit(1);

    if (conv.length === 0) {
      return [];
    }

    const steps = await this.drizzle
      .select()
      .from(thinkingSteps)
      .where(eq(thinkingSteps.conversationId, conv[0].id))
      .orderBy(thinkingSteps.messageId, thinkingSteps.stepOrder);

    return steps;
  }

  /**
   * Check if there's an active context for a conversation
   * @param {string} conversationExternalId - External conversation ID
   * @returns {boolean}
   */
  hasActiveContext(conversationExternalId) {
    return this.activeContexts.has(conversationExternalId);
  }

  /**
   * Get the current context for a conversation (for debugging/testing)
   * @param {string} conversationExternalId - External conversation ID
   * @returns {Object|null}
   */
  getContext(conversationExternalId) {
    return this.activeContexts.get(conversationExternalId) || null;
  }
}

// Export singleton instance
module.exports = new ThinkingService();
