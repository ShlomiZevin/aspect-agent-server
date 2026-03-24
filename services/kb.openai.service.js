const { OpenAI } = require('openai');
const { toFile } = require('openai/uploads');
const { File } = require('node:buffer');
const providerConfigService = require('./provider-config.service');

// Polyfill for File in Node.js < 20
if (typeof globalThis.File === 'undefined') {
  globalThis.File = File;
}

/**
 * OpenAI Knowledge Base Service
 * Handles vector store and file management via the OpenAI API.
 * Extracted from llm.openai.js — chat/completions logic stays there.
 */
class KBOpenAIService {
  constructor() {
    this._client = null;
    this._clientApiKey = null;
  }

  get client() {
    const currentKey = providerConfigService.getCached('openai_api_key') || process.env.OPENAI_API_KEY;
    if (currentKey !== this._clientApiKey || !this._client) {
      this._clientApiKey = currentKey;
      this._client = new OpenAI({ apiKey: currentKey });
    }
    return this._client;
  }

  /**
   * Create a new vector store
   * @param {string} name - The name of the vector store
   * @param {string} description - Optional description
   * @returns {Promise<Object>} - The created vector store
   */
  async createStore(name, description = null) {
    try {
      const params = { name };
      if (description) {
        params.description = description;
      }

      const vectorStore = await this.client.vectorStores.create(params);
      console.log(`✅ Vector store created: ${vectorStore.id}`);

      return {
        id: vectorStore.id,
        name: vectorStore.name,
        description: vectorStore.description,
        createdAt: vectorStore.created_at,
        fileCount: vectorStore.file_counts.total,
        bytes: vectorStore.bytes
      };
    } catch (error) {
      console.error('❌ Error creating vector store:', error.message);
      throw new Error(`Failed to create vector store: ${error.message}`);
    }
  }

  /**
   * List all vector stores
   * @returns {Promise<Array>} - Array of vector stores
   */
  async listStores() {
    try {
      const response = await this.client.vectorStores.list();

      return response.data.map(vs => ({
        id: vs.id,
        name: vs.name,
        description: vs.description,
        createdAt: vs.created_at,
        fileCount: vs.file_counts.total,
        bytes: vs.bytes,
        fileCounts: vs.file_counts
      }));
    } catch (error) {
      console.error('❌ Error listing vector stores:', error.message);
      throw new Error(`Failed to list vector stores: ${error.message}`);
    }
  }

  /**
   * Get vector store by ID
   * @param {string} vectorStoreId - The vector store ID
   * @returns {Promise<Object>} - The vector store details
   */
  async getStore(vectorStoreId) {
    try {
      const vectorStore = await this.client.vectorStores.retrieve(vectorStoreId);

      return {
        id: vectorStore.id,
        name: vectorStore.name,
        description: vectorStore.description,
        createdAt: vectorStore.created_at,
        fileCount: vectorStore.file_counts.total,
        bytes: vectorStore.bytes,
        fileCounts: vectorStore.file_counts
      };
    } catch (error) {
      console.error('❌ Error retrieving vector store:', error.message);
      throw new Error(`Failed to retrieve vector store: ${error.message}`);
    }
  }

  /**
   * Delete a vector store
   * @param {string} vectorStoreId
   * @returns {Promise<void>}
   */
  async deleteStore(vectorStoreId) {
    await this.client.vectorStores.del(vectorStoreId);
    console.log(`✅ Vector store deleted: ${vectorStoreId}`);
  }

