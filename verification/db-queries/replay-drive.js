// #914 proof driver: plays the real account-opening conversations (real-convs.json)
// through the local harness server, then snapshots what the customer saw and what
// was stored. Usage: node replay-drive.js <out.json> [port] [maxTurns]
const fs = require('fs');
const path = require('path');
const SERVER = 'C:/workspace/aspect/aspect-agent-server';
const { Pool } = require(SERVER + '/node_modules/pg');
const OUT = process.argv[2];
const PORT = process.argv[3] || '3100';
const MAX_TURNS = Number(process.argv[4] || 10);
const RUN = process.env.RUN_TAG || 'run';
const BASE = `http://localhost:${PORT}/api/agents/account-opening`;
const e = Object.fromEntries(fs.readFileSync(SERVER + '/.env.production.staging', 'utf8').split(/\r?\n/).filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const pool = new Pool({ host: '34.165.76.81', database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD, ssl: { rejectUnauthorized: false }, max: 2 });
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// Run-specific values (ids, times, durations) are dropped so two runs compare on substance.
const DROP = /^(t|ts|at|ms|totalMs|durationMs|firstTokenMs|latencyMs|elapsedMs|startedAt|endedAt|ranAt|createdAt|updatedAt|messageId|conversationId|userMessageId|assistantMessageId|id|runId|watermark|lastTransitionMessageId|usage|inputTokens|outputTokens|cost|costUsd)$/;
const norm = v => JSON.parse(JSON.stringify(v, (k, x) => (DROP.test(k) ? undefined : x)));

(async () => {
  const convs = JSON.parse(fs.readFileSync(path.join(__dirname, 'conversations.json'), 'utf8'));
  const result = { conversations: [] };
  for (const src of convs) {
    const ownerUserId = `replay914-${src.id}`;
    const c = await (await post('/conversations', { ownerUserId, source: 'live' })).json();
    const conv = { source: src.id, conversationId: c.conversationId, turns: [] };
    for (const text of src.msgs.slice(0, MAX_TURNS)) {
      const start = Date.now();
      const res = await post(`/conversations/${c.conversationId}/messages`, { ownerUserId, userMessage: text, version: 'published' });
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) buf += dec.decode(chunk, { stream: true });
      const events = buf.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)));
      const end = Date.now();
      conv.turns.push({ text, start, end, ms: end - start, events: norm(events.filter(ev => ev.type !== 'addon.token')), tokens: events.filter(ev => ev.type === 'addon.token').map(ev => ev.token).join('') });
      await new Promise(r => setTimeout(r, 1200)); // let fire-and-forget writes land before the next turn
    }
    const id = c.conversationId;
    conv.db = {
      conversation: norm((await pool.query('select metadata, kind from conversations where id=$1', [id])).rows[0] || {}),
      messages: (await pool.query('select role, content from messages where conversation_id=$1 order by id', [id])).rows,
      memory: norm((await pool.query('select namespace, data from context_data where conversation_id=$1 order by namespace', [id])).rows),
      addonRuns: norm((await pool.query('select instance_id, plugin_id, status, run_data from addon_runs where conversation_id=$1 order by message_id, instance_id, started_at', [id])).rows),
    };
    result.conversations.push(conv);
    console.log(`conv ${src.id} → ${id}: ${conv.turns.map(t => t.ms).join(',')}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });
