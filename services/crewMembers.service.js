/**
 * Crew Members Service
 *
 * CRUD operations for the crew_members table.
 * Manages DB-based crew member definitions for dashboard-created crews.
 *
 * Used alongside file-based crews. When loading crews, file crews
 * take precedence over DB crews with the same name.
 */
const db = require('./db.pg');
const { crewMembers, agents } = require('../db/schema');
const { eq, and } = require('drizzle-orm');

class CrewMembersService {
  /**
   * Get all crew members for an agent
   *
   * @param {number} agentId - Agent ID
   * @returns {Promise<Array>} - Array of crew member objects
   */
  async getByAgentId(agentId) {
    if (!agentId) {
      return [];
    }

    try {
      const drizzle = db.getDrizzle();

      const result = await drizzle
        .select()
        .from(crewMembers)
        .where(and(
          eq(crewMembers.agentId, agentId),
          eq(crewMembers.isActive, true)
        ))
        .orderBy(crewMembers.name);

      return result.map(this._mapToCrewConfig);
    } catch (error) {
      console.error(`❌ Error getting crew members for agent ${agentId}:`, error.message);
      return [];
    }
  }

  /**
   * Get all crew members for an agent by agent name
   *
   * @param {string} agentName - Agent name
   * @returns {Promise<Array>} - Array of crew member objects
   */
  async getByAgentName(agentName) {
    if (!agentName) {
      return [];
    }

    try {
      const drizzle = db.getDrizzle();

      // First get the agent ID
      const agentResult = await drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.name, agentName))
        .limit(1);

      if (agentResult.length === 0) {
        console.log(`ℹ️ Agent not found: ${agentName}`);
        return [];
      }

