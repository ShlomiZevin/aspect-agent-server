/**
 * Clean Zer4U Schema Script
 *
 * Drops and recreates the Zer4U schema from scratch
 */

require('dotenv').config();
const { Pool } = require('pg');

const SCHEMA_NAME = 'zer4u';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5
});

async function cleanSchema() {
  console.log('🧹 Cleaning Zer4U schema...\n');
  console.log('═'.repeat(60));

  const client = await pool.connect();

  try {
    const startTime = Date.now();

    // Drop schema if exists
    console.log(`📋 Dropping schema "${SCHEMA_NAME}" if exists...`);
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
    console.log(`✅ Schema dropped (${Date.now() - startTime}ms)\n`);

    // Create schema
    console.log(`🏗️  Creating fresh schema "${SCHEMA_NAME}"...`);
    const createTime = Date.now();
    await client.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    console.log(`✅ Schema created (${Date.now() - createTime}ms)\n`);

    // Grant permissions
    console.log('🔒 Setting permissions...');
    await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA_NAME} TO ${process.env.DB_USER}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${SCHEMA_NAME} TO ${process.env.DB_USER}`);
    console.log('✅ Permissions set\n');

    console.log('═'.repeat(60));
    console.log(`✅ Schema cleaned successfully! Total time: ${Date.now() - startTime}ms\n`);
    console.log('Next step: node scripts/create-zer4u-schema.js\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  cleanSchema()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { cleanSchema };
