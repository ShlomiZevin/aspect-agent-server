const { eq, desc } = require('drizzle-orm');
const { knowledgeBases, knowledgeBaseFiles, agents } = require('../db/schema');
const dbService = require('./db.pg');

/**
 * Knowledge Base Service
 * Handles database operations for knowledge bases and their files.
 * Supports multi-provider: 'openai', 'google', or 'both'.
 */
class KnowledgeBaseService {
  /**
   * Create a new knowledge base
   * @param {number} agentId
   * @param {string} name
   * @param {string} description
   * @param {string} provider - 'openai' | 'google' | 'both'
   * @param {string|null} vectorStoreId - OpenAI vector store ID
   * @param {string|null} googleCorpusId - Google File Search Store name
   * @returns {Promise<Object>}
   */
  async createKnowledgeBase(agentId, name, description, provider = 'openai', vectorStoreId = null, googleCorpusId = null) {
    try {
      const [kb] = await dbService.db
        .insert(knowledgeBases)
        .values({
          agentId,
          name,
          description,
          provider,
          vectorStoreId,
          googleCorpusId,
          fileCount: 0,
          metadata: {}
        })
        .returning();

      console.log(`✅ Knowledge base created in DB: ${kb.id} (provider: ${provider})`);
      return kb;
    } catch (error) {
      console.error('❌ Error creating knowledge base in DB:', error.message);
      throw new Error(`Failed to create knowledge base in database: ${error.message}`);
    }
  }

  /**
   * Update provider IDs on a knowledge base (used after sync)
   * @param {number} kbId
   * @param {Object} updates - { vectorStoreId?, googleCorpusId?, provider?, lastSyncedAt? }
   * @returns {Promise<Object>}
   */
  async updateKBProviderIds(kbId, updates) {
    try {
      const setValues = { updatedAt: new Date() };
      if (updates.vectorStoreId !== undefined) setValues.vectorStoreId = updates.vectorStoreId;
      if (updates.googleCorpusId !== undefined) setValues.googleCorpusId = updates.googleCorpusId;
      if (updates.provider !== undefined) setValues.provider = updates.provider;
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
      const { openaiFileId = null, googleDocumentId = null, originalFileUrl = null } = providerIds;

      const [file] = await dbService.db
        .insert(knowledgeBaseFiles)
        .values({
          knowledgeBaseId: kbId,
          fileName,
          fileSize,
          fileType,
          openaiFileId,
          googleDocumentId,
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
}

module.exports = new KnowledgeBaseService();
