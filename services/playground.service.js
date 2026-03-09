/**
 * Playground Service
 *
 * Manages ephemeral playground crew members in memory.
 * Each playground session creates a DynamicCrewMember registered with the crew service,
 * allowing reuse of the entire streaming/dispatcher infrastructure.
 *
 * Also supports saving playground configs to GCS and exporting to file.
 */
const DynamicCrewMember = require('../crew/base/DynamicCrewMember');
const crewService = require('../crew/services/crew.service');
const storageService = require('./storage.service');

const GCS_PLAYGROUND_PREFIX = 'playground-configs';

class PlaygroundService {
  constructor() {
    // Map of sessionId -> { crewMember, config, agentName, crewName, createdAt }
    this.sessions = new Map();
  }

  /**
   * Register a playground crew from config.
   * Creates a DynamicCrewMember and adds it to crew service's in-memory map.
   *
   * @param {string} sessionId - Unique playground session ID
   * @param {string} agentName - Agent context (for KB scoping)
   * @param {object} config - Crew configuration
   * @returns {{ crewName: string, agentName: string }}
   */
  async register(sessionId, agentName, config) {
    const crewName = `playground-${sessionId}`;

    // Build the crew member instance
    const crew = new DynamicCrewMember({
      name: crewName,
      displayName: config.displayName || 'Playground Crew',
      description: config.description || 'Playground test crew',
      guidance: this._buildGuidance(config),
      model: config.model || 'gpt-5',
      maxTokens: config.maxTokens || 2048,
      isDefault: false, // Don't interfere with agent's real default crew
      knowledgeBase: config.kbSources && config.kbSources.length > 0 ? {
        enabled: true,
        sources: config.kbSources
      } : null,
      fieldsToCollect: config.fieldsToCollect || [],
    });

    // Set thinker properties
    if (config.mode === 'thinker' && config.thinkingPrompt) {
      crew.usesThinker = true;
      crew.thinkingPrompt = config.thinkingPrompt;
      crew.thinkingModel = config.thinkingModel || 'claude-sonnet-4-20250514';
    }

    // Set persona
    if (config.persona) {
      crew.persona = config.persona;
    }

    // Set mock tools with handlers that return mock responses
    if (config.tools && config.tools.length > 0) {
      crew.tools = config.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {} },
        handler: async (params) => {
          console.log(`🎭 [Playground] Mock tool called: ${tool.name}`, params);
          return tool.mockResponse || { mock: true, tool: tool.name };
        }
      }));
    }

    // Register with crew service under the REAL agent name.
    // The crew name is unique (playground-{sessionId}) so it won't clash.
    // This way the stream endpoint's DB agent lookup works as-is.
    // We use overrideCrewMember on the client to route to this crew.
    const crewMap = await crewService.loadCrewForAgent(agentName);
    crewMap.set(crewName, crew);

    // Store session
    this.sessions.set(sessionId, {
      crewMember: crew,
      config,
      agentName, // Real agent name
      crewName,
      createdAt: new Date()
    });

    console.log(`🎮 [Playground] Registered crew "${crewName}" under agent "${agentName}"`);
    return { crewName, agentName };
  }

  /**
   * Build the full guidance text from config (guidance + context injection).
   * @private
   */
  _buildGuidance(config) {
    let guidance = config.guidance || '';

    // Inject pre-loaded context into guidance
    if (config.context && Object.keys(config.context).length > 0) {
      guidance += '\n\n## Context (information already known)\n';
      for (const [key, value] of Object.entries(config.context)) {
        guidance += `- ${key}: ${JSON.stringify(value)}\n`;
      }
    }

    return guidance;
  }

  /**
   * Update an existing playground crew's config.
   * Re-registers with updated properties.
   */
  async update(sessionId, config) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Playground session not found');
    return this.register(sessionId, session.agentName, config);
  }

  /**
   * Get session info.
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Remove a playground session and clean up.
   */
  remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Remove only the playground crew from the agent's crew map (not the whole agent)
      const crewMap = crewService.crews.get(session.agentName);
      if (crewMap) {
        crewMap.delete(session.crewName);
      }
      this.sessions.delete(sessionId);
      console.log(`🎮 [Playground] Removed session: ${sessionId}`);
    }
  }

  // ========== SAVE / EXPORT ==========

  /**
   * Save a playground config to GCS for later retrieval.
   *
   * @param {string} agentName - Original agent name (not playground prefixed)
   * @param {string} name - User-given name for this config
   * @param {object} config - The playground config to save
   * @returns {Promise<{id: string, name: string, savedAt: string}>}
   */
  async saveToGCS(agentName, name, config) {
    const id = Date.now().toString();
    const gcsPath = `${GCS_PLAYGROUND_PREFIX}/${agentName}/${id}.json`;

    const data = JSON.stringify({ name, config, savedAt: new Date().toISOString() }, null, 2);
    const file = storageService.getBucket().file(gcsPath);
    await file.save(Buffer.from(data, 'utf8'), {
      metadata: { contentType: 'application/json', metadata: { name } }
    });

    console.log(`💾 [Playground] Config saved to GCS: ${gcsPath} (name: "${name}")`);
    return { id, name, savedAt: new Date().toISOString() };
  }

  /**
   * List all saved playground configs from GCS.
   *
   * @param {string} agentName - Original agent name
   * @returns {Promise<Array<{id: string, name: string, savedAt: string}>>}
   */
  async listSavedConfigs(agentName) {
    try {
      const prefix = `${GCS_PLAYGROUND_PREFIX}/${agentName}/`;
      const [files] = await storageService.getBucket().getFiles({ prefix });

      const configs = [];
      for (const file of files) {
        try {
          const [content] = await file.download();
          const data = JSON.parse(content.toString('utf8'));
          const id = file.name.split('/').pop().replace('.json', '');
          configs.push({ id, name: data.name, savedAt: data.savedAt });
        } catch (err) {
          console.warn(`⚠️ [Playground] Failed to read config: ${file.name}`);
        }
      }

      return configs.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } catch (err) {
      console.warn(`⚠️ [Playground] Failed to list configs: ${err.message}`);
      return [];
    }
  }

  /**
   * Load a saved playground config from GCS.
   *
   * @param {string} agentName - Original agent name
   * @param {string} id - Config ID (timestamp)
   * @returns {Promise<{name: string, config: object, savedAt: string}>}
   */
  async loadConfig(agentName, id) {
    const gcsPath = `${GCS_PLAYGROUND_PREFIX}/${agentName}/${id}.json`;
    const file = storageService.getBucket().file(gcsPath);
    const [content] = await file.download();
    return JSON.parse(content.toString('utf8'));
  }

  /**
   * Delete a saved playground config from GCS.
   *
   * @param {string} agentName - Original agent name
   * @param {string} id - Config ID
   */
  async deleteConfig(agentName, id) {
    const gcsPath = `${GCS_PLAYGROUND_PREFIX}/${agentName}/${id}.json`;
    const file = storageService.getBucket().file(gcsPath);
    await file.delete();
    console.log(`🗑️ [Playground] Config deleted: ${gcsPath}`);
  }

  /**
   * Export a playground config as a .crew.js file string.
   * Generates a file-based crew member source that can be placed in the agents folder.
   *
   * @param {object} config - The playground config
   * @returns {string} - The .crew.js file content
   */
  exportToCrewFile(config) {
    const className = (config.displayName || 'PlaygroundCrew')
      .replace(/[^a-zA-Z0-9]/g, '')
      .replace(/^[a-z]/, c => c.toUpperCase());

    const toolsDef = (config.tools || []).map(t => `    {
      name: '${t.name}',
      description: '${(t.description || '').replace(/'/g, "\\'")}',
      parameters: ${JSON.stringify(t.parameters || { type: 'object', properties: {} }, null, 6).replace(/\n/g, '\n      ')},
      handler: async (params) => {
        // TODO: Implement real handler
        return ${JSON.stringify(t.mockResponse || { mock: true })};
      }
    }`).join(',\n');

    const kbConfig = config.kbSources && config.kbSources.length > 0
      ? `{
      enabled: true,
      sources: ${JSON.stringify(config.kbSources, null, 6).replace(/\n/g, '\n      ')}
    }`
      : 'null';

    let thinkerSection = '';
    if (config.mode === 'thinker' && config.thinkingPrompt) {
      thinkerSection = `
const THINKING_PROMPT = \`${config.thinkingPrompt.replace(/`/g, '\\`')}\`;
`;
    }

    let thinkerInit = '';
    if (config.mode === 'thinker') {
      thinkerInit = `
    // Thinker mode
    this.usesThinker = true;
    this.thinkingPrompt = THINKING_PROMPT;
    this.thinkingModel = '${config.thinkingModel || 'claude-sonnet-4-20250514'}';`;
    }

    const source = `const CrewMember = require('../../crew/base/CrewMember');
${thinkerSection}
class ${className} extends CrewMember {
  constructor() {
    super({
      name: '${(config.displayName || 'playground-crew').toLowerCase().replace(/[^a-z0-9]+/g, '-')}',
      displayName: '${(config.displayName || 'Playground Crew').replace(/'/g, "\\'")}',
      description: '${(config.description || '').replace(/'/g, "\\'")}',
      isDefault: true,
      model: '${config.model || 'gpt-5'}',
      maxTokens: ${config.maxTokens || 2048},
      knowledgeBase: ${kbConfig},
      tools: [
${toolsDef}
      ],
    });
${thinkerInit}
${config.persona ? `\n    this.persona = \`${config.persona.replace(/`/g, '\\`')}\`;` : ''}
  }

  get guidance() {
    return \`${(config.guidance || '').replace(/`/g, '\\`')}\`;
  }
}

module.exports = ${className};
`;

    return source;
  }

  /**
   * Clean up stale sessions (older than 2 hours).
   */
  cleanup() {
    const maxAge = 2 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt.getTime() > maxAge) {
        this.remove(id);
      }
    }
  }
}

module.exports = new PlaygroundService();
