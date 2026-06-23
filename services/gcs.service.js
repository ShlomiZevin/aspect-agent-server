const { Storage } = require('@google-cloud/storage');
const csv = require('csv-parser');
const { Readable } = require('stream');
const { StringDecoder } = require('string_decoder');
const path = require('path');
const fs = require('fs');

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Google Cloud Storage Service
 *
 * Handles CSV file operations from GCS buckets
 */
class GCSService {
  constructor() {
    // Use service account key file if available, otherwise fall back to ADC
    const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS
      || path.join(__dirname, '..', 'storage-service-account-api-key.json');

    const options = { projectId: process.env.GCP_PROJECT_ID || 'aspect-agents' };

    if (fs.existsSync(keyFilePath)) {
      options.keyFilename = keyFilePath;
    }

    this.storage = new Storage(options);
    this.bucketName = 'aspect-clients-data';
  }

  /**
   * List all CSV files in a specific folder
   * @param {string} folderPrefix - Folder path (e.g., 'zer4u/')
   * @returns {Promise<Array>} - Array of file metadata
   */
  async listCSVFiles(folderPrefix) {
    try {
      const [files] = await withTimeout(
        this.storage.bucket(this.bucketName).getFiles({ prefix: folderPrefix }),
        60_000,
        `GCS listFiles(${folderPrefix})`
      );

      const csvFiles = files
        .filter(file => file.name.toLowerCase().endsWith('.csv'))
        .map(file => ({
          name: file.name,
          basename: file.name.split('/').pop(),
          size: file.metadata.size,
          created: file.metadata.timeCreated,
          updated: file.metadata.updated
        }));

      console.log(`📁 Found ${csvFiles.length} CSV files in ${folderPrefix}`);
      return csvFiles;
    } catch (error) {
      console.error(`❌ Error listing CSV files:`, error.message);
      throw new Error(`Failed to list CSV files: ${error.message}`);
    }
  }

  /**
   * Download a CSV file and parse it
   * @param {string} filePath - Full path to file in GCS
   * @param {Object} options - Parsing options
   * @param {number} options.limit - Max rows to read (for sampling)
   * @returns {Promise<Array>} - Parsed CSV rows
   */
  async downloadAndParseCSV(filePath, options = {}) {
    const { limit = null } = options;

    try {
      console.log(`📥 Downloading CSV: ${filePath}${limit ? ` (limit: ${limit} rows)` : ''}`);

      const file = this.storage.bucket(this.bucketName).file(filePath);
      const [exists] = await file.exists();

      if (!exists) {
        throw new Error(`File not found: ${filePath}`);
      }

      const rows = [];
      let rowCount = 0;

      return new Promise((resolve, reject) => {
        file.createReadStream()
          .on('error', reject)
          .pipe(csv())
          .on('data', (row) => {
            if (limit && rowCount >= limit) {
              return; // Stop reading after limit
            }
            rows.push(row);
            rowCount++;
          })
          .on('end', () => {
            console.log(`✅ Parsed ${rows.length} rows from ${filePath}`);
            resolve(rows);
          })
          .on('error', reject);
      });
    } catch (error) {
      console.error(`❌ Error downloading CSV ${filePath}:`, error.message);
      throw new Error(`Failed to download CSV: ${error.message}`);
    }
  }

  /**
   * Analyze CSV structure (infer column types)
   * @param {string} filePath - Full path to file in GCS
   * @param {number} sampleSize - Number of rows to sample
   * @returns {Promise<Object>} - Schema metadata
   */
  async analyzeCSVStructure(filePath, sampleSize = 1000) {
    try {
      const rows = await this.downloadAndParseCSV(filePath, { limit: sampleSize });

      if (rows.length === 0) {
        return { columns: [], rowCount: 0 };
      }

      const columns = Object.keys(rows[0]).map(colName => {
        const type = this._inferColumnType(rows, colName);
        const nullable = this._checkNullable(rows, colName);

        return {
          name: colName,
          type,
          nullable,
          sample: rows[0][colName]
        };
      });

      console.log(`📊 Analyzed structure: ${columns.length} columns, ${rows.length} sample rows`);

      return {
        columns,
        rowCount: rows.length,
        sample: rows.slice(0, 5) // First 5 rows as sample
      };
    } catch (error) {
      console.error(`❌ Error analyzing CSV ${filePath}:`, error.message);
      throw new Error(`Failed to analyze CSV: ${error.message}`);
    }
  }

  /**
   * Infer PostgreSQL column type from sample data
   * @private
   */
  _inferColumnType(rows, columnName) {
    const values = rows.map(row => row[columnName]).filter(v => v !== null && v !== '');

    if (values.length === 0) return 'TEXT';

    // CONSERVATIVE APPROACH: Use NUMERIC for any numeric-looking data
    // This handles both integers and decimals safely
    // Full dataset might have decimals even if sample only has integers
    if (values.every(v => /^-?\d+\.?\d*$/.test(v))) {
      return 'NUMERIC';
    }

    // Check if all values are dates (basic check)
    if (values.every(v => !isNaN(Date.parse(v)))) {
      // Further check: does it look like a date?
      if (values.some(v => /\d{4}-\d{2}-\d{2}/.test(v) || /\d{2}\/\d{2}\/\d{4}/.test(v))) {
        return 'TIMESTAMP';
      }
    }

    // Check if all values are booleans
    if (values.every(v => ['true', 'false', '1', '0', 't', 'f'].includes(v.toLowerCase()))) {
      return 'BOOLEAN';
    }

    // Use TEXT for all other columns (strings, mixed types, special chars like "%")
    // TEXT has no performance penalty in PostgreSQL and avoids all type issues
    return 'TEXT';
  }

