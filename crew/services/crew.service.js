/**
 * Crew Service
 *
 * Loads and manages crew member classes for agents.
 * Crew members are loaded from two sources:
 * 1. File-based: /agents/<agentName>/crew/ folders (custom logic, production)
 * 2. DB-based: crew_members table (dashboard-created, quick iteration)
 *
 * File-based crews take precedence over DB crews with the same name.
 */
const path = require('path');
const fs = require('fs');
const DynamicCrewMember = require('../base/DynamicCrewMember');
const crewMembersService = require('../../services/crewMembers.service');

class CrewService {
  constructor() {
    // Map of agentName -> Map of crewName -> CrewMember instance
    this.crews = new Map();
  }

  /**
   * Resolve the crew folder path for an agent name.
   * Tries multiple normalizations since agent names (e.g. "Freeda 2.0")
   * may not directly match folder names (e.g. "freeda").
   *
   * @param {string} agentName - Agent name from database
   * @returns {string|null} - Resolved path or null
   */
  resolveCrewPath(agentName) {
    const agentsDir = path.join(__dirname, '..', '..', 'agents');

    // Build list of candidate folder names to try
    const candidates = [
      agentName,                                                    // Exact: "Freeda 2.0"
      agentName.toLowerCase(),                                      // Lower: "freeda 2.0"
      agentName.toLowerCase().replace(/[\s.]+/g, '-'),              // Dashed: "freeda-2-0"
      agentName.toLowerCase().replace(/[\s.]+/g, '-').replace(/-+$/, ''), // Trim trailing dash
      agentName.toLowerCase().replace(/[\s.\d]+/g, '').trim(),      // Alpha only: "freeda"
      agentName.toLowerCase().split(/[\s.]/)[0],                    // First word: "freeda"
    ];

    // Deduplicate
    const unique = [...new Set(candidates)];

    for (const candidate of unique) {
      const candidatePath = path.join(agentsDir, candidate, 'crew');
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    return null;
  }

  /**
   * Load all crew members for an agent from both files and database.
   * File-based crews take precedence over DB crews with the same name.
   *
   * @param {string} agentName - Name of the agent (folder name)
   * @returns {Map} - Map of crew name to CrewMember instance
   */
  async loadCrewForAgent(agentName) {
    // Return cached if available
    if (this.crews.has(agentName)) {
      return this.crews.get(agentName);
    }

    const crewMap = new Map();

    // Step 1: Load DB-based crews first (lower precedence)
    try {
      const dbCrews = await crewMembersService.getByAgentName(agentName);
      for (const config of dbCrews) {
        try {
          const instance = new DynamicCrewMember(config);
          crewMap.set(instance.name, instance);
          console.log(`   📦 Loaded DB crew member: ${instance.name} (${instance.displayName})`);
        } catch (err) {
          console.warn(`   ⚠️ Failed to instantiate DB crew ${config.name}:`, err.message);
        }
      }
      if (dbCrews.length > 0) {
        console.log(`📦 Loaded ${dbCrews.length} DB crew members for agent: ${agentName}`);
      }
    } catch (error) {
      console.warn(`⚠️ Error loading DB crews for agent ${agentName}:`, error.message);
    }

    // Step 2: Load file-based crews (higher precedence - will overwrite DB crews with same name)
    const crewPath = this.resolveCrewPath(agentName);

    try {
      if (crewPath) {
        // Load crew module
        const crewModule = require(crewPath);

        // Iterate through exported crew classes
        for (const [exportName, CrewClass] of Object.entries(crewModule)) {
          // Skip non-class exports
          if (typeof CrewClass !== 'function') {
            continue;
          }

          try {
            // Instantiate the crew member
            const instance = new CrewClass();
            instance.source = 'file'; // Mark as file-sourced

            // Verify it has required properties
            if (instance.name) {
              // Check if we're overwriting a DB crew
              if (crewMap.has(instance.name)) {
                console.log(`   🔄 File crew "${instance.name}" overrides DB crew`);
              }
              crewMap.set(instance.name, instance);
              console.log(`   📁 Loaded file crew member: ${instance.name} (${instance.displayName})`);
            }
          } catch (err) {
            console.warn(`   ⚠️ Failed to instantiate crew class ${exportName}:`, err.message);
          }
        }
      } else {
        console.log(`ℹ️ No crew folder found for agent: ${agentName}`);
      }
    } catch (error) {
      console.warn(`⚠️ Error loading file crews for agent ${agentName}:`, error.message);
    }

    console.log(`✅ Total ${crewMap.size} crew members loaded for agent: ${agentName}`);
    this.crews.set(agentName, crewMap);
    return crewMap;
  }

  /**
   * Get a specific crew member by name
   *
   * @param {string} agentName - Name of the agent
   * @param {string} crewName - Name of the crew member
   * @returns {CrewMember|null}
   */
  async getCrewMember(agentName, crewName) {
    const crewMap = await this.loadCrewForAgent(agentName);
    return crewMap.get(crewName) || null;
  }

  /**
   * Get the default crew member for an agent
   *
   * @param {string} agentName - Name of the agent
   * @returns {CrewMember|null}
   */
  async getDefaultCrew(agentName) {
    const crewMap = await this.loadCrewForAgent(agentName);

    // Find crew member with isDefault = true
    for (const crew of crewMap.values()) {
      if (crew.isDefault) {
        return crew;
      }
    }

    // Return first crew member if no default specified
    const firstCrew = crewMap.values().next().value;
    return firstCrew || null;
  }

  /**
   * List all crew members for an agent
   *
   * @param {string} agentName - Name of the agent
   * @returns {Array} - Array of crew member info (JSON serialized)
   */
  async listCrew(agentName) {
    const crewMap = await this.loadCrewForAgent(agentName);
    return Array.from(crewMap.values()).map(crew => crew.toJSON());
  }

  /**
   * Check if an agent has crew members
   *
   * @param {string} agentName - Name of the agent
   * @returns {boolean}
   */
  async hasCrew(agentName) {
    const crewMap = await this.loadCrewForAgent(agentName);
    return crewMap.size > 0;
  }

  /**
   * Reload crew members for an agent (useful for development)
   *
   * @param {string} agentName - Name of the agent
   * @returns {Map} - Fresh map of crew members
   */
  async reloadCrew(agentName) {
    // Clear cache
    this.crews.delete(agentName);

    // Clear require cache for the crew module
    const crewPath = this.resolveCrewPath(agentName);
    if (crewPath) {
      try {
        const resolvedPath = require.resolve(crewPath);
        delete require.cache[resolvedPath];
      } catch (e) {
        // Module not in cache, that's fine
      }
    }

    // Reload
    return this.loadCrewForAgent(agentName);
  }

  /**
   * Get all loaded agents with crews
   *
   * @returns {Array} - Array of agent names that have crews loaded
   */
  getLoadedAgents() {
    return Array.from(this.crews.keys());
  }
}

// Export singleton instance
module.exports = new CrewService();
