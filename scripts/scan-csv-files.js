/**
 * CSV Scanner Script
 *
 * Scans all CSV files from Google Cloud Storage (zer4u folder)
 * and analyzes their structure for database schema creation
 */

require('dotenv').config();
const gcsService = require('../services/gcs.service');
const fs = require('fs').promises;
const path = require('path');

const FOLDER_PREFIX = 'zer4u/';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');

async function scanAllCSVFiles() {
  console.log('🚀 Starting CSV scan for Zer4U data...\n');

  try {
    // Step 1: List all CSV files
    console.log('📋 Step 1: Listing all CSV files...');
    const files = await gcsService.listCSVFiles(FOLDER_PREFIX);
    console.log(`Found ${files.length} CSV files\n`);

    if (files.length === 0) {
      console.log('❌ No CSV files found. Exiting.');
      return;
    }

    // Step 2: Analyze each file structure
    console.log('📊 Step 2: Analyzing file structures...\n');
    const schemas = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`[${i + 1}/${files.length}] Analyzing: ${file.basename}`);
      console.log(`  Size: ${formatBytes(file.size)}`);

      try {
        // Sample size based on file size
        const sampleSize = file.size > 100 * 1024 * 1024 ? 500 : 1000; // 500 rows for files > 100MB

        const schema = await gcsService.analyzeCSVStructure(file.name, sampleSize);

        schemas.push({
          fileName: file.basename,
          filePath: file.name,
          fileSize: file.size,
          tableName: sanitizeTableName(file.basename),
          columns: schema.columns,
          sampleRowCount: schema.rowCount,
          sample: schema.sample
        });

        console.log(`  ✅ ${schema.columns.length} columns identified\n`);
      } catch (error) {
        console.error(`  ❌ Error analyzing ${file.basename}: ${error.message}\n`);
        schemas.push({
          fileName: file.basename,
          filePath: file.name,
          fileSize: file.size,
          error: error.message
        });
      }
    }

    // Step 3: Save analysis results
    console.log('\n💾 Step 3: Saving analysis results...');

    // Ensure data directory exists
    const dataDir = path.join(__dirname, '..', 'data');
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
      // Directory might already exist
    }

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(schemas, null, 2));
    console.log(`✅ Analysis saved to: ${OUTPUT_FILE}\n`);

    // Step 4: Print summary
    console.log('📈 SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Total files: ${files.length}`);
    console.log(`Successfully analyzed: ${schemas.filter(s => !s.error).length}`);
    console.log(`Failed: ${schemas.filter(s => s.error).length}`);
    console.log(`Total size: ${formatBytes(files.reduce((sum, f) => sum + parseInt(f.size), 0))}`);
    console.log('═'.repeat(60));

    console.log('\n📋 Tables to be created:');
    schemas
      .filter(s => !s.error)
      .forEach(s => {
        console.log(`  • ${s.tableName.padEnd(40)} (${s.columns.length} columns, ${formatBytes(s.fileSize)})`);
      });

    if (schemas.filter(s => s.error).length > 0) {
      console.log('\n⚠️  Failed files:');
      schemas
        .filter(s => s.error)
        .forEach(s => {
          console.log(`  • ${s.fileName}: ${s.error}`);
        });
    }

    console.log('\n✅ Scan complete!');
    console.log(`\nNext steps:`);
    console.log(`  1. Review: ${OUTPUT_FILE}`);
    console.log(`  2. Run: node scripts/create-zer4u-schema.js`);
    console.log(`  3. Run: node scripts/load-csv-to-db.js\n`);

    return schemas;
  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
  }
}

/**
 * Convert file name to valid PostgreSQL table name
 */
function sanitizeTableName(fileName) {
  return fileName
    .replace('.csv', '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Run if called directly
if (require.main === module) {
  scanAllCSVFiles()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { scanAllCSVFiles };
