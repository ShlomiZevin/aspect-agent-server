/**
 * Read QVD file using qvdjs library and print first N rows
 */

const { QvdDataFrame } = require('qvdjs');

async function readQVD(filePath, maxRows = 100) {
  try {
    console.log(`\n🔍 Reading QVD file: ${filePath}\n`);

    // Read the QVD file
    const qvdFile = await QvdDataFrame.fromQvd(filePath);

    // Convert to dictionary format
    const dataDict = await qvdFile.toDict();

    const tableName = dataDict.tableName || 'Unknown';
    const fields = dataDict.fields || [];
    const data = dataDict.data || [];
    const recordCount = data.length;

    console.log('='.repeat(80));
    console.log(`TABLE: ${tableName}`);
    console.log(`Total Records: ${recordCount}`);
    console.log(`Fields: ${fields.length}`);
    console.log('='.repeat(80));

    console.log('\n📋 Field Names:');
    fields.forEach((field, idx) => {
      console.log(`  ${idx + 1}. ${field.name}`);
    });

    console.log('\n' + '='.repeat(80));
    console.log(`FIRST ${Math.min(maxRows, recordCount)} ROWS:`);
    console.log('='.repeat(80) + '\n');

    // Print header
    const header = fields.map(f => f.name).join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));

    // Get records
    const limit = Math.min(maxRows, data.length);

    // Print rows
    for (let i = 0; i < limit; i++) {
      const record = data[i];
      const row = fields.map(field => {
        const value = record[field.name];
        // Limit each cell to 30 characters for display
        const strValue = value !== null && value !== undefined ? String(value) : '';
        return strValue.length > 30 ? strValue.substring(0, 27) + '...' : strValue;
      }).join(' | ');

      console.log(row);
    }

    console.log('\n' + '='.repeat(80));
    console.log(`✅ Successfully read ${limit} rows from ${recordCount} total records`);
    console.log('='.repeat(80) + '\n');

    // Return data for further processing
    return {
      tableName,
      fields,
      recordCount,
      records: data.slice(0, maxRows)
    };

  } catch (error) {
    console.error('❌ Error reading QVD file:', error.message);
    console.error(error.stack);
    throw error;
  }
}

// Main execution
async function main() {
  const filePath = process.argv[2];
  const maxRows = parseInt(process.argv[3]) || 100;

  if (!filePath) {
    console.log('Usage: node readQvdWithLibrary.js <path-to-qvd-file> [max-rows]');
    console.log('\nExample:');
    console.log('  node readQvdWithLibrary.js ./data/פריטים.qvd 100');
    process.exit(1);
  }

  await readQVD(filePath, maxRows);
}

if (require.main === module) {
  main().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = { readQVD };
