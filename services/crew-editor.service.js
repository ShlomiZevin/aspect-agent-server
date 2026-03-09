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

  constructor() {
    // In-memory snapshot of deployed (on-disk) crew files, captured at startup
    // before any GCS sync overwrites them. Key: "agentName/crewName" → source string
    // Once set, a key is NEVER overwritten — the first capture (startup) wins.
    this._deployedSources = new Map();
  }

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
   * Backup a crew file to Google Cloud Storage.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {string} source - Source code to backup
   * @param {string|null} versionName - Optional user-given name for this version
   * @returns {Promise<string>} - The backup version timestamp
   */
  async backupToGCS(agentName, crewName, source, versionName = null) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const gcsPath = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/${timestamp}.crew.js`;

    const buffer = Buffer.from(source, 'utf8');
    const file = storageService.getBucket().file(gcsPath);
    const saveMetadata = { contentType: 'application/javascript' };
    if (versionName) {
      saveMetadata.metadata = { versionName };
    }
    await file.save(buffer, { metadata: saveMetadata });

    console.log(`✅ Crew backup saved to GCS: ${gcsPath}${versionName ? ` (name: "${versionName}")` : ''}`);

    // Cleanup old versions (keep last MAX_VERSIONS)
    await this._cleanupOldVersions(agentName, crewName);

    return timestamp;
  }

  /**
   * Apply new source code to a crew member file.
   * Flow: validate → write → hot-reload → backup NEW to GCS → set as default
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {string} newSource - The new source code
   * @param {string|null} versionName - Optional user-given name for this version
   * @returns {Promise<{success: boolean, error?: string, backupVersion?: string}>}
   */
  async applySource(agentName, crewName, newSource, versionName = null) {
    console.log(`\n🚀 [CrewEditor] === APPLY START === agent="${agentName}", crew="${crewName}" (${newSource.length} chars)`);
    const filePath = this._resolveCrewFilePath(agentName, crewName);
    if (!filePath) {
      console.error(`❌ [CrewEditor] File not found for apply`);
      return { success: false, error: `Crew file not found for agent "${agentName}", crew "${crewName}"` };
    }

    // Step 1: Validate
    console.log(`📋 [CrewEditor] Step 1/5: Validating...`);
    const validation = this.validateSource(newSource, filePath);
    if (!validation.valid) {
      console.error(`❌ [CrewEditor] Apply aborted — validation failed`);
      return { success: false, error: `Validation failed: ${validation.error}` };
    }

    // Step 2: Project file backup is managed by syncDefaultToDisk on startup.
    // Do NOT update it here — disk may already be overwritten by GCS default sync.
    console.log(`📁 [CrewEditor] Step 2/5: Project file preserved (managed at startup)`);
    // (no-op — _project.crew.js is only set during deploy detection in syncDefaultToDisk)

    // Step 3: Write new source to disk
    console.log(`📝 [CrewEditor] Step 3/5: Writing to disk...`);
    try {
      fs.writeFileSync(filePath, newSource, 'utf8');
      console.log(`✅ [CrewEditor] File written: ${filePath}`);
    } catch (err) {
      console.error(`❌ [CrewEditor] Write failed: ${err.message}`);
      return { success: false, error: `Failed to write file: ${err.message}` };
    }

    // Step 4: Backup to GCS and set as default BEFORE hot-reload.
    // Hot-reload calls syncDefaultToDisk which overwrites disk with GCS default.
    // We must update GCS first so sync finds matching content and doesn't revert.
    console.log(`💾 [CrewEditor] Step 4/5: Backing up & setting default...`);
    let backupVersion;
    try {
      backupVersion = await this.backupToGCS(agentName, crewName, newSource, versionName);
    } catch (err) {
      console.warn(`⚠️ [CrewEditor] GCS backup failed: ${err.message}`);
    }

    if (backupVersion) {
      try {
        await this.setDefaultVersion(agentName, crewName, backupVersion);
      } catch (err) {
        console.warn(`⚠️ [CrewEditor] Failed to set default: ${err.message}`);
      }
    }

    // Step 5: Hot-reload — clear require cache and re-register.
    // syncDefaultToDisk will run but GCS default now matches disk, so no revert.
    console.log(`🔄 [CrewEditor] Step 5/5: Hot-reloading...`);
    try {
      await this._hotReload(agentName, filePath);
    } catch (err) {
      console.warn(`⚠️ [CrewEditor] Hot-reload failed: ${err.message}`);
    }

    console.log(`🚀 [CrewEditor] === APPLY COMPLETE === success=true, backup=${backupVersion || 'none'}\n`);
    return { success: true, backupVersion };
  }

  /**
   * Chat with Claude AI about editing a crew member file.
   * Two modes:
   * - 'discuss' (default): lightweight prompt, no code output
   * - 'generate': full prompt with building guide, outputs complete updated file
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {Array<{role: string, content: string}>} messages - Conversation history
   * @param {string} currentSource - The current crew file source code
   * @param {'discuss'|'generate'} mode - Chat mode
   * @returns {Promise<{response: string, updatedSource?: string}>}
   */
  async chatWithClaude(agentName, crewName, messages, currentSource, mode = 'discuss') {
    console.log(`\n💬 [CrewEditor] === CHAT START === agent="${agentName}", crew="${crewName}", mode="${mode}", messages=${messages.length}`);
    const startTime = Date.now();

    let systemPrompt;

    if (mode === 'generate') {
      // Full prompt — load building guide
      const guidePath = path.join(__dirname, '..', 'AGENT_BUILDING_GUIDE.md');
      let guideContent = '';
      try {
        guideContent = fs.readFileSync(guidePath, 'utf8');
        console.log(`📖 [CrewEditor] Guide loaded (${guideContent.length} chars)`);
      } catch (err) {
        console.warn('⚠️ [CrewEditor] Could not load AGENT_BUILDING_GUIDE.md:', err.message);
      }
      systemPrompt = this._buildGeneratePrompt(currentSource, guideContent);
    } else {
      // Lightweight discuss prompt — no building guide needed
      systemPrompt = this._buildDiscussPrompt(currentSource);
    }

    console.log(`📋 [CrewEditor] System prompt built (${systemPrompt.length} chars), mode="${mode}"`);

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

    // Only extract source code in generate mode
    const updatedSource = mode === 'generate' ? this._extractUpdatedSource(response) : null;
    if (updatedSource) {
      console.log(`📝 [CrewEditor] Updated source extracted (${updatedSource.length} chars)`);
    } else if (mode === 'generate') {
      console.log(`⚠️ [CrewEditor] Generate mode but no source code found in response`);
    } else {
      console.log(`💬 [CrewEditor] Discuss response (no code expected)`);
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
   * Excludes _default.json and _project.crew.js from count/deletion.
   * @private
   */
  async _cleanupOldVersions(agentName, crewName) {
    try {
      const prefix = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/`;
      const [files] = await storageService.getBucket().getFiles({ prefix });

      // Only count timestamped version files (exclude _default.json, _project.crew.js)
      const versionFiles = files.filter(f => {
        const basename = path.basename(f.name);
        return !basename.startsWith('_');
      });

      if (versionFiles.length <= MAX_VERSIONS) return;

      // Sort by name (timestamps sort lexicographically)
      versionFiles.sort((a, b) => a.name.localeCompare(b.name));

      // Delete oldest files
      const toDelete = versionFiles.slice(0, versionFiles.length - MAX_VERSIONS);
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
   * Returns versions array and project file info.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @returns {Promise<{versions: Array, projectFile: Object|null}>}
   */
  async listVersions(agentName, crewName) {
    console.log(`📋 [CrewEditor] Listing versions: agent="${agentName}", crew="${crewName}"`);
    try {
      const prefix = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/`;
      const [files] = await storageService.getBucket().getFiles({ prefix });

      // Get default marker to flag the default version
      const defaultInfo = await this.getDefaultVersion(agentName, crewName);
      const defaultTimestamp = defaultInfo?.timestamp || null;

      // Filter to timestamped version files only (exclude _default.json, _project.crew.js)
      const versions = files
        .filter(file => {
          const basename = path.basename(file.name);
          return basename.endsWith('.crew.js') && !basename.startsWith('_');
        })
        .map(file => {
          const basename = path.basename(file.name, '.crew.js');
          return {
            timestamp: basename,
            name: file.name,
            size: parseInt(file.metadata.size || '0', 10),
            created: file.metadata.timeCreated || null,
            isDefault: basename === defaultTimestamp,
            versionName: file.metadata.metadata?.versionName || null
          };
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // newest first

      // Check for project file backup
      let projectFile = null;
      const projectGcsFile = files.find(f => path.basename(f.name) === '_project.crew.js');
      if (projectGcsFile) {
        projectFile = {
          exists: true,
          size: parseInt(projectGcsFile.metadata.size || '0', 10),
          created: projectGcsFile.metadata.timeCreated || null
        };
      }

      console.log(`✅ [CrewEditor] Found ${versions.length} versions${defaultTimestamp ? ` (default: ${defaultTimestamp})` : ''}${projectFile ? ', project file backed up' : ''}`);
      return { versions, projectFile };
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
   * If the deleted version is the current default, also unsets the default.
   *
   * @param {string} agentName - Agent name
   * @param {string} crewName - Crew member name
   * @param {string} timestamp - Version timestamp to delete
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteVersion(agentName, crewName, timestamp) {
    console.log(`🗑️ [CrewEditor] Deleting version: ${timestamp}`);
    try {
      // Check if this is the current default — unset if so
      const defaultInfo = await this.getDefaultVersion(agentName, crewName);
      if (defaultInfo && defaultInfo.timestamp === timestamp) {
        console.log(`⚠️ [CrewEditor] Deleting default version — unsetting default`);
        await this.unsetDefaultVersion(agentName, crewName);
      }

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

  // ========== DEFAULT VERSION MANAGEMENT ==========

  /**
   * Set a GCS version as the "default" (known-good) version.
   * Writes a marker file to GCS that records which version is the stable one.
   *
   * @param {string} agentName
   * @param {string} crewName
   * @param {string} timestamp - The version timestamp to mark as default
   * @returns {Promise<{success: boolean}>}
   */
  async setDefaultVersion(agentName, crewName, timestamp) {
    console.log(`⭐ [CrewEditor] Setting default: agent="${agentName}", crew="${crewName}", version="${timestamp}"`);
    try {
      // 1. Update GCS marker
      const markerPath = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/_default.json`;
      const marker = JSON.stringify({ timestamp, setAt: new Date().toISOString() });
      const file = storageService.getBucket().file(markerPath);
      await file.save(Buffer.from(marker, 'utf8'), {
        metadata: { contentType: 'application/json' }
      });
      console.log(`✅ [CrewEditor] Default marker set: ${timestamp}`);

      // 2. Write version source to disk and hot-reload
      const filePath = this._resolveCrewFilePath(agentName, crewName);
      if (filePath) {
        const versionSource = await this.getVersionSource(agentName, crewName, timestamp);
        fs.writeFileSync(filePath, versionSource, 'utf8');
        console.log(`📝 [CrewEditor] Default written to disk: ${filePath}`);
        await this._hotReload(agentName, filePath);
      }

      return { success: true };
    } catch (err) {
      console.error(`❌ [CrewEditor] Failed to set default: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get the current default version marker from GCS.
   *
   * @param {string} agentName
   * @param {string} crewName
   * @returns {Promise<{timestamp: string, setAt: string} | null>}
   */
  async getDefaultVersion(agentName, crewName) {
    try {
      const markerPath = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/_default.json`;
      const file = storageService.getBucket().file(markerPath);
      const [exists] = await file.exists();
      if (!exists) return null;

      const [content] = await file.download();
      return JSON.parse(content.toString('utf8'));
    } catch (err) {
      console.warn(`⚠️ [CrewEditor] Could not read default marker: ${err.message}`);
      return null;
    }
  }

  /**
   * Sync the default version from GCS to disk.
   * Called during crew loading to ensure the known-good version is on disk.
   * Silently skips if no default is set or GCS is unreachable.
   *
   * @param {string} agentName
   * @param {string} crewName
   */
  async syncDefaultToDisk(agentName, crewName) {
    try {
      const filePath = this._resolveCrewFilePath(agentName, crewName);
      if (!filePath) return;

      const key = `${agentName}/${crewName}`;
      const diskSource = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

      // Capture startup version from disk (before GCS default may overwrite it).
      // In-memory only — resets on each server restart.
      if (diskSource && !this._deployedSources.has(key)) {
        this._deployedSources.set(key, diskSource);
        console.log(`📸 [CrewEditor] ${crewName}: startup version captured (${diskSource.length} chars)`);
      }

      // Apply GCS default if one exists
      const defaultInfo = await this.getDefaultVersion(agentName, crewName);
      if (!defaultInfo) {
        console.log(`📁 [CrewEditor] ${crewName}: no GCS default — using deployed file`);
        return;
      }

      const defaultSource = await this.getVersionSource(agentName, crewName, defaultInfo.timestamp);
      if (diskSource.trim() !== defaultSource.trim()) {
        fs.writeFileSync(filePath, defaultSource, 'utf8');
        console.log(`☁️ [CrewEditor] ${crewName}: loaded GCS default (${defaultInfo.timestamp})`);
      } else {
        console.log(`✅ [CrewEditor] ${crewName}: GCS default in sync (${defaultInfo.timestamp})`);
      }
    } catch (err) {
      console.warn(`⚠️ [CrewEditor] GCS default sync skipped for ${crewName}: ${err.message}`);
    }
  }

  /**
   * Unset the default version — deletes the _default.json marker.
   * Restores the project file to disk if it exists in GCS, then hot-reloads.
   *
   * @param {string} agentName
   * @param {string} crewName
   * @returns {Promise<{success: boolean}>}
   */
  async unsetDefaultVersion(agentName, crewName) {
    console.log(`⭐ [CrewEditor] Unsetting default: agent="${agentName}", crew="${crewName}"`);
    try {
      // Delete _default.json marker
      const markerPath = `${GCS_VERSIONS_PREFIX}/${agentName}/${crewName}/_default.json`;
      const markerFile = storageService.getBucket().file(markerPath);
      const [exists] = await markerFile.exists();
      if (exists) {
        await markerFile.delete();
        console.log(`✅ [CrewEditor] Default marker deleted`);
      }

      // Restore the startup version to disk (in-memory snapshot from server start)
      const key = `${agentName}/${crewName}`;
      const projectSource = this._deployedSources.get(key) || null;

      if (projectSource) {
        const filePath = this._resolveCrewFilePath(agentName, crewName);
        if (filePath) {
          fs.writeFileSync(filePath, projectSource, 'utf8');
          console.log(`📁 [CrewEditor] Project file restored to disk for ${crewName}`);
          await this._hotReload(agentName, filePath);
        }
      }

      return { success: true };
    } catch (err) {
      console.error(`❌ [CrewEditor] Failed to unset default: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get the source code of the backed-up project file from GCS.
   *
   * @param {string} agentName
   * @param {string} crewName
   * @returns {Promise<string>}
   */
  getProjectFileSource(agentName, crewName) {
    const key = `${agentName}/${crewName}`;
    if (this._deployedSources.has(key)) {
      return this._deployedSources.get(key);
    }
    throw new Error(`No startup version available for "${crewName}" — server may not have loaded this crew yet`);
  }

  /**
   * Extract a lightweight summary from crew source code.
   * Used by the discuss prompt to avoid sending the full source.
   * @private
   */
  _extractCrewSummary(source) {
    const result = {
      guidance: null,
      fields: [],
      transitionTo: null,
      isThinker: false,
      thinkingPrompt: null
    };

    // Extract guidance — look for guidance getter with template literal or string
    const guidanceMatch = source.match(/get\s+guidance\s*\(\)\s*\{[\s\S]*?return\s+`([\s\S]*?)`\s*;?\s*\}/);
    if (guidanceMatch) {
      result.guidance = guidanceMatch[1].trim();
    } else {
      // Try guidance as a constructor property
      const guidancePropMatch = source.match(/guidance:\s*`([\s\S]*?)`/);
      if (guidancePropMatch) result.guidance = guidancePropMatch[1].trim();
    }

    // Extract fields — look for fieldsToCollect array
    const fieldsMatch = source.match(/(?:get\s+)?fieldsToCollect[\s\S]*?\[[\s\S]*?\]/);
    if (fieldsMatch) {
      const fieldEntries = [...fieldsMatch[0].matchAll(/\{\s*name:\s*['"]([^'"]+)['"][\s\S]*?description:\s*['"`]([\s\S]*?)['"`]\s*(?:,|\})/g)];
      result.fields = fieldEntries.map(m => ({ name: m[1], description: m[2].trim() }));
    }

    // Extract transitionTo
    const transitionMatch = source.match(/transitionTo:\s*['"]([^'"]+)['"]/);
    if (transitionMatch) result.transitionTo = transitionMatch[1];

    // Detect thinker crew
    result.isThinker = /usesThinker\s*=\s*true/.test(source);

    // Extract thinking prompt constant
    if (result.isThinker) {
      const thinkingMatch = source.match(/(?:const|let|var)\s+THINKING_PROMPT\s*=\s*`([\s\S]*?)`;/);
      if (thinkingMatch) result.thinkingPrompt = thinkingMatch[1].trim();
    }

    return result;
  }

  /**
   * Build a lightweight prompt for discuss mode.
   * Only includes extracted guidance, fields, and thinker info — no full source or building guide.
   * @private
   */
  _buildDiscussPrompt(currentSource) {
    const summary = this._extractCrewSummary(currentSource);

    const fieldsText = summary.fields.length > 0
      ? summary.fields.map(f => `• ${f.name} — ${f.description}`).join('\n')
      : '(no fields — this step does not collect structured data)';

    let thinkerSection = '';
    if (summary.isThinker && summary.thinkingPrompt) {
      thinkerSection = `
===== TWO-PART BRAIN =====

This step has two parts working together:
- **Strategy brain** — decides WHAT to do: what questions to ask, what path to follow, when to make recommendations.
- **Speaking brain** — decides HOW to say it: tone, personality, phrasing.

**Current strategy rules:**
${summary.thinkingPrompt}

When discussing changes, figure out which part to change:
- If the problem is about what the agent DOES (wrong questions, wrong decisions, wrong timing) → change the strategy rules
- If the problem is about how the agent SOUNDS (wrong tone, too formal, too wordy) → change the speaking instructions
- Explain this to the user in simple terms
`;
    }

    return `You are helping a product expert improve an AI assistant's behavior.
The user is NOT a developer. They are a domain expert who knows the product well but not the code.

YOUR COMMUNICATION STYLE:
- Use plain, everyday language — no technical jargon
- Never mention: JSON, schema, code, prompts, API, LLM, model, parameters, configuration, fields (use "information it collects" instead)
- Never use category codes like (A), (B), (C), (D), (E) — just describe what you'd change in plain language
- Talk about the assistant's "behavior", "personality", "conversation style", "questions", "responses" — not about "prompts" or "code"
- Be conversational and warm, like a colleague helping with a product improvement
- Keep responses concise — 2-4 short paragraphs max

===== WHAT THE ASSISTANT CURRENTLY DOES =====

**How it talks and behaves:**
${summary.guidance || '(could not extract current behavior)'}

**Information it collects from the user:**
${fieldsText}

**Next step after this one:** ${summary.transitionTo || '(none)'}
${thinkerSection}
===== WHAT YOU CAN CHANGE =====

You can help with these kinds of improvements:
- **How it talks** — tone, personality, phrasing, conversation style
- **What it decides** — strategy, question flow, when it makes recommendations${summary.isThinker ? ' (strategy rules)' : ''}
- **What it collects** — the information it gathers from the user
- **When it moves on** — the conditions for transitioning to the next conversation step

If the change requires something outside your control (a different system, a different part of the product), say so honestly and help write a clear description of what's needed so the team can fix it.

===== YOUR ROLE =====

- Understand what the user wants to improve
- Ask clarifying questions when the request is vague
- Suggest what to change and explain the trade-offs in simple terms
- DO NOT output code — that happens when the user clicks "Generate"
- Focus on understanding the problem before proposing a solution
- When you feel you've understood the change well enough, wrap up by saying something like: "I think we have a clear direction — whenever you're ready, click **Generate Changes** and I'll update the file." Do this naturally each time the discussion reaches a conclusion, not just once.

===== HOW TO THINK ABOUT FIXES =====

When the user reports a problem:
1. Find what in the current behavior is CAUSING the issue
2. Describe how you'd rewrite it so the right behavior is clear
3. Never just add "don't do X" — find the root cause and fix it properly
4. Describe the desired behavior positively`;
  }

  /**
   * Build the full system prompt for generate mode.
   * Includes complete source, building guide, thinker awareness, categories, and output rules.
   * @private
   */
  _buildGeneratePrompt(currentSource, guideContent) {
    const summary = this._extractCrewSummary(currentSource);

    let thinkerSection = '';
    if (summary.isThinker) {
      thinkerSection = `
===== THINKER+TALKER CREW =====

This crew uses a thinker+talker pattern: a thinker LLM (Claude) analyzes the conversation and returns structured JSON advice, then a talker LLM (GPT-5) speaks based on that advice.

You can tell this is a thinker crew because the source has:
- \`this.usesThinker = true\`
- A \`THINKING_PROMPT\` constant with a JSON schema
- \`thinkingAdvisor.think()\` call in \`buildContext()\`

**Two prompts, two purposes:**
- **Thinking prompt** (THINKING_PROMPT constant) — controls WHAT the agent does: what questions to ask, what strategy to follow, when to recommend, when to transition. Returns structured JSON.
- **Guidance** (inside the class) — controls HOW the agent talks: tone, personality, phrasing. The talker receives \`thinkingAdvice\` in context and follows it.

When the user reports a problem:
- "Wrong questions / wrong strategy / wrong timing" → edit the THINKING_PROMPT (strategy rules or JSON schema)
- "Wrong tone / too formal / talks too much" → edit the guidance

**JSON schema rules:**
- Always keep the \`_thinkingDescription\` field — it shows in the UI thinking indicator
- Group fields logically with comments
- When adding fields, also add strategy rules explaining when/how to populate them
- The schema IS the state machine — profile fields, strategy, state flags, and transition triggers

When editing the thinking prompt:
- Explain to the user which prompt you're changing and why
- If both prompts need changes, do both and explain each
`;
    }

    return `You are a crew member editor for the Aspect multi-agent platform.
The user has been discussing changes with you. Based on that discussion, generate the complete updated crew file.
The user is a product expert, NOT a developer. Speak in plain, non-technical language.

===== WHAT YOU'RE EDITING =====

A "crew member" is a step in a multi-step AI agent conversation. Each crew member is defined as a Node.js file with:
- **Guidance** — the main prompt that tells the agent how to behave, what to say, and what tone to use.
- **Fields** — data the agent collects from the user during conversation. Each field has a name and description.
- **Transition logic** — code that decides when this step is done and the next one begins.
- **Context builder** — additional information passed to the agent at runtime.

For full technical reference, see the building guide below.

===== CURRENT CREW FILE =====

${currentSource}

===== AGENT BUILDING GUIDE (reference) =====

${guideContent}
${thinkerSection}
===== HOW TO FIX PROBLEMS =====

When the user reports a problem, fix it using the FIRST approach that works.

**(A) Change the GUIDANCE** — try this first, always
- Rewrite or adjust the guidance text
- The guidance must be flat and uniform — no if/else, no conditional sections
- Use general behavioral rules, not case-specific patches
- Most problems (tone, phrasing, flow, wrong language) are solved here

**(B) Change the THINKING PROMPT** — for thinker crews, when the problem is about WHAT the agent decides
- Strategy rules, JSON schema fields, decision timing, transition conditions
- If this is a thinker crew and the problem is about what the agent does (not how it sounds), this is your target

**(C) Add or improve FIELDS**
- If a field isn't being extracted correctly, improve the description
- Make descriptions simple and self-contained
- Use type:'boolean' for yes/no, allowedValues for fixed options

**(D) Modify CODE** — only if A/B/C can't solve it
- Transition conditions (preMessageTransfer / postThinkingTransfer)
- Field sequencing (getFieldsForExtraction)
- Context builder (buildContext)
- Keep code minimal. Avoid adding complexity.

**(E) ESCALATE** — you cannot fix this
If the fix requires changes to infrastructure, the dispatcher, the base class, tools, database, streaming, UI, or a different crew member:
1. Explain to the user in simple terms why this can't be fixed from here
2. Generate a bug report:
**Title:** [clear title]
**Description:** [what the user wants, why it can't be done here, what change is needed]
**Reported from:** Crew Editor

===== PROMPT WRITING PRINCIPLES =====

1. **Identity first** — The opening sentence defines WHO the agent is. Bake voice, tone, personality into the identity.
2. **Describe behavior, not prohibitions** — Instead of "don't do X", describe the desired behavior positively.
3. **No whack-a-mole** — Never add "don't do [the thing that went wrong]". Find what's CAUSING it and fix that.
4. **Short and natural** — A concise prompt with clear identity beats a long prompt with many rules.
5. **Conversation, not flowchart** — Natural conversation behavior, not if/then decision trees.

===== OUTPUT RULES =====

- Output the COMPLETE updated file — not a partial snippet or diff
- Keep the file structure intact: class name, imports, and exports must stay the same
- Wrap the complete updated file in a code block: \`\`\`javascript ... \`\`\`
- After the code block, include a **"Changes made:"** summary listing each change with its category label:
  **(A) Guidance** — what you changed
  **(B) Thinking prompt** — what you changed [if applicable]
  **(C) Fields** — what you changed [if applicable]
  **(D) Code** — what you changed [if applicable]
- If the change spans multiple categories, list each one
- If this is an escalation (E), do NOT output code — output the bug report instead
- Explain changes in plain language, no code jargon
- Never remove fields, methods, or transitions unless the user explicitly asks
- If the user asks for something that could break the agent, warn them and suggest a safer way

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

  // ========== PLAYGROUND METHODS ==========

  /**
   * Chat with Claude about designing a NEW crew member in the playground.
   * Two modes:
   * - 'discuss': Understand what the user wants (no config output)
   * - 'generate': Output a complete crew config as JSON
   *
   * @param {Array<{role: string, content: string}>} messages - Conversation history
   * @param {object|null} currentConfig - Current playground config (if any)
   * @param {'discuss'|'generate'} mode
   * @returns {Promise<{response: string, updatedConfig?: object}>}
   */
  async playgroundChat(messages, currentConfig, mode = 'discuss') {
    console.log(`\n🎮 [Playground] === CHAT === mode="${mode}", messages=${messages.length}`);
    const startTime = Date.now();

    const systemPrompt = mode === 'discuss'
      ? this._buildPlaygroundDiscussPrompt(currentConfig)
      : this._buildPlaygroundGeneratePrompt(currentConfig);

    const claudeMessages = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }));

    const userContent = claudeMessages.length > 1
      ? this._buildConversationContext(claudeMessages)
      : claudeMessages[0]?.content || '';

    const response = await claudeService.sendOneShot(
      systemPrompt,
      userContent,
      { maxTokens: mode === 'generate' ? 4096 : 1024 }
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [Playground] Claude responded in ${elapsed}s (${response.length} chars)`);

    let updatedConfig = null;
    if (mode === 'generate') {
      updatedConfig = this._extractPlaygroundConfig(response);
      if (updatedConfig) {
        console.log(`📝 [Playground] Config extracted: "${updatedConfig.displayName || 'unnamed'}"`);
      } else {
        console.log(`⚠️ [Playground] Generate mode but no config found in response`);
      }
    }

    return { response, updatedConfig: updatedConfig || undefined };
  }

  /**
   * Build discuss prompt for playground design chat.
   * @private
   */
  _buildPlaygroundDiscussPrompt(currentConfig) {
    return `You are helping a product expert design a NEW AI assistant crew member from scratch.
The user is NOT a developer. They are a domain expert who knows the product well.

YOUR COMMUNICATION STYLE:
- Use plain, everyday language — no technical jargon
- Talk about the assistant's "behavior", "personality", "conversation style"
- Be conversational and warm
- Keep responses concise — 2-4 short paragraphs max

WHAT YOU'RE HELPING THEM DEFINE:
- What the assistant does and how it talks (its guidance/prompt)
- Whether it needs a "strategy brain" (thinker mode) that analyzes before responding
- Its personality/voice (persona)
- What tools/actions it can take (e.g., search products, book appointments)
- What it already knows about the user from previous steps (context)
- Whether it transitions to another crew when it finishes its job

ABOUT TRANSITIONS:
In the crew system, crews can transition to other crews. For example, a "welcome" crew
collects the user's name and age, then transitions to the "main-conversation" crew.
There are three transition approaches — ask the user which fits their use case:

1. **Field-based (preMessageTransfer)**: The crew collects specific fields from the user
   (e.g., name, age, account type). Once all fields are collected, the transition fires
   automatically BEFORE the crew responds. Best for: intake forms, onboarding steps.
   → Requires fieldsToCollect + transitionTo in the config.

2. **Thinker-based (postThinkingTransfer)**: The strategy brain (thinker) analyzes the
   conversation and decides when to transition. Fires AFTER thinking but BEFORE the
   response. Best for: nuanced decisions like "is the user ready to move on?"
   → Requires thinker mode + custom code (written after export).

3. **Tool-based (postMessageTransfer)**: Tools update internal state during the conversation.
   After the response (including tool calls), the system checks if the state triggers a
   transition. Best for: multi-step workflows where tools track progress.
   → Requires custom code (written after export).

NOTE: Transitions are implemented as code in the exported .crew.js file. In the playground,
only field-based transitions can be fully tested. Thinker-based and tool-based transitions
require exporting the crew and writing custom transfer methods.

If the user mentions transitions, help them understand which approach fits. Include
fieldsToCollect and transitionTo in the generated config when using field-based transitions.

IMPORTANT ABOUT KNOWLEDGE BASE:
- Do NOT suggest or invent knowledge base IDs. Knowledge bases are connected separately
  through the Config tab — they use real vector stores, not mocked data.
- If the user mentions needing a KB, tell them: "You can connect a real knowledge base
  in the Config tab after generating the crew."

ASK ABOUT EACH AREA NATURALLY:
Don't dump all questions at once. Start by understanding the purpose,
then dig into specifics one area at a time.

CURRENT CONFIG (what we have so far):
${currentConfig ? JSON.stringify(currentConfig, null, 2) : '(nothing yet — starting fresh)'}

When you feel you've understood enough, wrap up by saying something like:
"I think we have a clear picture — whenever you're ready, click **Generate** and I'll create the crew configuration."
Do this naturally each time the discussion reaches a conclusion.`;
  }

  /**
   * Build generate prompt for playground config generation.
   * @private
   */
  _buildPlaygroundGeneratePrompt(currentConfig) {
    return `You are generating a crew member configuration based on the conversation.
Output a COMPLETE JSON configuration inside a \`\`\`json code block.

THE JSON SCHEMA:
{
  "displayName": "Human-readable name",
  "description": "One-line description",
  "mode": "simple" or "thinker",
  "model": "gpt-4o" (or other model ID),
  "guidance": "The full prompt that defines the assistant's behavior...",
  "thinkingPrompt": "(only for thinker mode) The strategy brain prompt...",
  "thinkingModel": "claude-sonnet-4-20250514",
  "persona": "Voice and personality description...",
  "kbSources": [{"vectorStoreId": "vs_xxx", "name": "Product KB"}],
  "tools": [
    {
      "name": "tool_name",
      "description": "What this tool does",
      "parameters": { "type": "object", "properties": { ... }, "required": [...] },
      "mockResponse": { ...example response data... }
    }
  ],
  "context": {
    "namespace_name": { ...data the crew already knows... }
  },
  "fieldsToCollect": [
    { "name": "field_name", "description": "What this field captures" }
  ],
  "transitionTo": "target-crew-name",
  "maxTokens": 2048
}

RULES:
- guidance should be detailed and complete — this IS the crew's prompt
- For thinker mode: thinkingPrompt should instruct the strategy brain to return JSON
  with analysis and recommendations. The talking brain will use this to respond.
- tools.mockResponse should contain realistic example data
- context should simulate what previous crews would have collected
- Only include fields that were discussed. Don't invent features.
- model should be a valid model ID: gpt-4o, gpt-5-chat-latest, claude-sonnet-4-20250514, gemini-2.5-flash, gemini-2.0-flash
- Do NOT include kbSources — knowledge bases are connected separately through the Config tab using real vector stores.
- fieldsToCollect: only include if the crew needs to extract specific data from the user
  for a field-based transition (e.g., name, age, account type). Each field needs a name
  and a description that tells the extractor what to look for.
- transitionTo: the name of the next crew this crew transitions to. Only include if
  the crew has a natural "end point" and should hand off to another crew.
  In the playground, the target crew won't exist — a transition message will appear instead.

CURRENT CONFIG (update/replace as needed):
${currentConfig ? JSON.stringify(currentConfig, null, 2) : '(none)'}

After the JSON block, add a plain-language summary of what was created,
grouped by area: Behavior, Personality, Knowledge, Tools, Context.`;
  }

  /**
   * Extract playground config from Claude's response.
   * Looks for a JSON code block and validates basic structure.
   * @private
   */
  _extractPlaygroundConfig(response) {
    // Strategy 1: Try non-greedy (smallest block) — works when no nested fences
    const fenceMatchShort = response.match(/```(?:json|JSON|js|javascript)?\s*\n([\s\S]*?)```/);
    if (fenceMatchShort) {
      try {
        const config = JSON.parse(fenceMatchShort[1].trim());
        if (config.guidance) return config;
      } catch { /* nested fences probably broke it — try greedy */ }
    }

    // Strategy 2: Greedy (largest block) — handles nested ``` inside thinkingPrompt etc.
    const fenceMatchLong = response.match(/```(?:json|JSON|js|javascript)?\s*\n([\s\S]*)```/);
    if (fenceMatchLong) {
      try {
        const config = JSON.parse(fenceMatchLong[1].trim());
        if (config.guidance) return config;
      } catch { /* fall through */ }
    }

    // Strategy 3: Find outermost JSON object containing "guidance" via brace matching
    const rawMatch = response.match(/\{[\s\S]*?"guidance"\s*:/);
    if (rawMatch) {
      const startIdx = response.indexOf(rawMatch[0]);
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = startIdx; i < response.length; i++) {
        const ch = response[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              const config = JSON.parse(response.slice(startIdx, i + 1));
              if (config.guidance) return config;
            } catch { break; }
          }
        }
      }
    }

    return null;
  }
}

module.exports = new CrewEditorService();
