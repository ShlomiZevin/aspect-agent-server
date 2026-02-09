const db = require('./db.pg');
const { crewPrompts, agents } = require('../db/schema');
const { eq, and, desc } = require('drizzle-orm');

/**
 * Prompt Service
 *
 * Manages versioned prompts for crew members.
 * Supports:
 * - Storing prompts in DB with versioning
 * - Fallback to code-defined prompts when no DB version exists
 * - Session overrides (temporary prompts per conversation)
 */
class PromptService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Get agent by name
   */
  async getAgentByName(agentName) {
    if (!this.drizzle) this.initialize();

    const [agent] = await this.drizzle
      .select()
      .from(agents)
      .where(eq(agents.name, agentName))
      .limit(1);

    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    return agent;
  }

  /**
   * Get all prompt versions for a crew member
   */
  async getPromptVersions(agentName, crewMemberName) {
    if (!this.drizzle) this.initialize();

    const agent = await this.getAgentByName(agentName);

    const versions = await this.drizzle
      .select({
        id: crewPrompts.id,
        version: crewPrompts.version,
        name: crewPrompts.name,
        prompt: crewPrompts.prompt,
        transitionSystemPrompt: crewPrompts.transitionSystemPrompt,
        isActive: crewPrompts.isActive,
        createdAt: crewPrompts.createdAt,
        updatedAt: crewPrompts.updatedAt,
      })
      .from(crewPrompts)
      .where(and(
        eq(crewPrompts.agentId, agent.id),
        eq(crewPrompts.crewMemberName, crewMemberName)
      ))
      .orderBy(desc(crewPrompts.version));

    return versions;
  }

  /**
   * Get the active prompt for a crew member
   * Returns null if no DB prompt exists (fallback to code)
   */
  async getActivePrompt(agentName, crewMemberName) {
    if (!this.drizzle) this.initialize();

    const agent = await this.getAgentByName(agentName);

    const [activePrompt] = await this.drizzle
      .select({
        id: crewPrompts.id,
        version: crewPrompts.version,
        name: crewPrompts.name,
        prompt: crewPrompts.prompt,
        transitionSystemPrompt: crewPrompts.transitionSystemPrompt,
        isActive: crewPrompts.isActive,
        createdAt: crewPrompts.createdAt,
        updatedAt: crewPrompts.updatedAt,
      })
      .from(crewPrompts)
      .where(and(
        eq(crewPrompts.agentId, agent.id),
        eq(crewPrompts.crewMemberName, crewMemberName),
        eq(crewPrompts.isActive, true)
      ))
      .limit(1);

    return activePrompt || null;
  }

  /**
   * Get prompts for all crew members of an agent
   */
  async getAllCrewPrompts(agentName) {
    if (!this.drizzle) this.initialize();

    const agent = await this.getAgentByName(agentName);

    // Get all prompts grouped by crew member
    const allPrompts = await this.drizzle
      .select({
        id: crewPrompts.id,
        crewMemberName: crewPrompts.crewMemberName,
        version: crewPrompts.version,
        name: crewPrompts.name,
        prompt: crewPrompts.prompt,
        transitionSystemPrompt: crewPrompts.transitionSystemPrompt,
        isActive: crewPrompts.isActive,
        createdAt: crewPrompts.createdAt,
        updatedAt: crewPrompts.updatedAt,
      })
      .from(crewPrompts)
      .where(eq(crewPrompts.agentId, agent.id))
      .orderBy(crewPrompts.crewMemberName, desc(crewPrompts.version));

    // Group by crew member
    const byCrewMember = new Map();
    for (const prompt of allPrompts) {
      if (!byCrewMember.has(prompt.crewMemberName)) {
        byCrewMember.set(prompt.crewMemberName, {
          crewMemberId: prompt.crewMemberName,
          crewMemberName: prompt.crewMemberName,
          versions: [],
          currentVersion: null,
        });
      }
      const crew = byCrewMember.get(prompt.crewMemberName);
      crew.versions.push({
        id: String(prompt.id),
        version: prompt.version,
        name: prompt.name,
        prompt: prompt.prompt,
        transitionSystemPrompt: prompt.transitionSystemPrompt,
        isActive: prompt.isActive,
        createdAt: prompt.createdAt?.toISOString(),
        updatedAt: prompt.updatedAt?.toISOString(),
      });
      if (prompt.isActive) {
        crew.currentVersion = crew.versions[crew.versions.length - 1];
      }
    }

    return Array.from(byCrewMember.values());
  }

  /**
   * Create a new prompt version
   * @param {string} agentName - Agent name
   * @param {string} crewMemberName - Crew member name
   * @param {string} prompt - Main prompt text
   * @param {string} name - Version name/tag
   * @param {number} createdBy - User ID who created this version
   * @param {string} transitionSystemPrompt - System prompt injected on crew transition
   */
  async createPromptVersion(agentName, crewMemberName, prompt, name = null, createdBy = null, transitionSystemPrompt = null) {
    if (!this.drizzle) this.initialize();

    const agent = await this.getAgentByName(agentName);

    // Get the latest version number
    const versions = await this.getPromptVersions(agentName, crewMemberName);
    const nextVersion = versions.length > 0 ? versions[0].version + 1 : 1;

    // Deactivate all existing versions for this crew member
    await this.drizzle
      .update(crewPrompts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(
        eq(crewPrompts.agentId, agent.id),
        eq(crewPrompts.crewMemberName, crewMemberName)
      ));

    // Insert new version as active
    const [newVersion] = await this.drizzle
      .insert(crewPrompts)
      .values({
        agentId: agent.id,
        crewMemberName,
        version: nextVersion,
        name,
        prompt,
        transitionSystemPrompt,
        isActive: true,
        createdBy,
      })
      .returning();

    return {
      id: String(newVersion.id),
      version: newVersion.version,
      name: newVersion.name,
      prompt: newVersion.prompt,
      transitionSystemPrompt: newVersion.transitionSystemPrompt,
      isActive: newVersion.isActive,
      createdAt: newVersion.createdAt?.toISOString(),
      updatedAt: newVersion.updatedAt?.toISOString(),
    };
  }

  /**
   * Update an existing prompt version (overwrite)
   * @param {string} agentName - Agent name
   * @param {string} crewMemberName - Crew member name
   * @param {string} versionId - Version ID to update
   * @param {string} prompt - Main prompt text
   * @param {string} transitionSystemPrompt - System prompt injected on crew transition (optional)
   */
  async updatePromptVersion(agentName, crewMemberName, versionId, prompt, transitionSystemPrompt = undefined) {
    if (!this.drizzle) this.initialize();

    const agent = await this.getAgentByName(agentName);

    const updateData = {
      prompt,
      updatedAt: new Date(),
    };

    // Only update transitionSystemPrompt if explicitly provided (allows setting to null)
    if (transitionSystemPrompt !== undefined) {
      updateData.transitionSystemPrompt = transitionSystemPrompt;
    }

    const [updated] = await this.drizzle
      .update(crewPrompts)
      .set(updateData)
      .where(and(
        eq(crewPrompts.id, versionId),
        eq(crewPrompts.agentId, agent.id),
        eq(crewPrompts.crewMemberName, crewMemberName)
      ))
      .returning();

    if (!updated) {
      throw new Error(`Prompt version not found: ${versionId}`);
    }

    return {
      id: String(updated.id),
      version: updated.version,
      name: updated.name,
      prompt: updated.prompt,
      transitionSystemPrompt: updated.transitionSystemPrompt,
      isActive: updated.isActive,
      createdAt: updated.createdAt?.toISOString(),
      updatedAt: updated.updatedAt?.toISOString(),
    };
  }

  /**
   * Activate a specific version (make it the current one)
   */
  async activateVersion(agentName, crewMemberName, versionId) {
    if (!this.drizzle) this.initialize();

    const agent = await this.getAgentByName(agentName);

    // Deactivate all versions
    await this.drizzle
      .update(crewPrompts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(
        eq(crewPrompts.agentId, agent.id),
        eq(crewPrompts.crewMemberName, crewMemberName)
      ));

    // Activate the specified version
    const [activated] = await this.drizzle
      .update(crewPrompts)
      .set({ isActive: true, updatedAt: new Date() })
      .where(and(
        eq(crewPrompts.id, versionId),
        eq(crewPrompts.agentId, agent.id),
        eq(crewPrompts.crewMemberName, crewMemberName)
      ))
      .returning();

    if (!activated) {
      throw new Error(`Prompt version not found: ${versionId}`);
    }

    return {
      id: String(activated.id),
      version: activated.version,
      name: activated.name,
      prompt: activated.prompt,
      transitionSystemPrompt: activated.transitionSystemPrompt,
      isActive: activated.isActive,
      createdAt: activated.createdAt?.toISOString(),
      updatedAt: activated.updatedAt?.toISOString(),
    };
  }

  /**
   * Delete a prompt version
   * Cannot delete the active version
   */
  async deleteVersion(agentName, crewMemberName, versionId) {
    if (!this.drizzle) this.initialize();

    const agent = await this.getAgentByName(agentName);

    // Check if this version is active
    const [version] = await this.drizzle
      .select()
      .from(crewPrompts)
      .where(and(
        eq(crewPrompts.id, versionId),
        eq(crewPrompts.agentId, agent.id),
        eq(crewPrompts.crewMemberName, crewMemberName)
      ))
      .limit(1);

    if (!version) {
      throw new Error(`Prompt version not found: ${versionId}`);
    }

    if (version.isActive) {
      throw new Error('Cannot delete active version. Activate another version first.');
    }

    // Delete the version
    await this.drizzle
      .delete(crewPrompts)
      .where(and(
        eq(crewPrompts.id, versionId),
        eq(crewPrompts.agentId, agent.id),
        eq(crewPrompts.crewMemberName, crewMemberName)
      ));

    console.log(`   🗑️ Deleted prompt version ${crewMemberName} #${versionId}`);
  }

  /**
   * Initialize prompts from code-defined crew members
   * This seeds the database with the first version of each crew member's prompt
   */
  async seedFromCrewMember(agentName, crewMember) {
    if (!this.drizzle) this.initialize();

    // Check if any version exists
    const existing = await this.getPromptVersions(agentName, crewMember.name);
    if (existing.length > 0) {
      console.log(`   Prompts already exist for ${crewMember.name}, skipping`);
      return null;
    }

    // Create first version from code (including transition system prompt if defined)
    const version = await this.createPromptVersion(
      agentName,
      crewMember.name,
      crewMember.guidance,
      'Initial version (from code)',
      null,
      crewMember.transitionSystemPrompt || null
    );

    console.log(`   ✅ Seeded prompt for ${crewMember.name} v${version.version}`);
    return version;
  }
}

module.exports = new PromptService();
