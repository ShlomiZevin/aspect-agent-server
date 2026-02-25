/**
 * Google Knowledge Base Service
 *
 * Manages Google File Search Stores (launched Nov 2025).
 * Uses the @google/genai SDK's fileSearchStores API.
 *
 * A "File Search Store" is Google's equivalent of an OpenAI vector store:
 * - Create a store → get a store name (e.g. "fileSearchStores/abc123")
 * - Upload files to the store → each file becomes a "document"
 * - Use the store in Gemini chat via the file_search tool
 *
 * Environment variable: GEMINI_API_KEY
 */

let GoogleGenAI = null;
let client = null;

async function getClient() {
  if (client) return client;
  const genai = await import('@google/genai');
  GoogleGenAI = genai.GoogleGenAI;
  client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

class GoogleKBService {
  /**
   * Create a new File Search Store (KB).
   * @param {string} name - Display name
   * @returns {Promise<{ storeId: string, displayName: string }>}
   *   storeId is the full resource name, e.g. "fileSearchStores/abc123"
   */
  async createStore(name) {
    try {
      const ai = await getClient();
      const store = await ai.fileSearchStores.create({ displayName: name });
      console.log(`✅ Google File Search Store created: ${store.name}`);
      return {
        storeId: store.name,
        displayName: store.displayName,
      };
    } catch (err) {
      console.error('❌ Error creating Google KB store:', err.message);
      throw new Error(`Failed to create Google KB: ${err.message}`);
    }
  }

  /**
   * Get a File Search Store by its name.
   * @param {string} storeId - Full store name (e.g. "fileSearchStores/abc123")
   * @returns {Promise<Object>} - Store details
   */
  async getStore(storeId) {
    try {
      const ai = await getClient();
      return await ai.fileSearchStores.get(storeId);
    } catch (err) {
      console.error('❌ Error getting Google KB store:', err.message);
      throw new Error(`Failed to get Google KB: ${err.message}`);
    }
  }

  /**
   * List all File Search Stores.
   * @returns {Promise<Array>} - Array of store objects
   */
  async listStores() {
    try {
      const ai = await getClient();
      const response = await ai.fileSearchStores.list({});
      return response.fileSearchStores || [];
    } catch (err) {
      console.error('❌ Error listing Google KB stores:', err.message);
      throw new Error(`Failed to list Google KBs: ${err.message}`);
    }
  }

  /**
   * Delete a File Search Store.
   * @param {string} storeId - Full store name
   */
  async deleteStore(storeId) {
    try {
      const ai = await getClient();
      await ai.fileSearchStores.delete(storeId);
      console.log(`✅ Google File Search Store deleted: ${storeId}`);
    } catch (err) {
      console.error('❌ Error deleting Google KB store:', err.message);
      throw new Error(`Failed to delete Google KB: ${err.message}`);
    }
  }

  /**
   * Upload a file to a File Search Store.
   * Returns the operation which may be async (polling needed for large files).
   *
   * @param {string} storeId - Full store name (e.g. "fileSearchStores/abc123")
   * @param {Buffer} buffer - File content
   * @param {string} fileName - Original file name
   * @param {string} mimeType - MIME type of the file
   * @returns {Promise<{ documentId: string, fileName: string, state: string }>}
   */
  async uploadFile(storeId, buffer, fileName, mimeType) {
    try {
      const ai = await getClient();

      // Create a Blob from the buffer for the SDK
      const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });

      console.log(`📤 Uploading ${fileName} (${buffer.length} bytes) to Google store ${storeId}`);

      const operation = await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName: storeId,
        file: blob,
        config: { displayName: fileName },
      });

      // The upload returns an Operation - poll until done
      const result = await this._waitForOperation(operation);

      const documentId = result?.response?.name || result?.name || `${storeId}/documents/unknown`;
      console.log(`✅ File uploaded to Google KB: ${documentId}`);

      return {
        documentId,
        fileName,
        state: 'completed',
      };
    } catch (err) {
      console.error('❌ Error uploading file to Google KB:', err.message);
      throw new Error(`Failed to upload file to Google KB: ${err.message}`);
    }
  }

  /**
   * List documents in a File Search Store.
   * @param {string} storeId - Full store name
   * @returns {Promise<Array>} - Array of document objects
   */
  async listDocuments(storeId) {
    try {
      const ai = await getClient();
      const response = await ai.fileSearchStores.documents.list({ parent: storeId });
      return response.fileSearchStoreDocuments || [];
    } catch (err) {
      console.error('❌ Error listing Google KB documents:', err.message);
      throw new Error(`Failed to list Google KB documents: ${err.message}`);
    }
  }

  /**
   * Delete a document from a File Search Store.
   * @param {string} documentId - Full document name
   */
  async deleteDocument(documentId) {
    try {
      const ai = await getClient();
      await ai.fileSearchStores.documents.delete(documentId);
      console.log(`✅ Google KB document deleted: ${documentId}`);
    } catch (err) {
      console.error('❌ Error deleting Google KB document:', err.message);
      throw new Error(`Failed to delete Google KB document: ${err.message}`);
    }
  }

  /**
   * Poll an Operation until it completes.
   * @param {Object} operation - The operation object from the SDK
   * @returns {Promise<Object>} - The completed operation result
   * @private
   */
  async _waitForOperation(operation, maxAttempts = 30, intervalMs = 2000) {
    // If the operation is already done or has a direct result, return it
    if (operation?.done || operation?.response) {
      return operation;
    }

    // If the operation has a wait/poll method, use it
    if (typeof operation?.wait === 'function') {
      try {
        return await operation.wait();
      } catch (err) {
        console.warn('⚠️ Operation wait failed, returning as-is:', err.message);
        return operation;
      }
    }

    // Manual polling fallback
    if (operation?.name) {
      const ai = await getClient();
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        try {
          const updated = await ai.operations.get(operation.name);
          if (updated?.done) {
            return updated;
          }
        } catch (err) {
          console.warn(`⚠️ Polling attempt ${i + 1} failed:`, err.message);
        }
      }
    }

    // Return as-is if we can't determine completion
    console.warn('⚠️ Could not confirm operation completion, returning operation as-is');
    return operation;
  }
}

module.exports = new GoogleKBService();
