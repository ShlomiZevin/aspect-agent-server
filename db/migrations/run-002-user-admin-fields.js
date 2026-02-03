/**
 * Migration Runner: 002_add_user_admin_fields.sql
 *
 * Adds admin-related fields to users and conversations tables.
 * Run with: node db/migrations/run-002-user-admin-fields.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Client } = require('pg');
const fs = require('fs');

async function runMigration() {
  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    console.log('🔄 Connecting to database...');
    await client.connect();
    console.log('✅ Connected to database');

    // Read migration SQL
    const migrationPath = path.join(__dirname, '002_add_user_admin_fields.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('🔄 Running migration: 002_add_user_admin_fields.sql');
    await client.query(sql);
    console.log('✅ Migration completed successfully');

    // Verify new columns
    const result = await client.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'users'
      AND column_name IN ('phone', 'role', 'source', 'subscription', 'tenant', 'whatsapp_conversation_id', 'last_active_at')
      ORDER BY column_name
    `);

    console.log('\n📋 New columns in users table:');
    result.rows.forEach(row => {
      console.log(`   - ${row.column_name}: ${row.data_type} (default: ${row.column_default || 'none'})`);
    });

    // Check conversations channel column
    const convResult = await client.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'conversations'
      AND column_name = 'channel'
    `);

    if (convResult.rows.length > 0) {
      console.log('\n📋 New column in conversations table:');
      console.log(`   - channel: ${convResult.rows[0].data_type} (default: ${convResult.rows[0].column_default || 'none'})`);
    }

    // Show updated user counts
    const stats = await client.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE source = 'web') as web_users,
        COUNT(*) FILTER (WHERE source = 'whatsapp') as whatsapp_users
      FROM users
    `);

    console.log('\n📊 User statistics after migration:');
    console.log(`   Total users: ${stats.rows[0].total}`);
    console.log(`   Web users: ${stats.rows[0].web_users}`);
    console.log(`   WhatsApp users: ${stats.rows[0].whatsapp_users}`);

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
    console.log('\n🔒 Database connection closed');
  }
}

runMigration();
