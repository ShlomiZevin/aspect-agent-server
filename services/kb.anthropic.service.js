/**
 * Anthropic KB Service
 *
 * Implements "mimic" KB for Claude models via Anthropic Files API.
 * Files are uploaded once and injected as document blocks at inference time.
 * No semantic retrieval — Claude reads all files in context.
 */
const Anthropic = require('@anthropic-ai/sdk');
const providerConfigService = require('./provider-config.service');

/**
 * `File` only became a global in Node 20, and the SDK checks for it directly —
 * constructing one from `node:buffer` is not enough. The container runs Node 22
 * so this worked in production, but on Node 18 every upload threw "File is not
 * defined" into whatever catch was nearest, which read as Anthropic refusing
 * the file rather than the file never being built.
 *
 * The SDK's own error message names the fix, so take it: install the global
 * from `node:buffer` when it is absent. Guarded, so on Node 20+ — which is what
 * the container runs — this line does nothing at all and the upload path below
 * is byte-for-byte what it always was. It only matters for local development.
 */
if (!globalThis.File) globalThis.File = require('node:buffer').File;

class KBAnthropicService {
  get client() {
    const apiKey = providerConfigService.getCached('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
    return new Anthropic({ apiKey });
  }

  /**
   * Upload a file to Anthropic Files API.
   * @param {Buffer} buffer - File content
   * @param {string} filename - Original file name
   * @param {string} mimetype - MIME type
   * @returns {Promise<{ fileId: string }>}
   */
  async uploadFile(buffer, filename, mimetype) {
    // Anthropic only supports PDF and plaintext — normalize MIME types
    let safeFilename = filename;
    let safeMimetype = mimetype || 'text/plain';
    if (filename.endsWith('.md') || mimetype === 'text/markdown') {
      safeFilename = filename.replace(/\.md$/, '.txt');
      safeMimetype = 'text/plain';
    }
    // Fix incorrect text MIME types (e.g. application/txt → text/plain)
    if (safeMimetype === 'application/txt' || safeMimetype === 'application/text' ||
        (filename.endsWith('.txt') && !safeMimetype.startsWith('text/'))) {
      safeMimetype = 'text/plain';
    }
    const file = new File([buffer], safeFilename, { type: safeMimetype });
    const result = await this.client.beta.files.upload({ file });
    console.log(`✅ Uploaded to Anthropic Files API: ${result.id}`);
    return { fileId: result.id };
  }

  /**
   * List all files on Anthropic Files API.
   * @returns {Promise<Array<{ id: string, filename: string, size_bytes: number, created_at: string, mime_type: string }>>}
   */
  async listFiles() {
    const result = await this.client.beta.files.list();
    return result.data || [];
  }

  /**
   * Delete a file from Anthropic Files API.
   * @param {string} fileId - Anthropic file ID (e.g. file_abc123)
   */
  async deleteFile(fileId) {
    await this.client.beta.files.delete(fileId);
    console.log(`✅ Deleted from Anthropic Files API: ${fileId}`);
  }

  /**
   * Get raw file content from Anthropic Files API.
   * @param {string} fileId
   * @returns {Promise<Response>}
   */
  async getFileContent(fileId) {
    return this.client.beta.files.content(fileId);
  }
}

module.exports = new KBAnthropicService();
