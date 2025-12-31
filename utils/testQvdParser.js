/**
 * Simple test for QVD Parser
 * This tests the parser with a local QVD file
 */

const QVDParser = require('./qvdParser');
const path = require('path');

async function testParser() {
  try {
    // Test with a local QVD file
    const testFilePath = process.argv[2];

    if (!testFilePath) {
      console.log('Usage: node testQvdParser.js <path-to-qvd-file>');
      console.log('\nExample:');
      console.log('  node testQvdParser.js ./data/sample.qvd');
      process.exit(1);
    }

    console.log('🔍 Testing QVD Parser...\n');
    console.log(`File: ${testFilePath}\n`);

    const parser = new QVDParser(testFilePath);
    const data = await parser.parse();

    console.log('📊 Parsed Data:');
    console.log('─'.repeat(60));
    console.log(parser.getSummary());
    console.log('─'.repeat(60));

    console.log('\n📋 Field Details:');
    data.metadata.fields.forEach((field, idx) => {
      console.log(`\n${idx + 1}. ${field.name}`);
      console.log(`   Type: ${field.type}`);
      console.log(`   Unique Values: ${field.noOfSymbols}`);
      if (field.comment) {
        console.log(`   Comment: ${field.comment}`);
      }
    });

    console.log('\n✅ Test completed successfully!');
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testParser();
