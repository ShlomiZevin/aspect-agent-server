/**
 * Crew Editor Service
 *
 * Enables super users to view and edit file-based crew member source code
 * through the web UI with Claude AI as an assistant.
 *
 * Operations:
 * - Read crew source files from disk
 * - Validate source code (compile check)
 * - Backup versions to Google Cloud Storage
 * - Apply changes (validate → backup → write → hot-reload)
 * - Chat with Claude for AI-assisted editing
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crewService = require('../crew/services/crew.service');
const storageService = require('./storage.service');
const claudeService = require('./llm.claude');

const GCS_VERSIONS_PREFIX = 'crew-versions';
const MAX_VERSIONS = 5;

class CrewEditorService {

  /**
   * Read the source code of a crew member file.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name (without .crew.js)
   * @returns {Promise<{source: string, filePath: string, lastModified: string}>}
   */
  async getCrewSource(agentName, crewName) {
    console.log(`📝 [CrewEditor] Reading source: agent="${agentName}", crew="${crewName}"`);
    const filePath = this._resolveCrewFilePath(agentName, crewName);
    if (!filePath) {
      console.error(`❌ [CrewEditor] File not found: agent="${agentName}", crew="${crewName}"`);
      throw new Error(`Crew file not found for agent "${agentName}", crew "${crewName}"`);
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const stats = fs.statSync(filePath);

    console.log(`✅ [CrewEditor] Source loaded: ${filePath} (${source.length} chars)`);
    return {
      source,
      filePath,
      lastModified: stats.mtime.toISOString()
    };
  }

  /**
   * Validate crew member source code by attempting to compile it.
   *
   * @param {string} source - The source code to validate
   * @param {string} filePath - The file path (for module resolution context)
   * @returns {{valid: boolean, error?: string}}
   */
  validateSource(source, filePath) {
    console.log(`🔍 [CrewEditor] Validating source (${source.length} chars)...`);
    try {
      // Syntax-only check — does not execute the code or affect require cache
      new vm.Script(source, { filename: filePath });
      console.log(`✅ [CrewEditor] Validation passed`);
      return { valid: true };
    } catch (error) {
      console.error(`❌ [CrewEditor] Validation failed: ${error.message}`);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Backup the current crew file to Google Cloud Storage.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {string} source - Current source code to backup
   * @returns {Promise<string>} - The backup version timestamp
   */
  async backupToGCS(agentName, crewName, source) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const gcsPath = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/${timestamp}.crew.js`;

    const buffer = Buffer.from(source, 'utf8');
    const file = storageService.getBucket().file(gcsPath);
    await file.save(buffer, {
      metadata: { contentType: 'application/javascript' }
    });

    console.log(`✅ Crew backup saved to GCS: ${gcsPath}`);

    // Cleanup old versions (keep last MAX_VERSIONS)
    await this._cleanupOldVersions(agentName, crewName);

    return timestamp;
  }

  /**
   * Apply new source code to a crew member file.
   * Full flow: validate → backup → write → hot-reload
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {string} newSource - The new source code
   * @returns {Promise<{success: boolean, error?: string, backupVersion?: string}>}
   */
  async applySource(agentName, crewName, newSource) {
    console.log(`\n🚀 [CrewEditor] === APPLY START === agent="${agentName}", crew="${crewName}" (${newSource.length} chars)`);
    const filePath = this._resolveCrewFilePath(agentName, crewName);
    if (!filePath) {
      console.error(`❌ [CrewEditor] File not found for apply`);
      return { success: false, error: `Crew file not found for agent "${agentName}", crew "${crewName}"` };
    }

    // Step 1: Validate
    console.log(`📋 [CrewEditor] Step 1/4: Validating...`);
    const validation = this.validateSource(newSource, filePath);
    if (!validation.valid) {
      console.error(`❌ [CrewEditor] Apply aborted — validation failed`);
      return { success: false, error: `Validation failed: ${validation.error}` };
    }

    // Step 2: Backup current version to GCS
    console.log(`💾 [CrewEditor] Step 2/4: Backing up to GCS...`);
    let backupVersion;
    try {
      const currentSource = fs.readFileSync(filePath, 'utf8');
      backupVersion = await this.backupToGCS(agentName, crewName, currentSource);
    } catch (err) {
      console.warn(`⚠️ [CrewEditor] GCS backup failed (continuing anyway): ${err.message}`);
    }

    // Step 3: Write new source to disk
    console.log(`📝 [CrewEditor] Step 3/4: Writing to disk...`);
    try {
      fs.writeFileSync(filePath, newSource, 'utf8');
      console.log(`✅ [CrewEditor] File written: ${filePath}`);
    } catch (err) {
      console.error(`❌ [CrewEditor] Write failed: ${err.message}`);
      return { success: false, error: `Failed to write file: ${err.message}` };
    }

    // Step 4: Hot-reload — clear require cache and re-register
    console.log(`🔄 [CrewEditor] Step 4/4: Hot-reloading...`);
    try {
      await this._hotReload(agentName, filePath);
    } catch (err) {
      console.warn(`⚠️ [CrewEditor] Hot-reload failed: ${err.message}`);
      // File was written successfully, reload will happen on next server restart
    }

    console.log(`🚀 [CrewEditor] === APPLY COMPLETE === success=true, backup=${backupVersion || 'none'}\n`);
    return { success: true, backupVersion };
  }

  /**
   * Chat with Claude AI about editing a crew member file.
   * Claude receives the current source code and the AGENT_BUILDING_GUIDE as context.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {Array<{role: string, content: string}>} messages - Conversation history
   * @param {string} currentSource - The current crew file source code
   * @returns {Promise<{response: string, updatedSource?: string}>}
   */
  async chatWithClaude(agentName, crewName, messages, currentSource) {
    console.log(`\n💬 [CrewEditor] === CHAT START === agent="${agentName}", crew="${crewName}", messages=${messages.length}`);
    const startTime = Date.now();

    // Load the agent building guide
    const guidePath = path.join(__dirname, '..', 'AGENT_BUILDING_GUIDE.md');
    let guideContent = '';
    try {
      guideContent = fs.readFileSync(guidePath, 'utf8');
      console.log(`📖 [CrewEditor] Guide loaded (${guideContent.length} chars)`);
    } catch (err) {
      console.warn('⚠️ [CrewEditor] Could not load AGENT_BUILDING_GUIDE.md:', err.message);
    }

    // Build system prompt (from task spec)
    const systemPrompt = this._buildSystemPrompt(currentSource, guideContent);
    console.log(`📋 [CrewEditor] System prompt built (${systemPrompt.length} chars), source (${currentSource.length} chars)`);

    // Build messages array for Claude
    // Convert to Claude format: [{role: 'user'|'assistant', content: string}]
    const claudeMessages = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }));

    const userContent = claudeMessages.length > 1
      ? this._buildConversationContext(claudeMessages)
      : claudeMessages[0]?.content || '';

    console.log(`🤖 [CrewEditor] Calling Claude... (user content: ${userContent.length} chars)`);

    // Call Claude
    const response = await claudeService.sendOneShot(
      systemPrompt,
      userContent,
      {
        maxTokens: 8192
      }
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [CrewEditor] Claude responded in ${elapsed}s (${response.length} chars)`);

    // Try to extract updated source from Claude's response
    const updatedSource = this._extractUpdatedSource(response);
    if (updatedSource) {
      console.log(`📝 [CrewEditor] Updated source extracted (${updatedSource.length} chars)`);
    } else {
      console.log(`💬 [CrewEditor] No source code changes proposed`);
    }

    return {
      response,
      updatedSource: updatedSource || undefined
    };
  }

  // ========== PRIVATE METHODS ==========

  /**
   * Resolve the full file path for a crew member file.
   * @private
   */
  _resolveCrewFilePath(agentName, crewName) {
    const crewDir = crewService.resolveCrewPath(agentName);
    if (!crewDir) return null;

    const filePath = path.join(crewDir, `${crewName}.crew.js`);
    if (!fs.existsSync(filePath)) return null;

    return filePath;
  }

  /**
   * Hot-reload a crew member by clearing require cache and re-registering.
   * @private
   */
  async _hotReload(agentName, filePath) {
    console.log(`🔄 [CrewEditor] Hot-reloading: ${filePath}`);

    // Clear the specific file from require cache
    try {
      const resolvedPath = require.resolve(filePath);
      delete require.cache[resolvedPath];
      console.log(`  ↳ Cleared cache: ${path.basename(filePath)}`);
    } catch (e) {
      // Not in cache
    }

    // Also clear the crew index.js (which re-exports all crews)
    const crewDir = path.dirname(filePath);
    const indexPath = path.join(crewDir, 'index.js');
    try {
      const resolvedIndex = require.resolve(indexPath);
      delete require.cache[resolvedIndex];
      console.log(`  ↳ Cleared cache: index.js`);
    } catch (e) {
      // Not in cache
    }

    // Clear the crew directory itself from cache
    try {
      const resolvedDir = require.resolve(crewDir);
      delete require.cache[resolvedDir];
      console.log(`  ↳ Cleared cache: crew directory`);
    } catch (e) {
      // Not in cache
    }

    // Re-register via crew service (await since it loads DB crews too)
    await crewService.reloadCrew(agentName);
    console.log(`✅ [CrewEditor] Crew re-registered for agent: ${agentName}`);
  }

  /**
   * Cleanup old GCS versions, keeping only the last MAX_VERSIONS.
   * @private
   */
  async _cleanupOldVersions(agentName, crewName) {
    try {
      const prefix = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/`;
      const [files] = await storageService.getBucket().getFiles({ prefix });

      if (files.length <= MAX_VERSIONS) return;

      // Sort by name (timestamps sort lexicographically)
      files.sort((a, b) => a.name.localeCompare(b.name));

      // Delete oldest files
      const toDelete = files.slice(0, files.length - MAX_VERSIONS);
      for (const file of toDelete) {
        await file.delete();
        console.log(`🗑️ Deleted old crew version: ${file.name}`);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to cleanup old versions: ${err.message}`);
    }
  }

  /**
   * List all backed-up versions for a crew member from GCS.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @returns {Promise<Array<{timestamp: string, name: string, size: number}>>}
   */
  async listVersions(agentName, crewName) {
    console.log(`📋 [CrewEditor] Listing versions: agent="${agentName}", crew="${crewName}"`);
    try {
      const prefix = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/`;
      const [files] = await storageService.getBucket().getFiles({ prefix });

      const versions = files
        .map(file => {
          // Extract timestamp from path: crew-versions/agent/crew/2024-01-15T10-30-00-000Z.crew.js
          const basename = path.basename(file.name, '.crew.js');
          return {
            timestamp: basename,
            name: file.name,
            size: parseInt(file.metadata.size || '0', 10),
            created: file.metadata.timeCreated || null
          };
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // newest first

      console.log(`✅ [CrewEditor] Found ${versions.length} versions`);
      return versions;
    } catch (err) {
      console.error(`❌ [CrewEditor] Failed to list versions: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get the source code of a backed-up version from GCS.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {string} timestamp - Version timestamp
   * @returns {Promise<string>}
   */
  async getVersionSource(agentName, crewName, timestamp) {
    console.log(`📖 [CrewEditor] Reading version: ${timestamp}`);
    const gcsPath = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/${timestamp}.crew.js`;
    const file = storageService.getBucket().file(gcsPath);
    const [content] = await file.download();
    return content.toString('utf8');
  }

  /**
   * Restore a backed-up version — writes it to disk and hot-reloads.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {string} timestamp - Version timestamp to restore
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async restoreVersion(agentName, crewName, timestamp) {
    console.log(`🔄 [CrewEditor] Restoring version: ${timestamp}`);
    try {
      const source = await this.getVersionSource(agentName, crewName, timestamp);
      // Apply uses the full flow: validate → backup current → write → hot-reload
      return await this.applySource(agentName, crewName, source);
    } catch (err) {
      console.error(`❌ [CrewEditor] Restore failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Delete a backed-up version from GCS.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {string} timestamp - Version timestamp to delete
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteVersion(agentName, crewName, timestamp) {
    console.log(`🗑️ [CrewEditor] Deleting version: ${timestamp}`);
    try {
      const gcsPath = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/${timestamp}.crew.js`;
      const file = storageService.getBucket().file(gcsPath);
      await file.delete();
      console.log(`✅ [CrewEditor] Version deleted: ${timestamp}`);
      return { success: true };
    } catch (err) {
      console.error(`❌ [CrewEditor] Delete failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Build the system prompt for Claude crew editor chat.
   * Uses the prompt template from the task spec.
   * @private
   */
  _buildSystemPrompt(currentSource, guideContent) {
    return `You are a crew member editor for the Aspect multi-agent platform.
Your job is to help improve how a specific AI agent crew member behaves — how it talks, what it collects, and how it transitions.
The user talking to you is a product expert who tests and refines agents. They are NOT a developer. Speak in plain, non-technical language.

===== WHAT YOU'RE EDITING =====

A "crew member" is a step in a multi-step AI agent conversation. Each crew member is defined as a Node.js file with:
- **Guidance** — the main prompt that tells the agent how to behave, what to say, and what tone to use. This is your PRIMARY edit target.
- **Fields** — data the agent collects from the user during conversation (name, phone, etc.). Each field has a name and description that tells the extraction system what to look for.
- **Transition logic** — code that decides when this step is done and the next one begins.
- **Context builder** — additional information passed to the agent at runtime.

For full technical reference, see the building guide below.

===== CURRENT CREW FILE =====

${currentSource}

===== AGENT BUILDING GUIDE (reference) =====

${guideContent}

===== HOW TO FIX PROBLEMS — PRIORITY ORDER =====

When the user reports a problem, fix it using the FIRST approach that works.
Only move to the next level if the previous one genuinely cannot solve it.

**Level 1: Change the GUIDANCE (prompt)** — Try this first, always
- Rewrite or adjust the guidance text
- The guidance must be flat and uniform — the same text applies to every conversation, every user
- NEVER add if/else logic, conditional sections, or dynamic placeholders inside the guidance
- Use general behavioral rules ("ask one question at a time", "keep it short") not case-specific patches ("if user says X, respond with Y")
- Most problems (tone, phrasing, flow, too many questions, wrong language) are solved here

**Level 2: Improve FIELD DESCRIPTIONS**
- If a field isn't being extracted correctly, the description probably isn't clear enough
- Make descriptions simple and self-contained
- You may add a few general examples of what values to expect, but NEVER use the user's specific failed scenario as the example — generalize
- Use type:'boolean' for yes/no fields, allowedValues for fields with a fixed set of options

**Level 3: Modify CODE (only if levels 1-2 can't solve it)**
- Transition conditions (preMessageTransfer) — when to move to the next step
- Field sequencing (getFieldsForExtraction) — which fields to show when
- Context (buildContext) — what runtime info to pass to the agent
- Keep code minimal. Avoid adding complexity.

**Level 4: ESCALATE — you cannot fix this**
Some problems are outside the scope of a single crew file. If the fix requires ANY of:
- Changes to the field extraction engine itself
- Changes to the dispatcher (the system that routes between crew members)
- Changes to the base crew class or shared infrastructure
- New tool/function implementations
- Database schema changes
- Changes to how streaming or the chat UI works
- Changes to a DIFFERENT crew member (you can only edit the current one)

Then DO NOT attempt a fix. Instead:
1. Explain to the user in simple terms why this can't be fixed from here
2. Help them phrase a clear bug report with a title and description

===== PROMPT WRITING PRINCIPLES =====

When editing guidance prompts, follow these principles:

1. **Identity first** — The opening sentence defines WHO the agent is, not what it does. Bake the voice, tone, language, and personality into the identity.
2. **Describe behavior, not prohibitions** — Instead of listing "don't do X" rules, describe the desired behavior positively.
3. **No whack-a-mole** — When fixing a problem, never just add "don't do [the thing that went wrong]". Instead, find what in the prompt is CAUSING the wrong behavior and fix that.
4. **Short and natural** — Keep guidance concise. A short, well-written prompt with clear identity produces better results than a long prompt with many rules.
5. **Conversation, not flowchart** — Describe how the agent should handle situations as natural conversation behavior, not as if/then decision trees.

===== OUTPUT RULES =====

- When you make changes, output the COMPLETE updated file — not a partial snippet or diff
- Keep the file structure intact: the class name, imports, and exports must stay the same
- Explain what you changed and why in 1-3 simple sentences. No code jargon.
- If the user's request is vague, ask a clarifying question before making changes
- Never remove fields, methods, or transitions unless the user explicitly asks
- If the user asks for something that could break the agent, warn them and suggest a safer way
- When showing the updated file, say "here's the updated version" — not "here's the refactored class"
- Wrap the complete updated file in a code block: \`\`\`javascript ... \`\`\`

===== WHAT YOU CANNOT DO =====

- You cannot test the agent — suggest the user opens a test conversation after applying
- You cannot edit other crew members — only the one currently loaded
- You cannot change infrastructure, shared code, or the platform itself
- You cannot deploy — changes take effect immediately on the running server after "Apply"`;
  }

  /**
   * Build a single user message that includes conversation context.
   * When there are multiple messages, we concatenate them for sendOneShot.
   * @private
   */
  _buildConversationContext(messages) {
    if (messages.length <= 1) {
      return messages[0]?.content || '';
    }

    // Build conversation context from all but the last message
    const history = messages.slice(0, -1);
    const lastMessage = messages[messages.length - 1];

    let context = '===== CONVERSATION SO FAR =====\n\n';
    for (const msg of history) {
      const label = msg.role === 'user' ? 'User' : 'You (Claude)';
      context += `${label}: ${msg.content}\n\n`;
    }
    context += '===== CURRENT MESSAGE =====\n\n';
    context += lastMessage.content;

    return context;
  }

  /**
   * Extract the updated source code from Claude's response.
   * Looks for a JavaScript code block containing a full class definition.
   * @private
   */
  _extractUpdatedSource(response) {
    // Look for ```javascript ... ``` code block
    const codeBlockRegex = /```(?:javascript|js)\s*\n([\s\S]*?)```/;
    const match = response.match(codeBlockRegex);

    if (match && match[1]) {
      const code = match[1].trim();
      // Verify it looks like a crew file (has CrewMember require and module.exports)
      if (code.includes('CrewMember') && code.includes('module.exports')) {
        return code;
      }
    }

    return null;
  }
}

module.exports = new CrewEditorService();
