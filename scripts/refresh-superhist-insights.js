/**
 * One-off: force-regenerate הסופר החברתי's shared "Suggested reports" set now,
 * so the customer sees Hebrew reports immediately instead of waiting for the
 * nightly scheduler tick.
 *
 * migration 051 already rewrote the stored bootstrapPrompts to Hebrew; this
 * runs ensureInsightsRefreshed({ force, onlyDataset }) which calls bootstrap()
 * with those prompts and, on success, replaces the previous (English) set —
 * the exact operation the nightly tick would eventually do.
 *
 * Needs the Cloud SQL proxies up (5432 platform, 5433 customer data) and the
 * LLM keys in .env. Takes a few minutes (4 real plan/query/synthesize/verify
 * investigations, run sequentially).
 *
 *   node scripts/refresh-superhist-insights.js
 */
require('dotenv').config();
const db = require('./../services/db.pg');
const insightsRefresh = require('./../insights/services/insights-refresh.service');

(async () => {
  await db.initialize();
  console.log('Forcing insights refresh for superhist...');
  const done = await insightsRefresh.ensureInsightsRefreshed({ force: true, onlyDataset: 'superhist' });
  console.log('Done. Regenerated datasets:', done);
  process.exit(0);
})().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
