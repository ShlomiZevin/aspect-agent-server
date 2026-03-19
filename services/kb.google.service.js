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
 * Note: Google's file search cannot properly parse binary formats like .xlsx
 * and .docx — it returns raw binary instead of text. This service automatically
 * converts these formats to text-friendly equivalents before uploading.
 *
 * Environment variable: GEMINI_API_KEY
 */

const XLSX = require('xlsx');
const mammoth = require('mammoth');

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
      return await ai.fileSearchStores.get({ name: storeId });
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
      await ai.fileSearchStores.delete({ name: storeId, config: { force: true } });
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

      // Convert binary formats that Google can't parse properly
      const converted = await this._convertForGoogle(buffer, fileName, mimeType);

      // Create a Blob from the (possibly converted) buffer for the SDK
      const blob = new Blob([converted.buffer], { type: converted.mimeType });

      console.log(`📤 Uploading ${converted.fileName} (${converted.buffer.length} bytes) to Google store ${storeId}${converted.wasConverted ? ` (converted from ${fileName})` : ''}`);

      const operation = await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName: storeId,
        file: blob,
        config: { displayName: converted.fileName },
      });

      // The upload returns an Operation - poll until done
      const result = await this._waitForOperation(operation);

      const documentId = result?.response?.documentName || result?.response?.name || result?.name || `${storeId}/documents/unknown`;
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
      // The SDK returns a paginated iterator with data in pageInternal
      if (response.pageInternal) return response.pageInternal;
      if (response.fileSearchStoreDocuments) return response.fileSearchStoreDocuments;
      // Try iterating if it's an async iterator
      if (typeof response[Symbol.asyncIterator] === 'function') {
        const docs = [];
        for await (const doc of response) docs.push(doc);
        return docs;
      }
      return Array.isArray(response) ? response : [];
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
      await ai.fileSearchStores.documents.delete({ name: documentId, config: { force: true } });
      console.log(`✅ Google KB document deleted: ${documentId}`);
    } catch (err) {
      console.error('❌ Error deleting Google KB document:', err.message);
      throw new Error(`Failed to delete Google KB document: ${err.message}`);
    }
  }

  /**
   * Convert binary file formats to text-friendly equivalents for Google.
   * Google's file search can't properly parse xlsx/docx — returns raw binary.
   * OpenAI handles these natively, so this is Google-specific.
   *
   * @param {Buffer} buffer - Original file content
   * @param {string} fileName - Original file name
   * @param {string} mimeType - Original MIME type
   * @returns {Promise<{ buffer: Buffer, fileName: string, mimeType: string, wasConverted: boolean }>}
   * @private
   */
  async _convertForGoogle(buffer, fileName, mimeType) {
    const ext = fileName.split('.').pop().toLowerCase();

    // xlsx/xls → CSV (all sheets concatenated)
    if (ext === 'xlsx' || ext === 'xls') {
      try {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const csvParts = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          if (csv.trim()) {
            csvParts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
          }
        }
        const csvContent = csvParts.join('\n\n');
        const csvFileName = fileName.replace(/\.xlsx?$/i, '.csv');
        console.log(`🔄 Converted ${fileName} → ${csvFileName} (${workbook.SheetNames.length} sheets, ${csvContent.length} chars)`);
        return { buffer: Buffer.from(csvContent, 'utf-8'), fileName: csvFileName, mimeType: 'text/csv', wasConverted: true };
      } catch (err) {
        console.warn(`⚠️ Failed to convert ${fileName} to CSV, uploading as-is:`, err.message);
      }
    }

    // docx → plain text
    if (ext === 'docx') {
      try {
        const result = await mammoth.extractRawText({ buffer });
        const textFileName = fileName.replace(/\.docx$/i, '.txt');
        console.log(`🔄 Converted ${fileName} → ${textFileName} (${result.value.length} chars)`);
        return { buffer: Buffer.from(result.value, 'utf-8'), fileName: textFileName, mimeType: 'text/plain', wasConverted: true };
      } catch (err) {
        console.warn(`⚠️ Failed to convert ${fileName} to text, uploading as-is:`, err.message);
      }
    }

    // All other formats — pass through unchanged
    return { buffer, fileName, mimeType: mimeType || 'application/octet-stream', wasConverted: false };
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
