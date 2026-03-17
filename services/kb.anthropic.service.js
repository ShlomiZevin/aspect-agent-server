/**
 * Anthropic KB Service
 *
 * Implements "mimic" KB for Claude models via Anthropic Files API.
 * Files are uploaded once and injected as document blocks at inference time.
 * No semantic retrieval — Claude reads all files in context.
 */
const Anthropic = require('@anthropic-ai/sdk');
const providerConfigService = require('./provider-config.service');

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
    const file = new File([buffer], filename, { type: mimetype || 'text/plain' });
    const result = await this.client.beta.files.upload({ file });
    console.log(`✅ Uploaded to Anthropic Files API: ${result.id}`);
    return { fileId: result.id };
  }

  /**
   * Delete a file from Anthropic Files API.
   * @param {string} fileId - Anthropic file ID (e.g. file_abc123)
   */
  async deleteFile(fileId) {
    await this.client.beta.files.delete(fileId);
    console.log(`✅ Deleted from Anthropic Files API: ${fileId}`);
  }
}

module.exports = new KBAnthropicService();
