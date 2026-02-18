const { Storage } = require('@google-cloud/storage');
const csv = require('csv-parser');
const { Readable } = require('stream');

/**
 * Google Cloud Storage Service
 *
 * Handles CSV file operations from GCS buckets
 */
class GCSService {
  constructor() {
    // Initialize GCS client
    // Uses Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS env var
    this.storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID || 'aspect-agents'
    });

    this.bucketName = 'aspect-clients-data';
  }

  /**
   * List all CSV files in a specific folder
   * @param {string} folderPrefix - Folder path (e.g., 'zer4u/')
   * @returns {Promise<Array>} - Array of file metadata
   */
  async listCSVFiles(folderPrefix) {
    try {
      const [files] = await this.storage
        .bucket(this.bucketName)
        .getFiles({ prefix: folderPrefix });

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
   * Get a readable stream for a CSV file (for large files)
   * @param {string} filePath - Full path to file in GCS
   * @returns {ReadStream} - Readable stream
   */
  getFileStream(filePath) {
    const file = this.storage.bucket(this.bucketName).file(filePath);
    return file.createReadStream();
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
