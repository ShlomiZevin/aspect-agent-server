/**
 * Builds the ZolStock creative daily store-inventory CSV from local copies of
 * Reut's two files (tasks #106 / #107). See services/creative-inventory.service.js
 * for the calculation rules.
 *
 * Usage:
 *   node scripts/export-creative-inventory.js <CustomerOrdersCreativeMaterials.csv> <SalesCreativeMaterials.csv> <out.csv>
 */

const fs = require('fs');
const { writeDailyStock } = require('../services/creative-inventory.service');

async function main() {
  const [entriesPath, exitsPath, outPath] = process.argv.slice(2);
  if (!entriesPath || !exitsPath || !outPath) {
    console.error('Usage: node scripts/export-creative-inventory.js <entries.csv> <exits.csv> <out.csv>');
    process.exit(1);
  }

  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  // BOM so Excel opens the Hebrew header correctly; Qlik ignores it.
  out.write('﻿');
  const write = chunk => (out.write(chunk) ? undefined : new Promise(r => out.once('drain', r)));

  const started = Date.now();
  const stats = await writeDailyStock(
    fs.readFileSync(entriesPath, 'utf8'),
    fs.readFileSync(exitsPath, 'utf8'),
    write,
  );
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));

  console.log(JSON.stringify({ ...stats, outPath, seconds: ((Date.now() - started) / 1000).toFixed(1) }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
