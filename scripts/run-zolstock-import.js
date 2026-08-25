/**
 * Manual ZolStock import runner.
 *
 * Drives the same two-phase pipeline the admin Data Loader UI uses:
 *   Phase 1  COPY the delivered CSVs into zolstock_new
 *   Phase 2  derived record_type column → indexes → materialized views
 *   Swap     atomic zolstock_new → zolstock (live is untouched until this point)
 *
 * Exists because the production runbook says a human runs this from the admin
 * UI, which is not available locally. It adds nothing of its own beyond
 * progress reporting — the work is DataReloadService's.
 *
 * Run: node scripts/run-zolstock-import.js
 */

require('dotenv').config();
const db = require('../services/db.pg');
const DataReloadService = require('../services/data-reload.service');

const SCHEMA = 'zolstock';
const POLL_MS = 15000;

(async () => {
  await db.initialize();

  const drs = new DataReloadService(db);
  require('../agents/zolstock/data-reload').register(drs);

  const before = await drs.getDataInfo(SCHEMA).catch(() => null);
  console.log(`\n=== ZolStock import ===`);
  console.log(`data currently through: ${before || '(unknown)'}\n`);

  const runId = await drs.startReload(SCHEMA, 'manual');
  console.log(`run ${runId} started\n`);

  const t0 = Date.now();
  let lastLine = '';
  let idleTicks = 0;

  for (;;) {
    await new Promise(r => setTimeout(r, POLL_MS));

    const st = await drs.getStatus(SCHEMA).catch(e => ({ status: 'error', error: e.message }));
    const logs = drs.logBuffers?.[SCHEMA] || [];
    const tail = logs.length ? logs[logs.length - 1] : null;
    const line = tail ? (typeof tail === 'string' ? tail : `${tail.step || ''} ${tail.message || ''}`) : '';

    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    if (line && line !== lastLine) {
      console.log(`[${mins}m] ${String(line).slice(0, 150)}`);
      lastLine = line;
      idleTicks = 0;
    } else {
      idleTicks++;
      // Long COPY and MV builds emit nothing for minutes at a time; a periodic
      // heartbeat distinguishes "still working" from "wedged".
      if (idleTicks % 8 === 0) {
        console.log(`[${mins}m] ...still running (${st.phase || '?'} / ${st.step || '?'}, ${st.totalRows || 0} rows)`);
      }
    }

    if (st.status === 'completed' && st.phase !== 'import') break;
    if (st.status === 'failed' || st.status === 'error') {
      console.error(`\nFAILED: ${st.error || st.errorMessage || 'unknown error'}`);
      process.exit(1);
    }
    // The import phase completing only means the shadow is loaded — indexing is
    // chained after it, so keep waiting until the indexing run reports done.
  }

  const after = await drs.getDataInfo(SCHEMA).catch(() => null);
  console.log(`\n=== done in ${((Date.now() - t0) / 60000).toFixed(1)} min ===`);
  console.log(`data now through: ${after || '(unknown)'}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