  /**
   * List files in a vector store
   * @param {string} vectorStoreId - The vector store ID
   * @returns {Promise<Array>} - Array of files with metadata
   */
  async listFiles(vectorStoreId) {
    try {
      // Use auto-pagination to fetch ALL files (default limit is 20)
      const allVsFiles = await this.client.vectorStores.files.list(vectorStoreId, { limit: 100 }).then(async (page) => {
        const files = [...page.data];
        let current = page;
        while (current.hasNextPage()) {
          current = await current.getNextPage();
          files.push(...current.data);
        }
        return files;
      });

      // Get file details for each file
      const filesWithDetails = await Promise.all(
        allVsFiles.map(async (vsFile) => {
          try {
            const fileDetails = await this.client.files.retrieve(vsFile.id);
            return {
              id: vsFile.id,
              vectorStoreId: vsFile.vector_store_id,
              createdAt: vsFile.created_at,
              fileName: fileDetails.filename,
              fileSize: fileDetails.bytes,
              purpose: fileDetails.purpose,
              status: fileDetails.status
            };
          } catch (err) {
            console.warn(`⚠️ Could not retrieve details for file ${vsFile.id}:`, err.message);
            return {
              id: vsFile.id,
              vectorStoreId: vsFile.vector_store_id,
              createdAt: vsFile.created_at,
              fileName: 'Unknown',
              fileSize: 0,
              status: 'unknown'
            };
          }
        })
      );

      console.log(`📂 Listed ${filesWithDetails.length} files from vector store ${vectorStoreId}`);
      return filesWithDetails;
    } catch (error) {
      console.error('❌ Error listing vector store files:', error.message);
      throw new Error(`Failed to list vector store files: ${error.message}`);
    }
  }

  /**
   * Delete a file from a vector store
   * @param {string} vectorStoreId - The vector store ID
   * @param {string} fileId - The file ID
   * @returns {Promise<Object>} - Deletion result
   */
  async deleteFile(vectorStoreId, fileId) {
    try {
      const result = await this.client.beta.vectorStores.files.del(vectorStoreId, fileId);
      console.log(`✅ File ${fileId} deleted from vector store ${vectorStoreId}`);

      return {
        success: true,
        fileId: fileId,
        deleted: result.deleted
      };
    } catch (error) {
      console.error('❌ Error deleting file from vector store:', error.message);
      throw new Error(`Failed to delete file from vector store: ${error.message}`);
    }
  }

  /**
   * Upload a file to a vector store
   * @param {string} vectorStoreId - The vector store ID to add the file to
   * @param {Buffer} fileBuffer - The file content as Buffer
   * @param {string} fileName - The name of the file
   * @returns {Promise<Object>} - The file upload result
   */
  async uploadFile(vectorStoreId, fileBuffer, fileName) {
    try {
      console.log(`📤 Starting file upload: ${fileName} to vector store: ${vectorStoreId}`);

      // Step 1: Upload the file to OpenAI
      const fileObject = await toFile(fileBuffer, fileName);

      const file = await this.client.files.create({
        file: fileObject,
        purpose: 'assistants'
      });

      console.log(`✅ File uploaded to OpenAI with ID: ${file.id}`);

      // Step 2: Add the file to the vector store using the file_id
      console.log(`🔗 Adding file ${file.id} to vector store ${vectorStoreId}...`);
      const vectorStoreFile = await this.client.vectorStores.files.create(
        vectorStoreId,
        {
          file_id: file.id
        }
      );

      console.log(`✅ File added to vector store. Vector Store File ID: ${vectorStoreFile.id}, Status: ${vectorStoreFile.status}`);

      return {
        success: true,
        fileId: file.id,
        vectorStoreFileId: vectorStoreFile.id,
        fileName: fileName,
        fileSize: file.bytes,
        status: vectorStoreFile.status
      };
    } catch (error) {
      console.error('❌ Error adding file to vector store:', error.message);
      console.error('Full error:', error);
      throw new Error(`Failed to add file to vector store: ${error.message}`);
    }
  }

  /**
   * Get raw file content from OpenAI Files API
   * @param {string} fileId
   * @returns {Promise<Response>}
   */
  async getFileContent(fileId) {
    return this.client.files.content(fileId);
  }
}

module.exports = new KBOpenAIService();