  /**
   * Check if column has null values
   * @private
   */
  _checkNullable(rows, columnName) {
    // Always return true - make all columns nullable to handle full dataset
    // Sample data might not contain nulls, but full data often does
    return true;
  }

  /**
   * Read only the header line of a CSV file from GCS.
   * Downloads just enough bytes to get the first line — no data rows fetched.
   * @param {string} filePath - Full path to file in GCS
   * @returns {Promise<string[]>} - Array of column name strings
   */
  async getCSVHeaders(filePath) {
    return withTimeout(new Promise((resolve, reject) => {
      const file = this.storage.bucket(this.bucketName).file(filePath);
      const stream = file.createReadStream();
      // Decode UTF-8 across chunk boundaries. A plain chunk.toString() decodes each
      // chunk in isolation, so a multi-byte char split across two chunks becomes
      // U+FFFD on BOTH halves — silently corrupting header (= column) names, e.g.
      // "מכירות..." -> "מכ��רות...". StringDecoder buffers the partial bytes.
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      stream.on('data', chunk => {
        buffer += decoder.write(chunk);
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          stream.destroy(); // stop downloading after first line
          const headerLine = buffer.slice(0, newlineIdx).replace(/\r$/, '');
          // Simple CSV header parse: handle quoted fields
          const headers = [];
          let field = '';
          let inQuotes = false;
          for (let i = 0; i < headerLine.length; i++) {
            const ch = headerLine[i];
            if (ch === '"') {
              inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
              headers.push(field.replace(/^\uFEFF/, '').trim());
              field = '';
            } else {
              field += ch;
            }
          }
          headers.push(field.replace(/^\uFEFF/, '').trim());
          resolve(headers.filter(h => h.length > 0));
        }
      });
      stream.on('error', err => {
        // stream.destroy() triggers 'error' with an abort — ignore it if we already resolved
        if (buffer.includes('\n')) return;
        reject(err);
      });
      stream.on('end', () => {
        // File had no newline (single-line file). Flush any bytes held by the decoder.
        buffer += decoder.end();
        const headers = buffer.replace(/\r?\n$/, '').split(',').map(h => h.replace(/^\uFEFF/, '').trim());
        resolve(headers.filter(h => h.length > 0));
      });
    }), 30_000, `getCSVHeaders(${filePath})`);
  }

  /**
   * Get a readable stream for a CSV file (for large files)
   * @param {string} filePath - Full path to file in GCS
   * @returns {ReadStream} - Readable stream
   */
  getFileStream(filePath) {
    const file = this.storage.bucket(this.bucketName).file(filePath);
    return file.createReadStream();
  }

  /**
   * Get metadata (incl. md5Hash, size, updated) for a file in GCS.
   * Returns null if the file does not exist.
   * @param {string} filePath - Full path to file in GCS
   * @returns {Promise<{md5Hash:string,size:string,updated:string}|null>}
   */
  async getFileMetadata(filePath) {
    const file = this.storage.bucket(this.bucketName).file(filePath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [meta] = await file.getMetadata();
    return { md5Hash: meta.md5Hash, size: meta.size, updated: meta.updated };
  }

  /**
   * Upload a readable stream to GCS (no local disk — for very large files).
   * Resolves with the uploaded object's metadata.
   * @param {NodeJS.ReadableStream} sourceStream - Readable source (e.g. a Drive download stream)
   * @param {string} destPath - Full destination path in GCS (e.g. 'zer4u/מכירות.csv')
   * @param {Object} [options]
   * @param {string} [options.contentType] - Content-Type to set on the object
   * @returns {Promise<{md5Hash:string,size:string}>}
   */
  uploadStream(sourceStream, destPath, options = {}) {
    return new Promise((resolve, reject) => {
      const file = this.storage.bucket(this.bucketName).file(destPath);
      const writeStream = file.createWriteStream({
        resumable: true,
        contentType: options.contentType || 'text/csv',
      });
      sourceStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', async () => {
        try {
          const [meta] = await file.getMetadata();
          console.log(`⬆️  Uploaded ${destPath} (${meta.size} bytes)`);
          resolve({ md5Hash: meta.md5Hash, size: meta.size });
        } catch (err) {
          reject(err);
        }
      });
      sourceStream.pipe(writeStream);
    });
  }

  /**
   * Download file to local disk (for very large files)
   * @param {string} filePath - Full path to file in GCS
   * @param {string} destination - Local path to save
   */
  async downloadFile(filePath, destination) {
    try {
      console.log(`📥 Downloading ${filePath} to ${destination}...`);

      const file = this.storage.bucket(this.bucketName).file(filePath);
      await file.download({ destination });

      console.log(`✅ Downloaded ${filePath}`);
    } catch (error) {
      console.error(`❌ Error downloading file:`, error.message);
      throw new Error(`Failed to download file: ${error.message}`);
    }
  }
}

module.exports = new GCSService();
