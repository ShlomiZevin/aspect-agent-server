/**
 * Check Loaded Tables Status
 *
 * Shows all tables in zer4u schema with sizes and row counts
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

async function checkLoadedTables() {
  try {
    console.log('\n📊 ZER4U SCHEMA - LOADED TABLES:\n');
    console.log('═'.repeat(80));

    // Get table info
    const result = await pool.query(`
      SELECT
        table_name,
        pg_size_pretty(pg_total_relation_size('zer4u.' || table_name)) as size,
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'zer4u' AND columns.table_name = tables.table_name) as columns,
        pg_total_relation_size('zer4u.' || table_name) as size_bytes
      FROM information_schema.tables
      WHERE table_schema = 'zer4u'
      ORDER BY size_bytes DESC;
    `);

    console.log(sprintf('%-35s %12s %10s', 'TABLE NAME', 'SIZE', 'COLUMNS'));
    console.log('═'.repeat(80));

    let totalSize = 0;
    for (const row of result.rows) {
      // Get row count for each table
      const countResult = await pool.query(`SELECT count(*) as cnt FROM zer4u.${row.table_name}`);
      const rowCount = parseInt(countResult.rows[0].cnt);

      console.log(sprintf('%-35s %12s %10s %15s',
        row.table_name,
        row.size,
        row.columns,
        rowCount.toLocaleString() + ' rows'
      ));
      totalSize += parseInt(row.size_bytes);
    }

    console.log('═'.repeat(80));
    console.log(`Total tables: ${result.rows.length}`);
    console.log(`Total size: ${formatBytes(totalSize)}`);
    console.log('');

    // Check which tables are missing
    const expectedTables = [
      'arkot', 'calendar', 'dl_distribution_svc_groups_qcs', 'dl_distribution_svc_users_qcs',
      'hesbonithiuvi', 'inlfed_1', 'inlfed_2', 'inlfed_3', 'inlfed_4', 'inlfed_5',
      'inlfed_6', 'inlfed_7', 'inlfed', 'linktable', 'linktargettable', 'shorot_kbla',
      'same_store', 'taarichim_hashvaa', 'employee_units_costed', 'units_delivery_costed',
      'stores', 'targets', 'customers', 'multips', 'sales', 'warehouse_inventory',
      'min_inventory', 'inventory', 'items', 'inventory_count_dates'
    ];

    const loadedTables = result.rows.map(r => r.table_name);
    const missingTables = expectedTables.filter(t => !loadedTables.includes(t));

    if (missingTables.length > 0) {
      console.log('❌ MISSING TABLES:');
      missingTables.forEach(t => console.log(`  - ${t}`));
      console.log('');
    } else {
      console.log('✅ ALL 30 TABLES LOADED!\n');
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

function sprintf(format, ...args) {
  let i = 0;
  return format.replace(/%-?(\d+)s/g, (match, width) => {
    const val = String(args[i++] || '');
    const isLeft = match[1] === '-';
    const w = parseInt(width);
    if (isLeft) {
      return val.padEnd(w, ' ');
    }
    return val.padStart(w, ' ');
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

if (require.main === module) {
  checkLoadedTables();
}

module.exports = { checkLoadedTables };
