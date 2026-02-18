/**
 * Master Script: Complete Zer4U Data Reload
 *
 * Runs the complete data reload process:
 * 1. Drop existing schema
 * 2. Create schema structure
 * 3. Load all CSV data
 *
 * ULTRA-OPTIMIZED FOR MAXIMUM SPEED:
 * - PostgreSQL COPY command (10-50x faster than INSERT)
 * - No constraints (FK, PK, unique)
 * - Direct streaming from GCS
 * - Detailed timing logs
 */

require('dotenv').config();
const { cleanSchema } = require('./clean-zer4u-schema');
const { createSchema } = require('./create-zer4u-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy'); // Using COPY for 10-50x speed boost!

async function reloadAllData() {
  const startTime = Date.now();

  console.log('╔' + '═'.repeat(78) + '╗');
  console.log('║' + ' '.repeat(20) + '🔄 ZER4U DATA RELOAD - OPTIMIZED' + ' '.repeat(26) + '║');
  console.log('╚' + '═'.repeat(78) + '╝');
  console.log();

  try {
    // Step 1: Clean schema
    console.log('🗑️  STEP 1/3: Cleaning existing schema...\n');
    const step1Start = Date.now();
    await cleanSchema();
    console.log(`✅ Step 1 completed in ${((Date.now() - step1Start) / 1000).toFixed(2)}s\n`);

    // Step 2: Create schema structure
    console.log('🏗️  STEP 2/3: Creating schema structure...\n');
    const step2Start = Date.now();
    await createSchema();
    console.log(`✅ Step 2 completed in ${((Date.now() - step2Start) / 1000).toFixed(2)}s\n`);

    // Step 3: Load CSV data
    console.log('📥 STEP 3/3: Loading CSV data...\n');
    const step3Start = Date.now();
    await loadAllCSVFiles();
    console.log(`✅ Step 3 completed in ${formatDuration(Date.now() - step3Start)}\n`);

    // Final summary
    const totalTime = Date.now() - startTime;
    console.log('╔' + '═'.repeat(78) + '╗');
    console.log('║' + ' '.repeat(30) + '🎉 RELOAD COMPLETE!' + ' '.repeat(29) + '║');
    console.log('╚' + '═'.repeat(78) + '╝');
    console.log();
    console.log(`⏱️  Total time: ${formatDuration(totalTime)}`);
    console.log();
    console.log('Next step: Test the Zer4U crew member in the UI! 🚀');
    console.log();

  } catch (error) {
    console.error('\n❌ RELOAD FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }

  process.exit(0);
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// Run if called directly
if (require.main === module) {
  console.log('\n🚀 Starting complete data reload...\n');

  // Confirm with user
  console.log('⚠️  WARNING: This will DROP all existing Zer4U data!');
  console.log('⚠️  Make sure you have backups if needed.\n');

  // In production, add confirmation prompt here
  // For now, proceed automatically

  setTimeout(() => {
    reloadAllData();
  }, 2000);
}

module.exports = { reloadAllData };
