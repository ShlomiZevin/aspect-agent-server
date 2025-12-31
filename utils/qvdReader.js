const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const QVDParser = require('./qvdParser');

class QVDReader {
  constructor(credentials) {
    this.auth = null;
    this.drive = null;
    this.credentials = credentials;
  }

  /**
   * Initialize Google Drive API client
   */
  async initialize() {
    try {
      // Use service account or OAuth2 credentials
      if (this.credentials.type === 'service_account') {
        this.auth = new google.auth.GoogleAuth({
          credentials: this.credentials,
          scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
      } else {
        // OAuth2 client
        const { client_id, client_secret, redirect_uris } = this.credentials.installed || this.credentials.web;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        // Set credentials if token is available
        if (this.credentials.token) {
          oAuth2Client.setCredentials(this.credentials.token);
        }
        this.auth = oAuth2Client;
      }

      this.drive = google.drive({ version: 'v3', auth: this.auth });
      console.log('✅ Google Drive API initialized');
      return true;
    } catch (error) {
      console.error('❌ Error initializing Google Drive API:', error.message);
      throw error;
    }
  }

  /**
   * List QVD files in a specific Google Drive folder
   * @param {string} folderId - Google Drive folder ID
   * @returns {Array} List of QVD files
   */
  async listQVDFiles(folderId = null) {
    try {
      const query = folderId
        ? `'${folderId}' in parents and mimeType='application/octet-stream' and name contains '.qvd'`
        : "mimeType='application/octet-stream' and name contains '.qvd'";

      const response = await this.drive.files.list({
        q: query,
        fields: 'files(id, name, size, modifiedTime, webViewLink)',
        orderBy: 'name',
      });

      return response.data.files;
    } catch (error) {
      console.error('❌ Error listing QVD files:', error.message);
      throw error;
    }
  }

  /**
   * Download QVD file from Google Drive
   * @param {string} fileId - Google Drive file ID
   * @param {string} destinationPath - Local path to save the file
   * @returns {string} Path to downloaded file
   */
  async downloadQVDFile(fileId, destinationPath = null) {
    try {
      const file = await this.drive.files.get({
        fileId: fileId,
        fields: 'name',
      });

      const fileName = file.data.name;
      const dest = destinationPath || path.join(__dirname, '..', 'temp', fileName);

      // Create temp directory if it doesn't exist
      const tempDir = path.dirname(dest);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const destStream = fs.createWriteStream(dest);

      const response = await this.drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      return new Promise((resolve, reject) => {
        response.data
          .on('end', () => {
            console.log(`✅ Downloaded: ${fileName}`);
            resolve(dest);
          })
          .on('error', (err) => {
            console.error('❌ Error downloading file:', err);
            reject(err);
          })
          .pipe(destStream);
      });
    } catch (error) {
      console.error('❌ Error downloading QVD file:', error.message);
      throw error;
    }
  }

  /**
   * Read QVD file content using QVDParser
   * @param {string} filePath - Path to QVD file
   * @returns {Object} Parsed QVD data
   */
  async readQVDFile(filePath) {
    try {
      const parser = new QVDParser(filePath);
      const data = await parser.parse();

      console.log(`✅ Read QVD file: ${path.basename(filePath)}`);
      console.log(`   - Table: ${data.metadata.tableName}`);
      console.log(`   - Fields: ${data.metadata.fields?.length || 0}`);
      console.log(`   - Records: ${data.metadata.recordCount || 0}`);

      return {
        metadata: data.metadata,
        filePath: data.filePath,
        dataSize: data.dataSize,
        summary: parser.getSummary(),
        fieldNames: parser.getFieldNames(),
      };
    } catch (error) {
      console.error('❌ Error reading QVD file:', error.message);
      throw error;
    }
  }

  /**
   * Download and read QVD file from Google Drive
   * @param {string} fileId - Google Drive file ID
   * @returns {Object} QVD data
   */
  async fetchAndReadQVD(fileId) {
    const filePath = await this.downloadQVDFile(fileId);
    const data = await this.readQVDFile(filePath);

    // Optionally clean up temp file
    // fs.unlinkSync(filePath);

    return data;
  }
}

module.exports = QVDReader;
