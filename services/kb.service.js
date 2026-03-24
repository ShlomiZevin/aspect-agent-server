const { eq, desc } = require('drizzle-orm');
const { knowledgeBases, knowledgeBaseFiles, agents } = require('../db/schema');
const dbService = require('./db.pg');
const { hasProvider, getProviders, getMissingProviders } = require('./kb.helpers');

/**
 * Knowledge Base Service
 * Handles database operations for knowledge bases and their files.
 * Supports multi-provider via `providers` JSON array: ["openai", "google", "anthropic"]
 */
class KnowledgeBaseService {
  /**
   * Create a new knowledge base
   * @param {number} agentId
   * @param {string} name
   * @param {string} description
   * @param {string[]} providers - Array of providers, e.g. ["openai", "google"]
   * @param {string|null} vectorStoreId - OpenAI vector store ID
   * @param {string|null} googleCorpusId - Google File Search Store name
   * @returns {Promise<Object>}
   */
  async createKnowledgeBase(agentId, name, description, providers = ['openai'], vectorStoreId = null, googleCorpusId = null) {
    try {
      const [kb] = await dbService.db
        .insert(knowledgeBases)
        .values({
          agentId,
          name,
          description,
          providers: JSON.stringify(providers),
          vectorStoreId,
          googleCorpusId,
          fileCount: 0,
          metadata: {}
        })
        .returning();

      console.log(`✅ Knowledge base created in DB: ${kb.id} (providers: ${JSON.stringify(providers)})`);
      return kb;
    } catch (error) {
      console.error('❌ Error creating knowledge base in DB:', error.message);
      throw new Error(`Failed to create knowledge base in database: ${error.message}`);
    }
  }

  /**
   * Update provider IDs on a knowledge base (used after sync)
   * @param {number} kbId
   * @param {Object} updates - { vectorStoreId?, googleCorpusId?, providers?, lastSyncedAt? }
   * @returns {Promise<Object>}
   */
  async updateKBProviderIds(kbId, updates) {
    try {
      const setValues = { updatedAt: new Date() };
      if (updates.vectorStoreId !== undefined) setValues.vectorStoreId = updates.vectorStoreId;
      if (updates.googleCorpusId !== undefined) setValues.googleCorpusId = updates.googleCorpusId;
      if (updates.providers !== undefined) setValues.providers = JSON.stringify(updates.providers);
      if (updates.lastSyncedAt !== undefined) setValues.lastSyncedAt = updates.lastSyncedAt;

      const [kb] = await dbService.db
        .update(knowledgeBases)
        .set(setValues)
        .where(eq(knowledgeBases.id, kbId))
        .returning();

      return kb;
    } catch (error) {
      console.error('❌ Error updating KB provider IDs:', error.message);
      throw new Error(`Failed to update KB: ${error.message}`);
    }
  }

