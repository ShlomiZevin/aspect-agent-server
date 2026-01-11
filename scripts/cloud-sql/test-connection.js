#!/usr/bin/env node

/**
 * Database Connection Test Script (Node.js version for Windows)
 * Tests the connection to Cloud SQL PostgreSQL and verifies database setup
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m'
};

function printInfo(msg) {
  console.log(`${colors.blue}ℹ${colors.reset} ${msg}`);
}

function printSuccess(msg) {
  console.log(`${colors.green}✅${colors.reset} ${msg}`);
}

function printError(msg) {
  console.log(`${colors.red}❌${colors.reset} ${msg}`);
}

function printWarning(msg) {
  console.log(`${colors.yellow}⚠${colors.reset} ${msg}`);
}

async function testConnection() {
  // Load environment variables from .env.cloudsql
  const envPath = path.join(__dirname, '..', '.env.cloudsql');

  if (!fs.existsSync(envPath)) {
    printError('Environment file not found: .env.cloudsql');
    printInfo('Run provision-cloudsql.sh first to create the environment file');
    process.exit(1);
  }

  printInfo('Loading configuration from .env.cloudsql');

  // Parse .env file
  const envContent = fs.readFileSync(envPath, 'utf8');
  const envVars = {};
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      envVars[match[1].trim()] = match[2].trim();
    }
  });

  const config = {
    host: envVars.DB_HOST,
    port: parseInt(envVars.DB_PORT || '5432', 10),
    database: envVars.DB_NAME,
    user: envVars.DB_USER,
    password: envVars.DB_PASSWORD,
    ssl: false
  };

  if (!config.host || !config.database || !config.user || !config.password) {
    printError('Missing required environment variables');
    process.exit(1);
  }

  printInfo('==========================================');
  printInfo('Database Connection Test');
  printInfo('==========================================');
  printInfo(`Host: ${config.host}`);
  printInfo(`Port: ${config.port}`);
  printInfo(`Database: ${config.database}`);
  printInfo(`User: ${config.user}`);
  printInfo('==========================================');
  console.log('');

  const client = new Client(config);
  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Test 1: Basic connection
    printInfo('Test 1: Testing basic connection...');
    await client.connect();
    printSuccess('Basic connection successful');
    testsPassed++;

    // Test 2: Check PostgreSQL version
    printInfo('Test 2: Checking PostgreSQL version...');
    const versionResult = await client.query('SELECT version()');
    printSuccess(`PostgreSQL version: ${versionResult.rows[0].version.split(',')[0]}`);
    testsPassed++;

    // Test 3: List databases
    printInfo('Test 3: Listing accessible databases...');
    const dbResult = await client.query(`
      SELECT datname FROM pg_database WHERE datistemplate = false
    `);
    const databases = dbResult.rows.map(r => r.datname).join(', ');
    printSuccess(`Databases: ${databases}`);
    testsPassed++;

    // Test 4: Check if test table exists
    printInfo('Test 4: Checking for test table...');
    const tableResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'connection_test'
      ) as exists
    `);

    if (tableResult.rows[0].exists) {
      printSuccess('Test table exists');

      // Read test data
      printInfo('Reading test data...');
      const testData = await client.query('SELECT * FROM connection_test ORDER BY created_at DESC LIMIT 5');
      console.log('');
      console.log('Test Data:');
      console.table(testData.rows);
      testsPassed++;
    } else {
      printWarning('Test table does not exist');
      printInfo('Run init-database.js to create it');
      testsFailed++;
    }

    // Test 5: Check schemas
    printInfo('Test 5: Checking schemas...');
    const schemaResult = await client.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name NOT LIKE 'pg_%'
        AND schema_name != 'information_schema'
      ORDER BY schema_name
    `);
    const schemas = schemaResult.rows.map(r => r.schema_name).join(', ');
    printSuccess(`Schemas: ${schemas}`);
    testsPassed++;

    // Test 6: Test write permissions
    printInfo('Test 6: Testing write permissions...');
    await client.query('CREATE TEMP TABLE test_write (id int)');
    await client.query('INSERT INTO test_write VALUES (1)');
    const writeResult = await client.query('SELECT COUNT(*) FROM test_write');
    await client.query('DROP TABLE test_write');

    if (writeResult.rows[0].count === '1') {
      printSuccess('Write permissions verified');
      testsPassed++;
    } else {
      printError('Write permissions test failed');
      testsFailed++;
    }

    // Test 7: Get database info
    printInfo('Test 7: Getting database information...');
    const infoResult = await client.query(`
      SELECT
        current_database() as database,
        current_user as user,
        pg_size_pretty(pg_database_size(current_database())) as size
    `);
    printSuccess(`Database size: ${infoResult.rows[0].size}`);
    testsPassed++;

    console.log('');
    printInfo('==========================================');
    printSuccess(`All tests completed! Passed: ${testsPassed}, Failed: ${testsFailed}`);
    printInfo('==========================================');
    console.log('');
    printInfo('Connection string for your application:');
    printInfo(`postgresql://${config.user}:****@${config.host}:${config.port}/${config.database}`);
    console.log('');
    printSuccess('Your database is ready for use!');

  } catch (error) {
    printError('Connection test failed');
    printError(error.message);
    console.log('');
    printWarning('Make sure:');
    printWarning('  1. Your IP is authorized in Cloud SQL');
    printWarning('  2. The instance is running');
    printWarning('  3. Credentials are correct');
    console.error('');
    console.error('Full error:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run tests
testConnection().catch(error => {
  printError('Unexpected error:');
  console.error(error);
  process.exit(1);
});
