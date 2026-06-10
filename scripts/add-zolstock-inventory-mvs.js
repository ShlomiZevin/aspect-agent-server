/**
 * Build ONLY the zolstock inventory materialized view(s) on the LIVE schema.
 *
 * Why a separate runner: create-zolstock-mvs.js DROP+CREATEs every MV in the
 * list, including the heavy sales MVs (~35M-row aggregates). Rebuilding those on
 * the live schema risks the Cloud-Run-kill-at-swap loop seen during the initial
 * load. The inventory MV only aggregates the LATEST stock snapshot, so it builds
 * in seconds — this runner adds it without re-touching the sales MVs.
 *
 * Run against prod (Cloud SQL Proxy or prod DATABASE_URL in .env):
 *   node scripts/add-zolstock-inventory-mvs.js
 *
 * After this, "stock in branch X" / "branches with least inventory" /
 * "items below minimum" answer from mv_inventory_latest instead of scanning
 * ~2.8M raw inventory rows.
 */

require('dotenv').config();
const { createInventoryMVs } = require('./create-zolstock-mvs');

createInventoryMVs()
  .then(() => {
    console.log('Inventory MV(s) built on zolstock.');
    process.exit(0);
  })
  .catch(e => {
    console.error('Failed to build inventory MV(s):', e.message);
    process.exit(1);
  });
