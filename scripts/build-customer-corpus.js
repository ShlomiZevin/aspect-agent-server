/**
 * Build the frozen ZolStock customer-replay corpus (Stage 2, Step 0).
 *
 * Extracts every REAL customer question ever asked of the ZolStock chat agent:
 * user messages in conversations belonging to `anon_%` users (real browser
 * sessions). Everything else — null-user scripted runs, test-user-*,
 * prod-verify-*, final-check-*, QA batteries, bootstrap prompts — is excluded
 * by construction, and the script asserts that exclusion rather than trusting
 * it.
 *
 * Adds the two "ghost" turns of 2026-08-20 (conversation 3187: served and
 * billed in llm_usage/slow_queries but never written to `messages` — see
 * tasks/pending/zolstock-and-other-accuracy-improvements-stage-2.md), with the
 * data-fetch question text as the best available reconstruction, marked
 * `reconstructed: true`.
 *
 * Output: verification/representative-dataset/customer-corpus.json
 *   { meta, conversations: [ { origConv, user, mode, turns: [ {mid, t, text} ] } ] }
 *
 * mode: 'conversational' when the original conversation had >1 user turn
 * (follow-ups like "אז מאי 2026" only make sense replayed in order inside the
 * same conversation), else 'standalone'. The replay runner treats both the
 * same way — a fresh conversation replayed turn-by-turn — the mode is
 * analytical metadata.
 *
 * Usage: node scripts/build-customer-corpus.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../services/db.pg');

const AGENT_ID = 22; // ZolStock
const OUT_DIR = path.join(__dirname, '..', 'verification', 'representative-dataset');
const OUT_FILE = path.join(OUT_DIR, 'customer-corpus.json');

// Conversation 3187 (2026-08-20 18:29–18:31 IL, user anon_1787049528388_vnggm0set).
// Text reconstructed from slow_queries data-fetch questions — the user's exact
// wording is unrecoverable (the persistence bug this stage's Step 5 fixes).
const GHOST_CONVERSATION = {
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

async function main() {
  await db.initialize();

  const IL = "(m.created_at at time zone 'UTC' at time zone 'Asia/Jerusalem')";
  const { rows } = await db.query(`
    SELECT m.id AS mid, c.id AS conv, u.external_id AS uid,
           to_char(${IL}, 'YYYY-MM-DD HH24:MI') AS t, m.content
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = c.user_id
    WHERE c.agent_id = $1 AND m.role = 'user' AND u.external_id LIKE 'anon_%'
    ORDER BY m.id`, [AGENT_ID]);

  // ── Purity asserts: the corpus must contain customers only ──────────────
  const banned = /^(test-user|prod-verify|final-check|system$)/;
  for (const r of rows) {
    if (banned.test(r.uid)) throw new Error(`Corpus polluted by test user: ${r.uid}`);
    if (!r.uid.startsWith('anon_')) throw new Error(`Non-anon user leaked in: ${r.uid}`);
  }
  // Cross-check: no null-user conversation can appear (JOIN users is INNER).
  const { rows: [nullCheck] } = await db.query(`
    SELECT count(*)::int AS n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.agent_id = $1 AND m.role = 'user' AND c.user_id IS NULL`, [AGENT_ID]);
  console.log(`(context) null-user scripted turns excluded: ${nullCheck.n}`);

  // ── Group into conversation replay units ────────────────────────────────
  const byConv = new Map();
  for (const r of rows) {
    if (!byConv.has(r.conv)) byConv.set(r.conv, { origConv: r.conv, user: r.uid, turns: [] });
    byConv.get(r.conv).turns.push({ mid: r.mid, t: r.t, text: r.content });
  }
  const conversations = [...byConv.values()].map(c => ({
    ...c, mode: c.turns.length > 1 ? 'conversational' : 'standalone',
  }));
  conversations.push(GHOST_CONVERSATION);
  conversations.sort((a, b) => String(a.turns[0].t).localeCompare(String(b.turns[0].t)));

  const totalTurns = conversations.reduce((n, c) => n + c.turns.length, 0);
  if (totalTurns !== 74) {
    throw new Error(`Expected 74 turns (72 logged + 2 ghost), got ${totalTurns} — investigate before freezing.`);
  }

  const meta = {
    builtAt: new Date().toISOString(),
    agentId: AGENT_ID,
    agentName: 'ZolStock',
    totalTurns,
    loggedTurns: rows.length,
    reconstructedTurns: GHOST_CONVERSATION.turns.length,
    conversations: conversations.length,
    users: [...new Set(conversations.map(c => c.user))].length,
    source: "messages ⋈ conversations ⋈ users WHERE agent_id=22 AND role='user' AND external_id LIKE 'anon_%' — plus conversation 3187 reconstructed from slow_queries",
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ meta, conversations }, null, 1));
  console.log(`✅ Corpus frozen: ${meta.totalTurns} turns, ${meta.conversations} conversations, ${meta.users} users`);
  console.log(`   → ${OUT_FILE}`);
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
