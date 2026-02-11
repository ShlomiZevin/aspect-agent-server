/**
 * Context Service
 *
 * CRUD operations for the context_data table.
 * Provides generic context storage at user level (and later conversation level).
 *
 * Used by crew members to read/write contextual data across sessions.
 */
const db = require('./db.pg');
const { contextData } = require('../db/schema');
const { eq, and, isNull } = require('drizzle-orm');

class ContextService {
  /**
   * Get context data for a user by namespace
   *
   * @param {number} userId - User ID
   * @param {string} namespace - Context namespace (e.g., 'journey', 'preferences')
   * @param {number|null} conversationId - Optional conversation ID for conversation-level context
   * @returns {Promise<Object|null>} - Context data or null if not found
   */
  async getContext(userId, namespace, conversationId = null) {
    if (!userId || !namespace) {
      return null;
    }

    try {
      const drizzle = db.getDrizzle();

      const conditions = [
        eq(contextData.userId, userId),
        eq(contextData.namespace, namespace)
      ];

      // Add conversation condition
      if (conversationId) {
        conditions.push(eq(contextData.conversationId, conversationId));
      } else {
        conditions.push(isNull(contextData.conversationId));
      }

      const result = await drizzle
        .select()
        .from(contextData)
        .where(and(...conditions))
        .limit(1);

      if (result.length === 0) {
        return null;
      }

      return result[0].data;
    } catch (error) {
      console.error(`❌ Error getting context (userId=${userId}, namespace=${namespace}):`, error.message);
      return null;
    }
  }

  /**
   * Get multiple context namespaces for a user
   *
   * @param {number} userId - User ID
   * @param {string[]} namespaces - Array of namespace names
   * @param {number|null} conversationId - Optional conversation ID
   * @returns {Promise<Object>} - Object with namespace keys and data values
   */
  async getContextMultiple(userId, namespaces, conversationId = null) {
    if (!userId || !namespaces || namespaces.length === 0) {
      return {};
    }

    const result = {};
    for (const namespace of namespaces) {
      result[namespace] = await this.getContext(userId, namespace, conversationId);
    }
    return result;
  }

  /**
   * Save/update context data for a user
   *
   * @param {number} userId - User ID
   * @param {string} namespace - Context namespace
   * @param {Object} data - Context data to save
   * @param {number|null} conversationId - Optional conversation ID for conversation-level context
   * @returns {Promise<boolean>} - Success status
   */
  async saveContext(userId, namespace, data, conversationId = null) {
    if (!userId || !namespace) {
      console.error('❌ saveContext requires userId and namespace');
      return false;
    }

    try {
      const drizzle = db.getDrizzle();

      // Check if context already exists
      const existing = await this.getContext(userId, namespace, conversationId);

      if (existing !== null) {
        // Update existing
        const conditions = [
          eq(contextData.userId, userId),
          eq(contextData.namespace, namespace)
        ];

        if (conversationId) {
          conditions.push(eq(contextData.conversationId, conversationId));
        } else {
          conditions.push(isNull(contextData.conversationId));
        }

        await drizzle
          .update(contextData)
          .set({
            data: data,
            updatedAt: new Date()
          })
          .where(and(...conditions));

        console.log(`📝 Updated context: userId=${userId}, namespace=${namespace}`);
      } else {
        // Insert new
        await drizzle
          .insert(contextData)
          .values({
            userId,
            conversationId,
            namespace,
            data,
            createdAt: new Date(),
            updatedAt: new Date()
          });

        console.log(`📝 Created context: userId=${userId}, namespace=${namespace}`);
      }

      return true;
    } catch (error) {
      console.error(`❌ Error saving context (userId=${userId}, namespace=${namespace}):`, error.message);
      return false;
    }
  }

  /**
   * Merge data into existing context (shallow merge)
   *
   * @param {number} userId - User ID
   * @param {string} namespace - Context namespace
   * @param {Object} data - Data to merge
   * @param {number|null} conversationId - Optional conversation ID
   * @returns {Promise<boolean>} - Success status
   */
  async mergeContext(userId, namespace, data, conversationId = null) {
    const existing = await this.getContext(userId, namespace, conversationId) || {};
    const merged = { ...existing, ...data };
    return await this.saveContext(userId, namespace, merged, conversationId);
  }

  /**
   * Delete context for a user/namespace
   *
   * @param {number} userId - User ID
   * @param {string} namespace - Context namespace
   * @param {number|null} conversationId - Optional conversation ID
   * @returns {Promise<boolean>} - Success status
   */
  async deleteContext(userId, namespace, conversationId = null) {
    if (!userId || !namespace) {
      return false;
    }

    try {
      const drizzle = db.getDrizzle();

      const conditions = [
        eq(contextData.userId, userId),
        eq(contextData.namespace, namespace)
      ];

      if (conversationId) {
        conditions.push(eq(contextData.conversationId, conversationId));
      } else {
        conditions.push(isNull(contextData.conversationId));
      }

      await drizzle
        .delete(contextData)
        .where(and(...conditions));

      console.log(`🗑️ Deleted context: userId=${userId}, namespace=${namespace}`);
      return true;
    } catch (error) {
      console.error(`❌ Error deleting context:`, error.message);
      return false;
    }
  }

  /**
   * List all context namespaces for a user
   *
   * @param {number} userId - User ID
   * @param {number|null} conversationId - Optional conversation ID (null = user-level only)
   * @returns {Promise<string[]>} - Array of namespace names
   */
  async listNamespaces(userId, conversationId = null) {
    if (!userId) {
      return [];
    }

    try {
      const drizzle = db.getDrizzle();

      const conditions = [eq(contextData.userId, userId)];

      if (conversationId) {
        conditions.push(eq(contextData.conversationId, conversationId));
      } else {
        conditions.push(isNull(contextData.conversationId));
      }

      const result = await drizzle
        .select({ namespace: contextData.namespace })
        .from(contextData)
        .where(and(...conditions));

      return result.map(r => r.namespace);
    } catch (error) {
      console.error(`❌ Error listing namespaces:`, error.message);
      return [];
    }
  }
}

// Export singleton instance
module.exports = new ContextService();
