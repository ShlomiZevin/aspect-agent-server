/**
 * Print QVD file data in a readable table format
 */

const { QvdDataFrame } = require('qvdjs');

async function printQVD(filePath, maxRows = 100) {
  try {
    console.log(`\n🔍 Reading QVD file: ${filePath}\n`);

    // Read with maxRows for better performance
    const df = await QvdDataFrame.fromQvd(filePath, { maxRows });

    const columns = df.columns;
    const shape = df.shape;
    const data = df.data; // Direct access to data array

    console.log('='.repeat(100));
    console.log(`TABLE: ${df._metadata.TableName || 'Unknown'}`);
    console.log(`Total Rows Loaded: ${shape[0]} rows (of ${df._metadata.NoOfRecords} total)`);
    console.log(`Columns: ${shape[1]}`);
    console.log('='.repeat(100));

    console.log('\n📋 Columns:');
    columns.forEach((col, idx) => {
      console.log(`  ${(idx + 1).toString().padStart(2)}. ${col}`);
    });

    console.log('\n' + '='.repeat(100));
    console.log(`FIRST ${Math.min(maxRows, shape[0])} ROWS`);
    console.log('='.repeat(100) + '\n');

    // Print data in table format
    printDataTable(columns, data);

    console.log('\n' + '='.repeat(100));
    console.log(`✅ Successfully displayed ${data.length} rows`);
    console.log('='.repeat(100) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    throw error;
  }
}

function printDataTable(columns, data) {
  // Determine optimal column widths
  const colWidths = columns.map((col, colIdx) => {
    const headerWidth = col.length;
    const maxDataWidth = Math.max(...data.map(row => {
      const val = row[colIdx];
      return val !== null && val !== undefined ? String(val).length : 0;
    }));
    // Limit to 35 characters max for readability
    return Math.min(Math.max(headerWidth, maxDataWidth), 35);
  });

  // Print header
  const headerRow = columns.map((col, idx) => {
    const truncated = col.length > colWidths[idx] ? col.substring(0, colWidths[idx] - 2) + '..' : col;
    return truncated.padEnd(colWidths[idx]);
  }).join(' │ ');

  console.log(headerRow);
  console.log(colWidths.map(w => '─'.repeat(w)).join('─┼─'));

  // Print data rows
  data.forEach((row, rowIdx) => {
    const rowStr = row.map((val, colIdx) => {
      let strVal = val !== null && val !== undefined ? String(val) : '';
      // Truncate if too long
      if (strVal.length > colWidths[colIdx]) {
        strVal = strVal.substring(0, colWidths[colIdx] - 2) + '..';
      }
      return strVal.padEnd(colWidths[colIdx]);
    }).join(' │ ');

    console.log(rowStr);
  });
}

// Main
async function main() {
  const filePath = process.argv[2];
  const maxRows = parseInt(process.argv[3]) || 100;

  if (!filePath) {
    console.log('Usage: node printQvd.js <path-to-qvd-file> [max-rows]');
    console.log('\nExample:');
    console.log('  node printQvd.js ./data/פריטים.qvd 100');
    console.log('  node printQvd.js ./data/פריטים.qvd 50');
    process.exit(1);
  }

  await printQVD(filePath, maxRows);
}

if (require.main === module) {
  main().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = { printQVD };