  /**
   * Get all knowledge bases for an agent
   * @param {number} agentId
   * @returns {Promise<Array>}
   */
  async getKnowledgeBasesByAgent(agentId) {
    try {
      return await dbService.db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.agentId, agentId))
        .orderBy(desc(knowledgeBases.createdAt));
    } catch (error) {
      console.error('❌ Error fetching knowledge bases:', error.message);
      throw new Error(`Failed to fetch knowledge bases: ${error.message}`);
    }
  }

  /**
   * Get a knowledge base by ID
   * @param {number} kbId
   * @returns {Promise<Object>}
   */
  async getKnowledgeBaseById(kbId) {
    try {
      const [kb] = await dbService.db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.id, kbId))
        .limit(1);

      if (!kb) throw new Error(`Knowledge base not found: ${kbId}`);
      return kb;
    } catch (error) {
      console.error('❌ Error fetching knowledge base:', error.message);
      throw error;
    }
  }

  /**
   * Get a knowledge base by OpenAI vector store ID
   * @param {string} vectorStoreId
   * @returns {Promise<Object|null>}
   */
  async getKnowledgeBaseByVectorStoreId(vectorStoreId) {
    try {
      const [kb] = await dbService.db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.vectorStoreId, vectorStoreId))
        .limit(1);
      return kb || null;
    } catch (error) {
      console.error('❌ Error fetching knowledge base by vector store ID:', error.message);
      throw error;
    }
  }

  /**
   * Update knowledge base file count and total size
   * @param {number} kbId
   * @returns {Promise<Object>}
   */
  async updateFileStats(kbId) {
    try {
      const files = await this.getFilesByKnowledgeBase(kbId);
      const fileCount = files.length;
      const totalSize = files.reduce((sum, file) => sum + (file.fileSize || 0), 0);

      const [kb] = await dbService.db
        .update(knowledgeBases)
        .set({ fileCount, totalSize, updatedAt: new Date() })
        .where(eq(knowledgeBases.id, kbId))
        .returning();

      return kb;
    } catch (error) {
      console.error('❌ Error updating file stats:', error.message);
      throw new Error(`Failed to update file stats: ${error.message}`);
    }
  }

  /** Alias for backward compatibility */
  async updateFileCount(kbId) {
    return this.updateFileStats(kbId);
  }

  /**
   * Add a file to the knowledge base
   * @param {number} kbId
   * @param {string} fileName
   * @param {number} fileSize
   * @param {string} fileType
   * @param {Object} providerIds - { openaiFileId?, googleDocumentId?, originalFileUrl? }
   * @param {Array<string>} tags
   * @param {string} status
   * @returns {Promise<Object>}
   */
  async addFile(kbId, fileName, fileSize, fileType, providerIds = {}, tags = [], status = 'processing') {
    try {
      const { openaiFileId = null, googleDocumentId = null, originalFileUrl = null, anthropicFileId = null } = providerIds;

      const [file] = await dbService.db
        .insert(knowledgeBaseFiles)
        .values({
          knowledgeBaseId: kbId,
          fileName,
          fileSize,
          fileType,
          openaiFileId,
          googleDocumentId,
          anthropicFileId,
          originalFileUrl,
          status,
          metadata: { tags }
        })
        .returning();

      await this.updateFileStats(kbId);

      console.log(`✅ File added to KB in DB: ${file.id}`);
      return file;
    } catch (error) {
      console.error('❌ Error adding file to KB:', error.message);
      throw new Error(`Failed to add file to knowledge base: ${error.message}`);
    }
  }

  /**
   * Update provider IDs on a file (used after syncing a file to another provider)
   * @param {number} fileId
   * @param {Object} updates - { openaiFileId?, googleDocumentId?, originalFileUrl? }
   * @returns {Promise<Object>}
   */
  async updateFileProviderIds(fileId, updates) {
    try {
      const setValues = { updatedAt: new Date() };
      if (updates.openaiFileId !== undefined) setValues.openaiFileId = updates.openaiFileId;
      if (updates.googleDocumentId !== undefined) setValues.googleDocumentId = updates.googleDocumentId;
      if (updates.anthropicFileId !== undefined) setValues.anthropicFileId = updates.anthropicFileId;
      if (updates.originalFileUrl !== undefined) setValues.originalFileUrl = updates.originalFileUrl;
      if (updates.status !== undefined) setValues.status = updates.status;

      const [file] = await dbService.db
        .update(knowledgeBaseFiles)
        .set(setValues)
        .where(eq(knowledgeBaseFiles.id, fileId))
        .returning();

      return file;
    } catch (error) {
      console.error('❌ Error updating file provider IDs:', error.message);
      throw new Error(`Failed to update file: ${error.message}`);
    }
  }

  /**
   * Get all files in a knowledge base
   * @param {number} kbId
   * @returns {Promise<Array>}
   */
  async getFilesByKnowledgeBase(kbId) {
    try {
      return await dbService.db
        .select()
        .from(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.knowledgeBaseId, kbId))
        .orderBy(desc(knowledgeBaseFiles.createdAt));
    } catch (error) {
      console.error('❌ Error fetching files:', error.message);
      throw new Error(`Failed to fetch files: ${error.message}`);
    }
  }

  /**
   * Get file by DB ID
   * @param {number} fileId
   * @returns {Promise<Object|null>}
   */
  async getFileById(fileId) {
    try {
      const [file] = await dbService.db
        .select()
        .from(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.id, fileId))
        .limit(1);
      return file || null;
    } catch (error) {
      console.error('❌ Error fetching file by ID:', error.message);
      throw error;
    }
  }

  /**
   * Get file by OpenAI file ID (kept for backward compatibility)
   * @param {string} openaiFileId
   * @returns {Promise<Object|null>}
   */
  async getFileByOpenAIId(openaiFileId) {
    try {
      const [file] = await dbService.db
        .select()
        .from(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.openaiFileId, openaiFileId))
        .limit(1);
      return file || null;
    } catch (error) {
      console.error('❌ Error fetching file by OpenAI ID:', error.message);
      throw error;
    }
  }

  /**
   * Delete an entire knowledge base and all its files from the database
   * @param {number} kbId - Knowledge base ID
   * @returns {Promise<boolean>}
   */
  async deleteKnowledgeBase(kbId) {
    try {
      await dbService.db
        .delete(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.knowledgeBaseId, kbId));

      await dbService.db
        .delete(knowledgeBases)
        .where(eq(knowledgeBases.id, kbId));

      console.log(`✅ Knowledge base deleted from DB: ${kbId}`);
      return true;
    } catch (error) {
      console.error('❌ Error deleting knowledge base:', error.message);
      throw new Error(`Failed to delete knowledge base: ${error.message}`);
    }
  }

  /**
   * Delete a file from the knowledge base
   * @param {number} fileId - DB file ID
   * @returns {Promise<boolean>}
   */
  async deleteFile(fileId) {
    try {
      const [file] = await dbService.db
        .select()
        .from(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.id, fileId))
        .limit(1);

      if (!file) throw new Error(`File not found: ${fileId}`);

      await dbService.db
        .delete(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.id, fileId));

      await this.updateFileStats(file.knowledgeBaseId);

      console.log(`✅ File deleted from DB: ${fileId}`);
      return true;
    } catch (error) {
      console.error('❌ Error deleting file:', error.message);
      throw new Error(`Failed to delete file: ${error.message}`);
    }
  }

  /**
   * Update file status
   * @param {number} fileId
   * @param {string} status
   * @returns {Promise<Object>}
   */
  async updateFileStatus(fileId, status) {
    try {
      const [file] = await dbService.db
        .update(knowledgeBaseFiles)
        .set({ status, updatedAt: new Date() })
        .where(eq(knowledgeBaseFiles.id, fileId))
        .returning();
      return file;
    } catch (error) {
      console.error('❌ Error updating file status:', error.message);
      throw new Error(`Failed to update file status: ${error.message}`);
    }
  }

  /**
   * Get agent by name
   * @param {string} agentName
   * @returns {Promise<Object>}
   */
  async getAgentByName(agentName) {
    try {
      const [agent] = await dbService.db
        .select()
        .from(agents)
        .where(eq(agents.name, agentName))
        .limit(1);

      if (!agent) throw new Error(`Agent not found: ${agentName}`);
      return agent;
    } catch (error) {
      console.error('❌ Error fetching agent:', error.message);
      throw error;
    }
  }

  // ── Provider-routing methods ──────────────────────────────────
  // These replace the if/else provider blocks that were scattered
  // across server.js and dynamic-kb.service.js.

  /**
   * Create provider stores for the given providers array.
   * Returns { vectorStoreId, googleCorpusId } to store on the KB record.
   * @param {string} name
   * @param {string} description
   * @param {string[]} providers
   * @returns {Promise<{ vectorStoreId: string|null, googleCorpusId: string|null }>}
   */
  async createProviderStores(name, description, providers) {
    const kbOpenAI = require('./kb.openai.service');
    const googleKBService = require('./kb.google.service');

    let vectorStoreId = null;
    let googleCorpusId = null;

    if (providers.includes('openai')) {
      const store = await kbOpenAI.createStore(name, description);
      vectorStoreId = store.id;
    }
    if (providers.includes('google')) {
      const store = await googleKBService.createStore(name);
      googleCorpusId = store.storeId;
    }
    // Anthropic has no store concept

    return { vectorStoreId, googleCorpusId };
  }

  /**
   * Upload a file to all providers the KB has, plus GCS backup.
   * Saves the file record to DB and returns it.
   * @param {number} kbId
   * @param {Buffer} buffer
   * @param {string} fileName
   * @param {string} mimetype
   * @param {string[]} tags
   * @returns {Promise<Object>} DB file record
   */
  async uploadFile(kbId, buffer, fileName, mimetype, tags = []) {
    const kbOpenAI = require('./kb.openai.service');
    const googleKBService = require('./kb.google.service');
    const anthropicKBService = require('./kb.anthropic.service');
    const storageService = require('./storage.service');

    const kb = await this.getKnowledgeBaseById(kbId);

    let openaiFileId = null;
    let googleDocumentId = null;
    let anthropicFileId = null;
    let originalFileUrl = null;

    if (hasProvider(kb, 'openai')) {
      const result = await kbOpenAI.uploadFile(kb.vectorStoreId, buffer, fileName);
      openaiFileId = result.fileId;
      console.log(`✅ Uploaded to OpenAI: ${openaiFileId}`);
    }
    if (hasProvider(kb, 'google')) {
      const result = await googleKBService.uploadFile(kb.googleCorpusId, buffer, fileName, mimetype);
      googleDocumentId = result.documentId;
      console.log(`✅ Uploaded to Google: ${googleDocumentId}`);
    }
    if (hasProvider(kb, 'anthropic')) {
      const result = await anthropicKBService.uploadFile(buffer, fileName, mimetype);
      anthropicFileId = result.fileId;
      console.log(`✅ Uploaded to Anthropic: ${anthropicFileId}`);
    }

    try {
      originalFileUrl = await storageService.uploadFile(buffer, fileName, mimetype, kbId);
    } catch (gcsErr) {
      console.warn(`⚠️ GCS backup failed (non-critical): ${gcsErr.message}`);
    }

    const fileType = fileName.split('.').pop().toLowerCase();
    const dbFile = await this.addFile(
      kbId,
      fileName,
      buffer.length,
      fileType,
      { openaiFileId, googleDocumentId, anthropicFileId, originalFileUrl },
      tags,
      'completed'
    );

    return dbFile;
  }

  /**
   * Upload a file buffer to all providers (no GCS, no DB save).
   * Used by dynamic-kb for attach/sync operations.
   * @param {Object} kb - KB record (with providers, vectorStoreId, googleCorpusId)
   * @param {Buffer} buffer
   * @param {string} fileName
   * @param {string} mimetype
   * @returns {Promise<{ openaiFileId, googleDocumentId, anthropicFileId }>}
   */
  async uploadFileToProviders(kb, buffer, fileName, mimetype) {
    const kbOpenAI = require('./kb.openai.service');
    const googleKBService = require('./kb.google.service');
    const anthropicKBService = require('./kb.anthropic.service');

    let openaiFileId = null;
    let googleDocumentId = null;
    let anthropicFileId = null;

    if (hasProvider(kb, 'openai')) {
      const result = await kbOpenAI.uploadFile(kb.vectorStoreId, buffer, fileName);
      openaiFileId = result.fileId;
      console.log(`✅ Uploaded to OpenAI: ${openaiFileId}`);
    }
    if (hasProvider(kb, 'google')) {
      const result = await googleKBService.uploadFile(kb.googleCorpusId, buffer, fileName, mimetype);
      googleDocumentId = result.documentId;
      console.log(`✅ Uploaded to Google: ${googleDocumentId}`);
    }
    if (hasProvider(kb, 'anthropic')) {
      const result = await anthropicKBService.uploadFile(buffer, fileName, mimetype);
      anthropicFileId = result.fileId;
      console.log(`✅ Uploaded to Anthropic: ${anthropicFileId}`);
    }

    return { openaiFileId, googleDocumentId, anthropicFileId };
  }

  /**
   * Delete a file from all providers it has IDs for.
   * Does NOT delete from DB — call deleteFile() separately.
   * @param {Object} kbFile - file record (openaiFileId, googleDocumentId, anthropicFileId)
   * @param {Object} kb - KB record (vectorStoreId)
   */
  async deleteFileFromProviders(kbFile, kb) {
    const kbOpenAI = require('./kb.openai.service');
    const googleKBService = require('./kb.google.service');
    const anthropicKBService = require('./kb.anthropic.service');

    if (kbFile.openaiFileId && kb.vectorStoreId) {
      try { await kbOpenAI.deleteFile(kb.vectorStoreId, kbFile.openaiFileId); }
      catch (err) { console.warn(`⚠️ Could not delete from OpenAI: ${err.message}`); }
    }
    if (kbFile.googleDocumentId) {
      try { await googleKBService.deleteDocument(kbFile.googleDocumentId); }
      catch (err) { console.warn(`⚠️ Could not delete from Google: ${err.message}`); }
    }
    if (kbFile.anthropicFileId) {
      try { await anthropicKBService.deleteFile(kbFile.anthropicFileId); }
      catch (err) { console.warn(`⚠️ Could not delete from Anthropic: ${err.message}`); }
    }
  }

  /**
   * Delete a file from all providers + GCS + DB.
   * @param {number} kbId
   * @param {number} fileId
   */
  async deleteFileWithProviders(kbId, fileId) {
    const storageService = require('./storage.service');

    const kb = await this.getKnowledgeBaseById(kbId);
    const file = await this.getFileById(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);

    await this.deleteFileFromProviders(file, kb);

    if (file.originalFileUrl) {
      try { await storageService.deleteFile(file.originalFileUrl); }
      catch (err) { console.warn(`⚠️ Could not delete from GCS: ${err.message}`); }
    }

    // Clean up dynamic_kb_attachments that reference this file
    const { dynamicKBAttachments } = require('../db/schema');
    await dbService.db
      .delete(dynamicKBAttachments)
      .where(eq(dynamicKBAttachments.kbFileId, file.id));

    await this.deleteFile(file.id);
  }

  /**
   * Delete entire KB from all providers + GCS + DB.
   * @param {number} kbId
   */
  async deleteKnowledgeBaseWithProviders(kbId) {
    const storageService = require('./storage.service');

    const kb = await this.getKnowledgeBaseById(kbId);
    const files = await this.getFilesByKnowledgeBase(kbId);

    for (const file of files) {
      await this.deleteFileFromProviders(file, kb);
      if (file.originalFileUrl) {
        try { await storageService.deleteFile(file.originalFileUrl); }
        catch (err) { console.warn(`⚠️ Could not delete from GCS: ${err.message}`); }
      }
    }

    await this.deleteKnowledgeBase(kbId);
    console.log(`✅ Knowledge base deleted with all providers: ${kbId}`);
  }

  /**
   * List files from all providers the KB has.
   * @param {number} kbId
   * @returns {Promise<{ openai, google, anthropic }>}
   */
  async listProviderFiles(kbId) {
    const kbOpenAI = require('./kb.openai.service');
    const googleKBService = require('./kb.google.service');
    const anthropicKBService = require('./kb.anthropic.service');

    const kb = await this.getKnowledgeBaseById(kbId);
    const result = { openai: null, google: null, anthropic: null };

    if (kb.vectorStoreId && hasProvider(kb, 'openai')) {
      try {
        const files = await kbOpenAI.listFiles(kb.vectorStoreId);
        result.openai = files.map(f => ({
          id: f.id, fileName: f.fileName, fileSize: f.fileSize, status: f.status, createdAt: f.createdAt,
        }));
      } catch (err) { result.openai = { error: err.message }; }
    }
    if (kb.googleCorpusId && hasProvider(kb, 'google')) {
      try {
        const docs = await googleKBService.listDocuments(kb.googleCorpusId);
        result.google = docs.map(d => ({
          id: d.name, displayName: d.displayName, createTime: d.createTime, updateTime: d.updateTime, sizeBytes: d.sizeBytes, state: d.state,
        }));
      } catch (err) { result.google = { error: err.message }; }
    }
    if (hasProvider(kb, 'anthropic')) {
      try {
        const dbFiles = await this.getFilesByKnowledgeBase(kb.id);
        const kbAnthropicIds = new Set(dbFiles.filter(f => f.anthropicFileId).map(f => f.anthropicFileId));
        const allFiles = await anthropicKBService.listFiles();
        result.anthropic = allFiles
          .filter(f => kbAnthropicIds.has(f.id))
          .map(f => ({
            id: f.id, fileName: f.filename, fileSize: f.size_bytes, createdAt: f.created_at,
          }));
      } catch (err) { result.anthropic = { error: err.message }; }
    }

    return { providers: kb.providers, ...result };
  }

  /**
   * Sync all existing KB files to a new provider.
   * Creates the store, uploads each file, updates DB.
   * @param {number} kbId
   * @param {string} targetProvider - 'openai' | 'google' | 'anthropic'
   * @param {Function} getFileBuffer - async (file) => Buffer, handles GCS + dynamic KB lookup
   * @returns {Promise<{ syncedCount, totalFiles, errors, knowledgeBase }>}
   */
  async syncToProvider(kbId, targetProvider, getFileBuffer) {
    const kbOpenAI = require('./kb.openai.service');
    const googleKBService = require('./kb.google.service');
    const anthropicKBService = require('./kb.anthropic.service');
    const { knowledgeBaseFiles: kbfTable } = require('../db/schema');

    const kb = await this.getKnowledgeBaseById(kbId);

    const missingProviders = getMissingProviders(kb);
    if (!missingProviders.includes(targetProvider)) {
      const err = new Error(`KB already has ${targetProvider}`);
      err.statusCode = 400;
      throw err;
    }

    const files = await this.getFilesByKnowledgeBase(kbId);

    let newVectorStoreId = null;
    let newGoogleCorpusId = null;
    let syncedCount = 0;
    const errors = [];

    if (targetProvider === 'openai') {
      const vs = await kbOpenAI.createStore(kb.name, kb.description);
      newVectorStoreId = vs.id;
    } else if (targetProvider === 'google') {
      const store = await googleKBService.createStore(kb.name);
      newGoogleCorpusId = store.storeId;
    }
    // Anthropic: no store needed

    for (const file of files) {
      try {
        const buffer = await getFileBuffer(file);
        if (!buffer) {
          errors.push({ file: file.fileName, error: 'No file content available for sync' });
          continue;
        }

        const mimeType = `application/${file.fileType}`;

        if (targetProvider === 'openai') {
          const result = await kbOpenAI.uploadFile(newVectorStoreId, buffer, file.fileName);
          await this.updateFileProviderIds(file.id, { openaiFileId: result.fileId });
        } else if (targetProvider === 'google') {
          const result = await googleKBService.uploadFile(newGoogleCorpusId, buffer, file.fileName, mimeType);
          await this.updateFileProviderIds(file.id, { googleDocumentId: result.documentId });
        } else if (targetProvider === 'anthropic') {
          const result = await anthropicKBService.uploadFile(buffer, file.fileName, mimeType);
          await dbService.db
            .update(kbfTable)
            .set({ anthropicFileId: result.fileId, updatedAt: new Date() })
            .where(eq(kbfTable.id, file.id));
        }
        syncedCount++;
      } catch (err) {
        console.error(`❌ Could not sync file ${file.fileName}:`, err.message);
        errors.push({ file: file.fileName, error: err.message });
      }
    }

    const updatedProviders = [...getProviders(kb), targetProvider];
    await this.updateKBProviderIds(kbId, {
      vectorStoreId: newVectorStoreId || kb.vectorStoreId,
      googleCorpusId: newGoogleCorpusId || kb.googleCorpusId,
      providers: updatedProviders,
      lastSyncedAt: new Date(),
    });

    const updatedKB = await this.getKnowledgeBaseById(kbId);
    return { syncedCount, totalFiles: files.length, errors, knowledgeBase: updatedKB };
  }

  /**
   * Get raw file content from a provider by provider file ID.
   * @param {string} provider - 'openai' | 'anthropic'
   * @param {string} fileId
   * @returns {Promise<Response>}
   */
  async getProviderFileContent(provider, fileId) {
    const kbOpenAI = require('./kb.openai.service');
    const anthropicKBService = require('./kb.anthropic.service');

    if (provider === 'openai') return kbOpenAI.getFileContent(fileId);
    if (provider === 'anthropic') return anthropicKBService.getFileContent(fileId);
    if (provider === 'google') throw new Error('Google does not support content preview via API');
    throw new Error(`Unknown provider: ${provider}`);
  }

  /**
   * Delete a file directly from a provider by provider file ID (no DB record needed).
   * Used by the provider-files "truth check" delete endpoint.
   * @param {string} provider - 'openai' | 'google' | 'anthropic'
   * @param {number} kbId - needed to look up vectorStoreId for OpenAI
   * @param {string} fileId - provider file ID
   */
  async deleteProviderFile(provider, kbId, fileId) {
    const kbOpenAI = require('./kb.openai.service');
    const googleKBService = require('./kb.google.service');
    const anthropicKBService = require('./kb.anthropic.service');

    if (provider === 'openai') {
      const kb = await this.getKnowledgeBaseById(kbId);
      await kbOpenAI.deleteFile(kb.vectorStoreId, fileId);
    } else if (provider === 'google') {
      await googleKBService.deleteDocument(fileId);
    } else if (provider === 'anthropic') {
      await anthropicKBService.deleteFile(fileId);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
    console.log(`✅ Deleted ${fileId} from ${provider}`);
  }

  /**
   * Detach a provider from a KB.
   * Deletes the provider store, clears file IDs, updates providers array.
   * @param {number} kbId
   * @param {string} providerToDetach - 'openai' | 'google' | 'anthropic'
   * @returns {Promise<Object>} Updated KB record
   */
  async detachProvider(kbId, providerToDetach) {
    const kbOpenAI = require('./kb.openai.service');
    const googleKBService = require('./kb.google.service');
    const anthropicKBService = require('./kb.anthropic.service');
    const { knowledgeBaseFiles: kbfDetach } = require('../db/schema');

    const kb = await this.getKnowledgeBaseById(kbId);
    const currentProviders = getProviders(kb);

    if (!hasProvider(kb, providerToDetach)) {
      const err = new Error(`KB does not have ${providerToDetach}`);
      err.statusCode = 400;
      throw err;
    }
    if (currentProviders.length <= 1) {
      const err = new Error('Cannot detach the last provider');
      err.statusCode = 400;
      throw err;
    }

    if (providerToDetach === 'google' && kb.googleCorpusId) {
      await googleKBService.deleteStore(kb.googleCorpusId);
    } else if (providerToDetach === 'openai' && kb.vectorStoreId) {
      await kbOpenAI.deleteStore(kb.vectorStoreId);
    }
    // Anthropic has no store to delete

    const files = await this.getFilesByKnowledgeBase(kbId);
    for (const file of files) {
      if (providerToDetach === 'google') {
        await this.updateFileProviderIds(file.id, { googleDocumentId: null });
      } else if (providerToDetach === 'openai') {
        await this.updateFileProviderIds(file.id, { openaiFileId: null });
      } else if (providerToDetach === 'anthropic' && file.anthropicFileId) {
        try { await anthropicKBService.deleteFile(file.anthropicFileId); } catch {}
        await dbService.db
          .update(kbfDetach)
          .set({ anthropicFileId: null, updatedAt: new Date() })
          .where(eq(kbfDetach.id, file.id));
      }
    }

    const remainingProviders = currentProviders.filter(p => p !== providerToDetach);
    await this.updateKBProviderIds(kbId, {
      vectorStoreId: providerToDetach === 'openai' ? null : kb.vectorStoreId,
      googleCorpusId: providerToDetach === 'google' ? null : kb.googleCorpusId,
      providers: remainingProviders,
    });

    const updatedKB = await this.getKnowledgeBaseById(kbId);
    console.log(`✅ Detached ${providerToDetach} from KB "${kb.name}"`);
    return updatedKB;
  }

  /**
   * Upload a file directly to an OpenAI vector store (legacy endpoint).
   * @param {string} vectorStoreId
   * @param {Buffer} buffer
   * @param {string} fileName
   * @returns {Promise<{ fileId: string }>}
   */
  async uploadFileToVectorStore(vectorStoreId, buffer, fileName) {
    const kbOpenAI = require('./kb.openai.service');
    return kbOpenAI.uploadFile(vectorStoreId, buffer, fileName);
  }
}

module.exports = new KnowledgeBaseService();
