/**
 * Create sales table separately with better Hebrew handling
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5
});

async function createSalesTable() {
  const client = await pool.connect();

  try {
    console.log('🏗️  Creating sales table...\n');

    // Load analysis
    const data = JSON.parse(fs.readFileSync('data/zer4u-schema-analysis.json', 'utf8'));
    const salesSchema = data.find(t => t.tableName === 'sales');

    if (!salesSchema) {
      console.error('❌ Sales table not found in analysis');
      return;
    }

    // Drop if exists
    await client.query('DROP TABLE IF EXISTS zer4u.sales CASCADE');

    // Build column definitions with escaped names
    const columnDefs = salesSchema.columns.map((col, idx) => {
      // Remove BOM and trim
      const cleanName = col.name.replace(/^\uFEFF/, '').trim();
      const nullable = col.nullable ? 'NULL' : 'NOT NULL';

      // Use positional column names for safety (c1, c2, c3, etc)
      // Store original names as comments
      return `  c${idx + 1} ${col.type} ${nullable} -- ${cleanName}`;
    });

    const createSQL = `
CREATE TABLE zer4u.sales (
${columnDefs.join(',\n')}
);
    `.trim();

    console.log('Creating table with positional column names (c1, c2, ...)');
    console.log(`Columns: ${salesSchema.columns.length}\n`);

    await client.query(createSQL);

    console.log('✅ Sales table created!\n');

    // Create a mapping file for reference
    const mapping = {};
    salesSchema.columns.forEach((col, idx) => {
      mapping[`c${idx + 1}`] = col.name.replace(/^\uFEFF/, '').trim();
    });

    fs.writeFileSync(
      'data/sales-column-mapping.json',
      JSON.stringify(mapping, null, 2)
    );

    console.log('✅ Column mapping saved to: data/sales-column-mapping.json');
    console.log('\nSample mapping:');
    Object.entries(mapping).slice(0, 5).forEach(([key, val]) => {
      console.log(`  ${key} -> ${val}`);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

createSalesTable()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
