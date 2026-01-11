#!/usr/bin/env node

/**
 * Database Initialization Script (Node.js version for Windows)
 * Initializes the agents platform database with a test table
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

async function initDatabase() {
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
  printInfo('Database Initialization');
  printInfo('==========================================');
  printInfo(`Host: ${config.host}`);
  printInfo(`Database: ${config.database}`);
  printInfo(`User: ${config.user}`);
  printInfo('==========================================');

  const client = new Client(config);

  try {
    printInfo('Connecting to database...');
    await client.connect();
    printSuccess('Connected to database');

    // Create test table
    printInfo('Creating test table...');
    await client.query(`
      DROP TABLE IF EXISTS connection_test;

      CREATE TABLE connection_test (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    printSuccess('Test table created');

    // Insert test record
    printInfo('Inserting test record...');
    await client.query(`
      INSERT INTO connection_test (message)
      VALUES ('Database connection successful!');
    `);
    printSuccess('Test record inserted');

    // Create agents schema
    printInfo('Creating agents schema...');
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS agents;
      COMMENT ON SCHEMA agents IS 'Schema for multi-agent platform data';
    `);
    printSuccess('Agents schema created');

    // Verify initialization
    printInfo('Verifying initialization...');
    const result = await client.query(`
      SELECT
        'Database initialized successfully!' as status,
        COUNT(*) as test_records
      FROM connection_test;
    `);

    printSuccess('Database initialized successfully!');
    console.log('');
    printInfo('Created:');
    printInfo('  - connection_test table with sample data');
    printInfo('  - agents schema for platform tables');
    console.log('');
    printInfo(`Test records: ${result.rows[0].test_records}`);
    console.log('');
    printSuccess('You can now run test-connection.js to verify the setup');

  } catch (error) {
    printError('Database initialization failed');
    printError(error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run initialization
initDatabase().catch(error => {
  printError('Unexpected error:');
  console.error(error);
  process.exit(1);
});
