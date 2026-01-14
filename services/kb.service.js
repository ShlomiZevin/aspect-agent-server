const { eq, desc } = require('drizzle-orm');
const { knowledgeBases, knowledgeBaseFiles, agents } = require('../db/schema');
const dbService = require('./db.pg');

/**
 * Knowledge Base Service
 * Handles database operations for knowledge bases and their files
 */
class KnowledgeBaseService {
  /**
   * Create a new knowledge base
   * @param {number} agentId - The agent ID
   * @param {string} name - KB name
   * @param {string} description - KB description
   * @param {string} vectorStoreId - OpenAI vector store ID
   * @returns {Promise<Object>} - Created KB
   */
  async createKnowledgeBase(agentId, name, description, vectorStoreId) {
    try {
      const [kb] = await dbService.db
        .insert(knowledgeBases)
        .values({
          agentId,
          name,
          description,
          vectorStoreId,
          fileCount: 0,
          metadata: {}
        })
        .returning();

      console.log(`✅ Knowledge base created in DB: ${kb.id}`);
      return kb;
    } catch (error) {
      console.error('❌ Error creating knowledge base in DB:', error.message);
      throw new Error(`Failed to create knowledge base in database: ${error.message}`);
    }
  }

  /**
   * Get all knowledge bases for an agent
   * @param {number} agentId - The agent ID
   * @returns {Promise<Array>} - Array of knowledge bases
   */
  async getKnowledgeBasesByAgent(agentId) {
    try {
      const kbs = await dbService.db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.agentId, agentId))
        .orderBy(desc(knowledgeBases.createdAt));

      return kbs;
    } catch (error) {
      console.error('❌ Error fetching knowledge bases:', error.message);
      throw new Error(`Failed to fetch knowledge bases: ${error.message}`);
    }
  }

  /**
   * Get a knowledge base by ID
   * @param {number} kbId - The knowledge base ID
   * @returns {Promise<Object>} - The knowledge base
   */
  async getKnowledgeBaseById(kbId) {
    try {
      const [kb] = await dbService.db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.id, kbId))
        .limit(1);

      if (!kb) {
        throw new Error(`Knowledge base not found: ${kbId}`);
      }

      return kb;
    } catch (error) {
      console.error('❌ Error fetching knowledge base:', error.message);
      throw error;
    }
  }

  /**
   * Get a knowledge base by vector store ID
   * @param {string} vectorStoreId - The OpenAI vector store ID
   * @returns {Promise<Object>} - The knowledge base
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
   * @param {number} kbId - The knowledge base ID
   * @returns {Promise<Object>} - Updated KB
   */
  async updateFileStats(kbId) {
    try {
      const files = await this.getFilesByKnowledgeBase(kbId);
      const fileCount = files.length;
      const totalSize = files.reduce((sum, file) => sum + (file.fileSize || 0), 0);

      const [kb] = await dbService.db
        .update(knowledgeBases)
        .set({
          fileCount,
          totalSize,
          updatedAt: new Date()
        })
        .where(eq(knowledgeBases.id, kbId))
        .returning();

      return kb;
    } catch (error) {
      console.error('❌ Error updating file stats:', error.message);
      throw new Error(`Failed to update file stats: ${error.message}`);
    }
  }

  /**
   * Update knowledge base file count (legacy - kept for backward compatibility)
   * @param {number} kbId - The knowledge base ID
   * @returns {Promise<Object>} - Updated KB
   */
  async updateFileCount(kbId) {
    return this.updateFileStats(kbId);
  }

  /**
   * Add a file to the knowledge base
   * @param {number} kbId - The knowledge base ID
   * @param {string} fileName - File name
   * @param {number} fileSize - File size in bytes
   * @param {string} fileType - File type/extension
   * @param {string} openaiFileId - OpenAI file ID
   * @param {Array<string>} tags - File tags
   * @param {string} status - File status (processing, completed, failed)
   * @returns {Promise<Object>} - Created file record
   */
  async addFile(kbId, fileName, fileSize, fileType, openaiFileId, tags = [], status = 'processing') {
    try {
      const [file] = await dbService.db
        .insert(knowledgeBaseFiles)
        .values({
          knowledgeBaseId: kbId,
          fileName,
          fileSize,
          fileType,
          openaiFileId,
          status,
          metadata: { tags }
        })
        .returning();

      // Update file count and total size
      await this.updateFileStats(kbId);

      console.log(`✅ File added to KB in DB: ${file.id}`);
      return file;
    } catch (error) {
      console.error('❌ Error adding file to KB:', error.message);
      throw new Error(`Failed to add file to knowledge base: ${error.message}`);
    }
  }

  /**
   * Get all files in a knowledge base
   * @param {number} kbId - The knowledge base ID
   * @returns {Promise<Array>} - Array of files
   */
  async getFilesByKnowledgeBase(kbId) {
    try {
      const files = await dbService.db
        .select()
        .from(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.knowledgeBaseId, kbId))
        .orderBy(desc(knowledgeBaseFiles.createdAt));

      return files;
    } catch (error) {
      console.error('❌ Error fetching files:', error.message);
      throw new Error(`Failed to fetch files: ${error.message}`);
    }
  }

  /**
   * Get file by OpenAI file ID
   * @param {string} openaiFileId - The OpenAI file ID
   * @returns {Promise<Object>} - The file record
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
   * @param {number} fileId - The file ID
   * @returns {Promise<boolean>} - Success status
   */
  async deleteFile(fileId) {
    try {
      const [file] = await dbService.db
        .select()
        .from(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.id, fileId))
        .limit(1);

      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      await dbService.db
        .delete(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.id, fileId));

      // Update file count and total size
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
   * @param {number} fileId - The file ID
   * @param {string} status - New status
   * @returns {Promise<Object>} - Updated file
   */
  async updateFileStatus(fileId, status) {
    try {
      const [file] = await dbService.db
        .update(knowledgeBaseFiles)
        .set({
          status,
          updatedAt: new Date()
        })
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
   * @param {string} agentName - The agent name
   * @returns {Promise<Object>} - The agent
   */
  async getAgentByName(agentName) {
    try {
      const [agent] = await dbService.db
        .select()
        .from(agents)
        .where(eq(agents.name, agentName))
        .limit(1);

      if (!agent) {
        throw new Error(`Agent not found: ${agentName}`);
      }

      return agent;
    } catch (error) {
      console.error('❌ Error fetching agent:', error.message);
      throw error;
    }
  }
}

module.exports = new KnowledgeBaseService();
