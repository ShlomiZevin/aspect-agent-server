/**
 * Agent Context Service
 *
 * Manages collected fields per conversation. Uses an in-memory cache
 * backed by conversation metadata in the database.
 *
 * Fields are global across all crew members in a conversation,
 * allowing any crew member to access data collected by others.
 */
const conversationService = require('./conversation.service');

class AgentContextService {
  constructor() {
    // In-memory cache: conversationExternalId -> { collectedFields: {} }
    this.cache = new Map();
  }

  /**
   * Get all collected fields for a conversation
   * Checks cache first, then loads from DB on cache miss
   *
   * @param {string} conversationId - External conversation ID
   * @returns {Promise<Object>} - Collected fields object { fieldName: value, ... }
   */
  async getCollectedFields(conversationId) {
    if (this.cache.has(conversationId)) {
      return { ...this.cache.get(conversationId) };
    }

    // Cache miss - load from conversation metadata
    await this._loadFromConversation(conversationId);
    return { ...(this.cache.get(conversationId) || {}) };
  }

  /**
   * Update collected fields for a conversation
   * Merges new fields into existing ones, updates cache and persists to DB
   *
   * @param {string} conversationId - External conversation ID
   * @param {Object} newFields - Fields to merge { fieldName: value, ... }
   * @returns {Promise<Object>} - Updated collected fields
   */
  async updateCollectedFields(conversationId, newFields) {
    if (!newFields || Object.keys(newFields).length === 0) {
      return this.getCollectedFields(conversationId);
    }

    // Ensure cache is loaded
    if (!this.cache.has(conversationId)) {
      await this._loadFromConversation(conversationId);
    }

    const current = this.cache.get(conversationId) || {};
    const updated = { ...current, ...newFields };
    this.cache.set(conversationId, updated);

    // Persist to conversation metadata
    await this._persistToConversation(conversationId, updated);

    return { ...updated };
  }

  /**
   * Get fields that haven't been collected yet
   *
   * @param {string} conversationId - External conversation ID
   * @param {Array} fieldsToCollect - Array of { name, description } field definitions
   * @returns {Promise<Array>} - Array of { name, description } for uncollected fields
   */
  async getMissingFields(conversationId, fieldsToCollect) {
    const collected = await this.getCollectedFields(conversationId);
    return fieldsToCollect.filter(field => !collected[field.name]);
  }

  /**
   * Load collected fields from conversation metadata into cache
   *
   * @param {string} conversationId - External conversation ID
   * @private
   */
  async _loadFromConversation(conversationId) {
    try {
      const conversation = await conversationService.getConversationByExternalId(conversationId);
      const fields = conversation?.metadata?.collectedFields || {};
      this.cache.set(conversationId, fields);
    } catch (err) {
      console.warn(`⚠️ Could not load collected fields for ${conversationId}:`, err.message);
      this.cache.set(conversationId, {});
    }
  }

  /**
   * Persist collected fields to conversation metadata in DB
   *
   * @param {string} conversationId - External conversation ID
   * @param {Object} collectedFields - Fields to persist
   * @private
   */
  async _persistToConversation(conversationId, collectedFields) {
    try {
      await conversationService.updateConversationMetadata(conversationId, {
        collectedFields
      });
    } catch (err) {
      console.error(`❌ Failed to persist collected fields for ${conversationId}:`, err.message);
    }
  }

  /**
   * Clear cached fields for a conversation (useful for cleanup)
   *
   * @param {string} conversationId - External conversation ID
   */
  clearCache(conversationId) {
    this.cache.delete(conversationId);
  }
}

// Export singleton instance
module.exports = new AgentContextService();
