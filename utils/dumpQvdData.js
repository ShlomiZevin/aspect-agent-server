/**
 * Dump QVD data directly using qvdjs DataFrame
 */

const { QvdDataFrame } = require('qvdjs');
const util = require('util');

async function dumpQVD(filePath, maxRows = 100) {
  try {
    console.log(`\n🔍 Reading QVD file: ${filePath}\n`);

    // Read with maxRows for performance
    const df = await QvdDataFrame.fromQvd(filePath, { maxRows });

    console.log('📊 DataFrame Properties:');
    console.log('  - Shape:', df.shape);
    console.log('  - Columns:', df.columns);
    console.log('  - Index length:', df.index?.length || 'N/A');

    console.log('\n📋 Using head() method to show first 10 rows:\n');

    const head = df.head(10);
    console.log(util.inspect(head, { depth: null, colors: true, maxArrayLength: null }));

    console.log('\n📋 Trying direct data access:\n');

    // Try to access data property directly
    if (df.data) {
      console.log('df.data exists!');
      console.log('First row:', df.data[0]);
    }

    // Try to convert to dict
    console.log('\n📋 Converting to dictionary format:\n');
    const dict = await df.toDict();
    console.log('Dictionary keys:', Object.keys(dict));

    if (dict.data && dict.data.length > 0) {
      console.log('\nFirst 3 records from dict.data:');
      console.log(JSON.stringify(dict.data.slice(0, 3), null, 2));
    }

    // Try accessing individual columns
    if (df.columns && df.columns.length > 0) {
      console.log(`\n📋 Accessing first column: ${df.columns[0]}`);
      try {
        const firstCol = df[df.columns[0]];
        console.log('First column values (first 10):', firstCol?.slice(0, 10) || 'N/A');
      } catch (e) {
        console.log('Error accessing column:', e.message);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    throw error;
  }
}

// Main
async function main() {
  const filePath = process.argv[2] || 'data/פריטים.qvd';
  const maxRows = parseInt(process.argv[3]) || 100;

  await dumpQVD(filePath, maxRows);
}

main().catch(console.error);
