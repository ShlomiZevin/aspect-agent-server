/**
 * Google Cloud Storage Service
 *
 * Stores original KB files for sync capability between providers.
 * When a file is uploaded to OpenAI or Google KB, we also save the
 * original to GCS so it can be re-uploaded to the other provider later.
 *
 * Environment variable: GCS_BUCKET_NAME
 */
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

let storageClient = null;

function getStorageClient() {
  if (!storageClient) {
    // Use service account key file if available, otherwise fall back to ADC
    const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS
      || path.join(__dirname, '..', 'storage-service-account-api-key.json');

    if (fs.existsSync(keyFilePath)) {
      storageClient = new Storage({ keyFilename: keyFilePath });
      console.log(`🔑 [Storage] Using service account key: ${path.basename(keyFilePath)}`);
    } else {
      storageClient = new Storage();
      console.log(`🔑 [Storage] Using Application Default Credentials`);
    }
  }
  return storageClient;
}

class StorageService {
  constructor() {
    this.bucketName = process.env.GCS_BUCKET_NAME || 'aspect-kb-files';
  }

  getBucket() {
    return getStorageClient().bucket(this.bucketName);
  }

  /**
   * Upload a file buffer to GCS.
   * @param {Buffer} buffer - File content
   * @param {string} fileName - Original file name
   * @param {string} mimeType - MIME type
   * @param {number} kbId - Knowledge base ID (for path organization)
   * @returns {Promise<string>} - GCS path (e.g. "kb-files/42/1234567890-report.pdf")
   */
  async uploadFile(buffer, fileName, mimeType, kbId) {
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `kb-files/${kbId}/${timestamp}-${safeName}`;

    const file = this.getBucket().file(path);
    await file.save(buffer, {
      metadata: { contentType: mimeType || 'application/octet-stream' },
    });

    console.log(`✅ File saved to GCS: ${path}`);
    return path;
  }

  /**
   * Download a file from GCS.
   * @param {string} gcsPath - GCS path returned by uploadFile
   * @returns {Promise<Buffer>} - File content
   */
  async downloadFile(gcsPath) {
    const file = this.getBucket().file(gcsPath);
    const [buffer] = await file.download();
    return buffer;
  }

  /**
   * Delete a file from GCS.
   * @param {string} gcsPath - GCS path
   */
  async deleteFile(gcsPath) {
    try {
      const file = this.getBucket().file(gcsPath);
      await file.delete();
      console.log(`✅ File deleted from GCS: ${gcsPath}`);
    } catch (err) {
      // Ignore not-found errors
      if (!err.message?.includes('No such object')) {
        console.warn(`⚠️ Could not delete GCS file ${gcsPath}: ${err.message}`);
      }
    }
  }

  /**
   * Check if GCS is configured and reachable.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (!process.env.GCS_BUCKET_NAME) {
      return false;
    }
    try {
      const [exists] = await this.getBucket().exists();
      return exists;
    } catch {
      return false;
    }
  }
}

module.exports = new StorageService();
