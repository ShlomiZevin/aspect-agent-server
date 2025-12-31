/**
 * Read and display QVD file data using qvdjs library
 */

const { QvdDataFrame } = require('qvdjs');

async function readAndDisplayQVD(filePath, maxRows = 100) {
  try {
    console.log(`\n🔍 Reading QVD file: ${filePath}\n`);
    console.log('Please wait, loading data...\n');

    // Read the QVD file with maxRows option for better performance
    const df = await QvdDataFrame.fromQvd(filePath, { maxRows });

    // Get basic info
    const shape = df.shape;
    const columns = df.columns;

    console.log('='.repeat(80));
    console.log(`QVD FILE INFO`);
    console.log('='.repeat(80));
    console.log(`Rows loaded: ${shape[0]}`);
    console.log(`Columns: ${shape[1]}`);
    console.log(`\nColumn names:`);
    columns.forEach((col, idx) => {
      console.log(`  ${idx + 1}. ${col}`);
    });
    console.log('='.repeat(80));

    // Display first N rows
    console.log(`\n📊 FIRST ${Math.min(maxRows, shape[0])} ROWS:\n`);

    // Get data as dictionary
    const dict = await df.toDict();
    const data = dict.data || [];

    if (data.length === 0) {
      console.log('No data found in file.');
      return;
    }

    // Print in tabular format
    printTable(columns, data, Math.min(maxRows, data.length));

    console.log('\n' + '='.repeat(80));
    console.log(`✅ Successfully displayed ${Math.min(maxRows, data.length)} rows`);
    console.log('='.repeat(80) + '\n');

    return {
      shape,
      columns,
      data: data.slice(0, maxRows)
    };

  } catch (error) {
    console.error('❌ Error reading QVD file:', error.message);
    console.error(error.stack);
    throw error;
  }
}

function printTable(columns, data, rowCount) {
  // Determine column widths
  const colWidths = columns.map(col => {
    const headerWidth = col.length;
    const dataWidth = Math.max(...data.slice(0, rowCount).map(row => {
      const val = row[col];
      return val !== null && val !== undefined ? String(val).length : 0;
    }));
    return Math.min(Math.max(headerWidth, dataWidth) + 2, 40); // Max 40 chars per column
  });

  // Print header
  const headerRow = columns.map((col, idx) => {
    return col.padEnd(colWidths[idx]).substring(0, colWidths[idx]);
  }).join(' | ');

  console.log(headerRow);
  console.log('-'.repeat(headerRow.length));

  // Print data rows
  for (let i = 0; i < rowCount; i++) {
    const row = data[i];
    const rowStr = columns.map((col, idx) => {
      const val = row[col];
      const strVal = val !== null && val !== undefined ? String(val) : '';
      return strVal.padEnd(colWidths[idx]).substring(0, colWidths[idx]);
    }).join(' | ');

    console.log(rowStr);
  }
}

// Main execution
async function main() {
  const filePath = process.argv[2];
  const maxRows = parseInt(process.argv[3]) || 100;

  if (!filePath) {
    console.log('Usage: node readQvdData.js <path-to-qvd-file> [max-rows]');
    console.log('\nExample:');
    console.log('  node readQvdData.js ./data/פריטים.qvd 100');
    process.exit(1);
  }

  await readAndDisplayQVD(filePath, maxRows);
}

if (require.main === module) {
  main().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = { readAndDisplayQVD };