      return await this.getByAgentId(agentResult[0].id);
    } catch (error) {
      console.error(`❌ Error getting crew members for agent "${agentName}":`, error.message);
      return [];
    }
  }

  /**
   * Get a single crew member by agent ID and name
   *
   * @param {number} agentId - Agent ID
   * @param {string} name - Crew member name
   * @returns {Promise<Object|null>} - Crew member config or null
   */
  async getOne(agentId, name) {
    if (!agentId || !name) {
      return null;
    }

    try {
      const drizzle = db.getDrizzle();

      const result = await drizzle
        .select()
        .from(crewMembers)
        .where(and(
          eq(crewMembers.agentId, agentId),
          eq(crewMembers.name, name)
        ))
        .limit(1);

      if (result.length === 0) {
        return null;
      }

      return this._mapToCrewConfig(result[0]);
    } catch (error) {
      console.error(`❌ Error getting crew member ${name}:`, error.message);
      return null;
    }
  }

  /**
   * Get a single crew member by agent name and crew name
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @returns {Promise<Object|null>} - Crew member config or null
   */
  async getOneByAgentName(agentName, crewName) {
    if (!agentName || !crewName) {
      return null;
    }

    try {
      const drizzle = db.getDrizzle();

      // First get the agent ID
      const agentResult = await drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.name, agentName))
        .limit(1);

      if (agentResult.length === 0) {
        return null;
      }

      return await this.getOne(agentResult[0].id, crewName);
    } catch (error) {
      console.error(`❌ Error getting crew member:`, error.message);
      return null;
    }
  }

  /**
   * Create a new crew member
   *
   * @param {number} agentId - Agent ID
   * @param {Object} config - Crew member configuration
   * @param {number} createdBy - User ID who created this
   * @returns {Promise<Object|null>} - Created crew member or null on error
   */
  async create(agentId, config, createdBy = null) {
    if (!agentId || !config.name || !config.displayName || !config.guidance) {
      console.error('❌ create requires agentId, name, displayName, and guidance');
      return null;
    }

    try {
      const drizzle = db.getDrizzle();

      // Check if crew member already exists
      const existing = await this.getOne(agentId, config.name);
      if (existing) {
        console.error(`❌ Crew member "${config.name}" already exists for this agent`);
        return null;
      }

      const now = new Date();

      const [inserted] = await drizzle
        .insert(crewMembers)
        .values({
          agentId,
          name: config.name,
          displayName: config.displayName,
          description: config.description || '',
          isDefault: config.isDefault || false,
          guidance: config.guidance,
          model: config.model || 'gpt-4o',
          maxTokens: config.maxTokens || 2048,
          knowledgeBase: config.knowledgeBase || null,
          fieldsToCollect: config.fieldsToCollect || [],
          transitionTo: config.transitionTo || null,
          transitionSystemPrompt: config.transitionSystemPrompt || null,
          tools: config.tools || [],
          isActive: true,
          createdBy,
          createdAt: now,
          updatedAt: now
        })
        .returning();

      console.log(`✅ Created crew member: ${config.name} (id=${inserted.id})`);
      return this._mapToCrewConfig(inserted);
    } catch (error) {
      console.error(`❌ Error creating crew member:`, error.message);
      return null;
    }
  }

  /**
   * Update an existing crew member
   *
   * @param {number} agentId - Agent ID
   * @param {string} name - Crew member name
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object|null>} - Updated crew member or null on error
   */
  async update(agentId, name, updates) {
    if (!agentId || !name) {
      return null;
    }

    try {
      const drizzle = db.getDrizzle();

      // Build update object (only include provided fields)
      const updateData = { updatedAt: new Date() };

      if (updates.displayName !== undefined) updateData.displayName = updates.displayName;
      if (updates.description !== undefined) updateData.description = updates.description;
      if (updates.isDefault !== undefined) updateData.isDefault = updates.isDefault;
      if (updates.guidance !== undefined) updateData.guidance = updates.guidance;
      if (updates.model !== undefined) updateData.model = updates.model;
      if (updates.maxTokens !== undefined) updateData.maxTokens = updates.maxTokens;
      if (updates.knowledgeBase !== undefined) updateData.knowledgeBase = updates.knowledgeBase;
      if (updates.fieldsToCollect !== undefined) updateData.fieldsToCollect = updates.fieldsToCollect;
      if (updates.transitionTo !== undefined) updateData.transitionTo = updates.transitionTo;
      if (updates.transitionSystemPrompt !== undefined) updateData.transitionSystemPrompt = updates.transitionSystemPrompt;
      if (updates.tools !== undefined) updateData.tools = updates.tools;
      if (updates.isActive !== undefined) updateData.isActive = updates.isActive;

      const [updated] = await drizzle
        .update(crewMembers)
        .set(updateData)
        .where(and(
          eq(crewMembers.agentId, agentId),
          eq(crewMembers.name, name)
        ))
        .returning();

      if (!updated) {
        console.log(`ℹ️ Crew member not found: ${name}`);
        return null;
      }

      console.log(`✅ Updated crew member: ${name}`);
      return this._mapToCrewConfig(updated);
    } catch (error) {
      console.error(`❌ Error updating crew member:`, error.message);
      return null;
    }
  }

  /**
   * Delete a crew member (soft delete - sets isActive to false)
   *
   * @param {number} agentId - Agent ID
   * @param {string} name - Crew member name
   * @returns {Promise<boolean>} - Success status
   */
  async delete(agentId, name) {
    if (!agentId || !name) {
      return false;
    }

    try {
      const drizzle = db.getDrizzle();

      const result = await drizzle
        .update(crewMembers)
        .set({
          isActive: false,
          updatedAt: new Date()
        })
        .where(and(
          eq(crewMembers.agentId, agentId),
          eq(crewMembers.name, name)
        ))
        .returning({ id: crewMembers.id });

      if (result.length === 0) {
        console.log(`ℹ️ Crew member not found: ${name}`);
        return false;
      }

      console.log(`🗑️ Deleted (soft) crew member: ${name}`);
      return true;
    } catch (error) {
      console.error(`❌ Error deleting crew member:`, error.message);
      return false;
    }
  }

  /**
   * Hard delete a crew member (permanently remove from DB)
   *
   * @param {number} agentId - Agent ID
   * @param {string} name - Crew member name
   * @returns {Promise<boolean>} - Success status
   */
  async hardDelete(agentId, name) {
    if (!agentId || !name) {
      return false;
    }

    try {
      const drizzle = db.getDrizzle();

      const result = await drizzle
        .delete(crewMembers)
        .where(and(
          eq(crewMembers.agentId, agentId),
          eq(crewMembers.name, name)
        ))
        .returning({ id: crewMembers.id });

      if (result.length === 0) {
        return false;
      }

      console.log(`🗑️ Hard deleted crew member: ${name}`);
      return true;
    } catch (error) {
      console.error(`❌ Error hard deleting crew member:`, error.message);
      return false;
    }
  }

  /**
   * Get agent ID by name (helper method)
   *
   * @param {string} agentName - Agent name
   * @returns {Promise<number|null>} - Agent ID or null
   */
  async getAgentId(agentName) {
    try {
      const drizzle = db.getDrizzle();

      const result = await drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.name, agentName))
        .limit(1);

      return result.length > 0 ? result[0].id : null;
    } catch (error) {
      console.error(`❌ Error getting agent ID:`, error.message);
      return null;
    }
  }

  /**
   * Map DB row to crew config object (matches CrewMember constructor format)
   * @private
   */
  _mapToCrewConfig(row) {
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      description: row.description || '',
      isDefault: row.isDefault,
      guidance: row.guidance,
      model: row.model,
      maxTokens: row.maxTokens,
      knowledgeBase: row.knowledgeBase,
      fieldsToCollect: row.fieldsToCollect || [],
      transitionTo: row.transitionTo,
      transitionSystemPrompt: row.transitionSystemPrompt,
      tools: row.tools || [],
      isActive: row.isActive,
      source: 'database', // Mark as DB-sourced
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
}

// Export singleton instance
module.exports = new CrewMembersService();
