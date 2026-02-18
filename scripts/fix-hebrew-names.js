/**
 * Fix Hebrew table names in schema analysis
 */

const fs = require('fs');
const path = require('path');

const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');

// Mapping for Hebrew filenames to English table names
const hebrewToEnglish = {
  'חנויות.csv': 'stores',  // stores/shops
  'יעדים.csv': 'targets',  // targets/goals
  'לקוחות.csv': 'customers',  // customers/clients
  'מולטיפס.csv': 'multips',  // multipliers
  'מכירות.csv': 'sales',  // sales
  'מלאי מחסנים.csv': 'warehouse_inventory',  // warehouse inventory
  'מלאי מינימום.csv': 'minimum_inventory',  // minimum inventory
  'מלאי.csv': 'inventory',  // inventory/stock
  'פריטים.csv': 'items',  // items/products
  'תאריכי ספירת מלאי.csv': 'inventory_count_dates'  // inventory count dates
};

console.log('🔧 Fixing Hebrew table names...\n');

// Load analysis
const data = JSON.parse(fs.readFileSync(ANALYSIS_FILE, 'utf8'));

// Fix table names
let fixed = 0;
data.forEach(item => {
  if (!item.tableName || item.tableName === '') {
    const englishName = hebrewToEnglish[item.fileName];
    if (englishName) {
      console.log(`✅ ${item.fileName} -> ${englishName}`);
      item.tableName = englishName;
      fixed++;
    } else {
      console.log(`⚠️  ${item.fileName} -> no mapping found`);
    }
  }
});

// Save updated analysis
fs.writeFileSync(ANALYSIS_FILE, JSON.stringify(data, null, 2));

console.log(`\n✅ Fixed ${fixed} table names`);
console.log(`Updated: ${ANALYSIS_FILE}\n`);
