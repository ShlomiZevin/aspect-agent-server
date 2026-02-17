/**
 * Test Zer4U Data Flow
 *
 * Tests the complete flow:
 * 1. Schema description generation
 * 2. SQL generation from question
 * 3. Query execution
 * 4. Data retrieval
 */

require('dotenv').config();
const schemaDescriptorService = require('../services/schema-descriptor.service');
const sqlGeneratorService = require('../services/sql-generator.service');
const dataQueryService = require('../services/data-query.service');

async function testCompleteFlow() {
  console.log('🧪 Testing Zer4U Data Flow\n');
  console.log('═'.repeat(60));

  try {
    // Test 1: Schema Description
    console.log('\n📊 Test 1: Generating Schema Description...\n');
    const description = await schemaDescriptorService.getDescription('zer4u');
    console.log(`✅ Generated description (${description.length} characters)`);
    console.log(`First 500 chars:\n${description.substring(0, 500)}...\n`);

    // Test 2: SQL Generation
    console.log('\n🤖 Test 2: Generating SQL from Question...\n');

    const testQuestions = [
      'How many stores do we have?',
      'What are the top 5 selling items?',
      'Show me total sales by store'
    ];

    for (const question of testQuestions) {
      console.log(`\nQuestion: "${question}"`);

      const sqlResult = await sqlGeneratorService.generateSQL(question, 'zer4u');

      console.log(`Generated SQL:`);
      console.log(`  ${sqlResult.sql}`);
      console.log(`Explanation: ${sqlResult.explanation}`);
      console.log(`Confidence: ${sqlResult.confidence}`);
      console.log(`Tables: ${sqlResult.tables.join(', ')}`);
    }

    // Test 3: Full Data Query
    console.log('\n\n📈 Test 3: Full Data Query (Question → SQL → Data)...\n');

    const queryQuestion = 'How many stores do we have?';
    console.log(`Question: "${queryQuestion}"`);

    const result = await dataQueryService.queryByQuestion(queryQuestion, 'zer4u');

    if (result.error) {
      console.log(`❌ Error: ${result.message}`);
    } else {
      console.log(`\n✅ Query successful!`);
      console.log(`SQL: ${result.sql}`);
      console.log(`Explanation: ${result.explanation}`);
      console.log(`Rows returned: ${result.rowCount}`);
      console.log(`Columns: ${result.columns.join(', ')}`);
      console.log(`Duration: ${result.duration}ms`);

      if (result.data.length > 0) {
        console.log(`\nFirst result:`);
        console.log(JSON.stringify(result.data[0], null, 2));
      }
    }

    // Test 4: Sample Data
    console.log('\n\n📋 Test 4: Fetching Sample Data...\n');

    const sampleTables = ['stores', 'customers', 'items'];

    for (const table of sampleTables) {
      try {
        const sample = await dataQueryService.getSampleData('zer4u', table, 3);
        console.log(`\nTable: ${table}`);
        console.log(`  Rows: ${sample.rowCount}`);
        console.log(`  Columns: ${sample.columns.join(', ')}`);
        if (sample.data.length > 0) {
          console.log(`  Sample: ${JSON.stringify(sample.data[0])}`);
        }
      } catch (error) {
        console.log(`\nTable: ${table}`);
        console.log(`  ⚠️  ${error.message}`);
      }
    }

    console.log('\n\n═'.repeat(60));
    console.log('✅ All tests completed!\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error(error.stack);
  } finally {
    await schemaDescriptorService.close();
    await dataQueryService.close();
    process.exit(0);
  }
}

// Run tests
testCompleteFlow();
