/**
 * Per-agent profiles for the customer-replay tooling
 * (build-customer-corpus.js, run-customer-replay.js).
 *
 * The tooling was written for ZolStock alone; the same "replay what real
 * customers asked" bar applies to every data agent, so the agent-specific
 * facts live here and both scripts take `--agent <key>`. ZolStock stays the
 * default and keeps its original corpus filename, floor and ghost turns, so
 * every earlier ZolStock run remains comparable.
 *
 * Fields:
 *   agentId / agentName  — the `agents` row the corpus is extracted from and
 *                          the name runChatTurn() resolves the crew by
 *   corpusFile           — under verification/representative-dataset/
 *   floor                — minimum turns a fresh extraction may contain. The
 *                          corpus only grows with real traffic, so a smaller
 *                          one means the extraction broke. Set to the size at
 *                          the time the profile was added.
 *   ghostConversation    — turns served but never persisted (ZolStock only)
 *   salesRecordType      — the record_type value of sales rows, for the log
 *   dataStateSql         — the frozen-data snapshot compared before and after
 *                          a run. ZolStock groups the whole fact table (31M
 *                          rows, seconds). HyperToy/TheStock facts are far
 *                          larger, so they snapshot the last sales date (index
 *                          on record_type, transaction_date) plus the planner's
 *                          row estimate — enough to detect a reload landing
 *                          mid-run, which is what the snapshot is for.
 */

const ZOLSTOCK_GHOST = {
  // Conversation 3187 (2026-08-20 18:29–18:31 IL, user anon_1787049528388_vnggm0set).
  // Text reconstructed from slow_queries data-fetch questions — the user's exact
  // wording is unrecoverable (the persistence bug Stage 2 Step 5 fixed).
  origConv: 3187,
  user: 'anon_1787049528388_vnggm0set',
  mode: 'conversational',
  reconstructed: true,
  turns: [
    { mid: 'ghost-1', t: '2026-08-20 18:29', reconstructed: true,
      text: '10 המוצרים המובילים בשנת 2026 לפי הכנסה, כולל כמות שנמכרה, הכנסה, רווח ושיעור רווח' },
    { mid: 'ghost-2', t: '2026-08-20 18:30', reconstructed: true,
      text: 'טופ 10 מוצרים בשנת 2026 לפי הכנסות, כולל רווח, שיעור רווח, כמות שנמכרה ושם הספק' },
  ],
};

/** Snapshot SQL for the Qlik-export datasets that carry a source record_type. */
function lastSalesSnapshot(schema) {
  return `
    SELECT record_type,
           (SELECT reltuples::bigint FROM pg_class WHERE oid = '${schema}.facts'::regclass) AS rows,
           MAX(transaction_date) AS max_date
      FROM ${schema}.facts
     WHERE record_type = 'מכירות'
     GROUP BY record_type`;
}

const PROFILES = {
  zolstock: {
    agentId: 22,
    agentName: 'ZolStock',
    corpusFile: 'customer-corpus.json',
    floor: 74, // the frozen Stage-2/3 corpus (72 logged + 2 ghost, 2026-08-21)
    ghostConversation: ZOLSTOCK_GHOST,
    salesRecordType: 'sales',
    dataStateSql: `
      SELECT record_type, count(*)::bigint AS rows, max(row_date) AS max_date
        FROM zolstock.facts GROUP BY record_type ORDER BY record_type`,
  },
  hypertoy: {
    agentId: 13,
    agentName: 'HyperToy',
    corpusFile: 'customer-corpus-hypertoy.json',
    floor: 173, // 2026-09-25: 173 questions, 79 conversations, 33 users
    ghostConversation: null,
    salesRecordType: 'מכירות',
    dataStateSql: lastSalesSnapshot('hypertoy'),
  },
  thestock: {
    agentId: 12,
    agentName: 'TheStock',
    corpusFile: 'customer-corpus-thestock.json',
    floor: 48, // 2026-09-25: 48 questions, 10 conversations, 8 users
    ghostConversation: null,
    salesRecordType: 'מכירות',
    dataStateSql: lastSalesSnapshot('thestock'),
  },
};

/** Reads `--agent <key>` from argv; ZolStock when absent. */
function profileFromArgv(argv) {
  const ix = argv.indexOf('--agent');
  const key = ix > -1 ? String(argv[ix + 1] || '').toLowerCase() : 'zolstock';
  const profile = PROFILES[key];
  if (!profile) {
    throw new Error(`Unknown --agent '${key}'. Known: ${Object.keys(PROFILES).join(', ')}`);
  }
  return { key, ...profile };
}

module.exports = { PROFILES, profileFromArgv };
