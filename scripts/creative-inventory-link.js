/**
 * Prints Reut's link to the ZolStock creative daily store inventory (#107),
 * creating its secret on first use. With --refresh it also rebuilds the table
 * in GCS from the current Drive files (what the nightly tick does), and with
 * --force it rebuilds even if the files did not change.
 *
 * Reads DRIVE_SYNC_SA_KEY from the env file given by ENV_FILE
 * (default .env.production.aspect) - the same service account production uses.
 *
 * Usage:
 *   node scripts/creative-inventory-link.js [--refresh] [--force]
 */

require('dotenv').config({ path: process.env.ENV_FILE || '.env.production.aspect', quiet: true });
const creativeExport = require('../services/creative-inventory-export.service');

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--refresh') || args.has('--force')) {
    const started = Date.now();
    const r = await creativeExport.refresh({ force: args.has('--force') });
    console.log(JSON.stringify({ ...r, seconds: ((Date.now() - started) / 1000).toFixed(1) }, null, 2));
  }
  const token = await creativeExport.getToken();
  console.log(creativeExport.publicLink(token));
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
