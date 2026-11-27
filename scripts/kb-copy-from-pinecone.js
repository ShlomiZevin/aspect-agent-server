#!/usr/bin/env node
/**
 * ONE-TIME move of an environment's knowledge bases from Pinecone into its
 * own database (kb_vectors, pgvector) — board #1014. The only code in the
 * repo that still talks to Pinecone; the server never does.
 *
 *   node scripts/kb-copy-from-pinecone.js --env staging --dry      what would move (counts only)
 *   node scripts/kb-copy-from-pinecone.js --env staging            move every KB the environment uses
 *   node scripts/kb-copy-from-pinecone.js --env staging --namespace account-opening-kb [--namespace …]
 *
 * Which KBs: by default every namespace the environment REFERENCES — linked
 * to an agent (kb_links), recorded as files (library_files), or named by a
 * KB Retriever in any agent / crew version — plus `hq` when this
 * environment's Lybi HQ has atoms. Pinecone's index was shared by every
 * environment, so KBs only another environment uses are left out.
 *
 * Per KB, in ONE transaction: every vector is copied AS IT IS (same id, same
 * embedding, its metadata; nothing re-embedded), rows Pinecone no longer has
 * are removed — re-running refreshes the copy to equal the source. Then:
 *   - count check: kb_vectors rows = Pinecone's ids;
 *   - a sample of vectors is bit-for-bit the same;
 *   - a search spot check: one stored chunk's own text is embedded ONCE and
 *     searched in both stores (top 5) — same hits expected;
 *   - file records: a file that has chunks but no library_files row (it was
 *     uploaded in another environment) gets one, derived from its chunks, so
 *     the KB screen and the MCP list it; a record whose file has no chunks
 *     is reported (not deleted).
 *
 * The environment is resolved from builder/environments.js (Cloud SQL public
 * IP + the env file with the DB credentials, the Pinecone key and index
 * name, the OpenAI key for the spot check) — never the local .env (Origin).
 * Frozen environments are refused. Needs migration 075 there first.
 * Prints no secrets.
 */
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { ENVIRONMENTS } = require('../builder/environments');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const opts = k => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]] : []));
const DRY = args.includes('--dry');
function fail(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

const env = ENVIRONMENTS.find(e => e.id === opt('--env'));
if (!env) fail(`usage: kb-copy-from-pinecone.js --env <${ENVIRONMENTS.map(e => e.id).join('|')}> [--namespace <ns> …] [--index <name>] [--dry]`);
if (env.frozen) fail(`${env.name} is frozen — nothing is written there`);
if (!env.db) fail(`no database entry for ${env.id} in builder/environments.js`);
const credFile = path.join(ROOT, env.db.credentialsFrom);
if (!fs.existsSync(credFile)) fail(`missing ${env.db.credentialsFrom}`);
const e = Object.fromEntries(fs.readFileSync(credFile, 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const indexName = opt('--index') || e.PINECONE_INDEX_NAME;
if (!e.PINECONE_API_KEY || !indexName) fail(`no PINECONE_API_KEY / PINECONE_INDEX_NAME in ${env.db.credentialsFrom}`);
// The spot check embeds with THIS environment's OpenAI key (the store module reads it lazily).
process.env.OPENAI_API_KEY = e.OPENAI_API_KEY || '';

let Pinecone;
try {
  ({ Pinecone } = require('@pinecone-database/pinecone'));
} catch {
  fail('the Pinecone SDK is not installed — it is a devDependency now: run `npm install` (without --only=production)');
}
const embeddingService = require('../services/kb.embedding.service');
const vectorStore = require('../services/kb.vectorStore.service');

const DIM = vectorStore.DIMENSIONS;
const FETCH_BATCH = 100;
const modelOf = ns => (embeddingService.isLegacyNamespace(ns) ? embeddingService.LEGACY_MODEL : embeddingService.EMBEDDING_MODEL);

/** Pinecone metadata → a kb_vectors row (what the store's indexFile writes). */
function toRow(ns, r) {
  const m = { ...(r.metadata || {}) };
  const text = String(m.text || m.chunkText || '');
  const row = {
    namespace: ns,
    id: r.id,
    embeddingModel: modelOf(ns),
    embedding: r.values,
    text,
    fileName: m.fileName || m.source || m.sourceArticle || null,
    fileId: m.fileId == null ? null : String(m.fileId),
    chunkIndex: Number.isFinite(Number(m.chunkIndex)) ? Number(m.chunkIndex) : null,
  };
  for (const k of ['text', 'chunkText', 'namespace', 'fileId', 'fileName', 'chunkIndex']) delete m[k];
  row.metadata = m;
  return row;
}

(async () => {
  const pc = new Pinecone({ apiKey: e.PINECONE_API_KEY });
  const described = await pc.describeIndex(indexName);
  if (described.dimension !== DIM) fail(`index ${indexName} is ${described.dimension}d; kb_vectors is ${DIM}d`);
  if (described.metric !== 'cosine') fail(`index ${indexName} uses ${described.metric}; the store searches by cosine`);
  const index = pc.index(indexName);
  const stats = await index.describeIndexStats();
  const inPinecone = new Map(Object.entries(stats.namespaces || {}).map(([k, v]) => [k, v.recordCount || 0]));

  const pool = new Pool({ host: env.db.host, port: 5432, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 15000 });
  const rows = (sql, p) => pool.query(sql, p).then(r => r.rows);
  try {
    await rows('SELECT 1 FROM kb_vectors LIMIT 1');
  } catch (err) {
    await pool.end();
    fail(`${env.name} has no kb_vectors table — run db/migrations/run-075-kb-vectors-store.js --env ${env.id} first (${err.message})`);
  }

  // ── Which KBs ──
  let wanted = opts('--namespace');
  if (!wanted.length) {
    const used = new Set();
    for (const r of await rows('SELECT DISTINCT namespace FROM kb_links UNION SELECT DISTINCT namespace FROM library_files')) used.add(r.namespace);
    const bodies = await rows(`SELECT body::text AS b FROM builder_agent_versions WHERE body::text LIKE '%kbNamespaces%'
      UNION ALL SELECT body::text FROM builder_crew_versions WHERE body::text LIKE '%kbNamespaces%'`);
    for (const { b } of bodies) {
      for (const m of b.matchAll(/"kbNamespaces"\s*:\s*\[([^\]]*)\]/g)) {
        for (const s of m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) used.add(JSON.parse(`"${s[1]}"`));
      }
    }
    const hq = await rows('SELECT count(*)::int n FROM hq_atoms').catch(() => [{ n: 0 }]);
    if (hq[0].n > 0) used.add('hq');
    wanted = [...used].sort();
  }
  const absent = wanted.filter(ns => !inPinecone.get(ns));
  const todo = wanted.filter(ns => inPinecone.get(ns));
  const have = new Map((await rows('SELECT namespace, count(*)::int n FROM kb_vectors GROUP BY namespace')).map(r => [r.namespace, r.n]));

  console.log(`${env.name} ← Pinecone ${indexName}: ${todo.length} KB(s) to copy${absent.length ? `; referenced but not in Pinecone (nothing to copy): ${absent.join(', ')}` : ''}`);
  for (const ns of todo) console.log(`  ${ns.padEnd(36)} Pinecone ${String(inPinecone.get(ns)).padStart(6)}   in ${env.id} now ${String(have.get(ns) || 0).padStart(6)}`);
  const skipped = [...inPinecone.keys()].filter(ns => !wanted.includes(ns));
  if (skipped.length) console.log(`  not used here (left in Pinecone): ${skipped.join(', ')}`);
  if (DRY) { await pool.end(); return; }

  const summary = [];
  for (const ns of todo) {
    const pns = index.namespace(ns === '__default__' ? '' : ns);
    // 1. Every id.
    const ids = [];
    let token;
    do {
      const page = await pns.listPaginated({ limit: 100, ...(token ? { paginationToken: token } : {}) });
      for (const v of page.vectors || []) ids.push(v.id);
      token = page.pagination?.next;
    } while (token);
    // 2. Values + metadata.
    const records = [];
    for (let i = 0; i < ids.length; i += FETCH_BATCH) {
      const res = await pns.fetch({ ids: ids.slice(i, i + FETCH_BATCH) });
      for (const r of Object.values(res.records || {})) {
        if (r.sparseValues && r.sparseValues.indices?.length) fail(`${ns}/${r.id} has sparse values — the store is dense-only`);
        if (!r.values || r.values.length !== DIM) fail(`${ns}/${r.id} has ${r.values?.length} dims`);
        records.push(r);
      }
    }
    if (records.length !== ids.length) fail(`${ns}: fetched ${records.length} of ${ids.length}`);

    // 3. Write — one transaction: upsert all, remove what Pinecone no longer has.
    const client = await pool.connect();
    let removed;
    try {
      await client.query('BEGIN');
      await vectorStore.insertVectors(client, records.map(r => toRow(ns, r)), { onConflict: 'replace' });
      removed = (await client.query('DELETE FROM kb_vectors WHERE namespace = $1 AND NOT (id = ANY($2::text[]))', [ns, ids])).rowCount;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      fail(`${ns}: ${err.message} (rolled back)`);
    }
    client.release();

    // 4. Checks.
    const [c] = await rows('SELECT count(*)::int n FROM kb_vectors WHERE namespace = $1', [ns]);
    if (c.n !== ids.length) fail(`${ns}: kb_vectors has ${c.n} rows, Pinecone ${ids.length}`);
    const sample = records.filter((_, i) => i % Math.max(1, Math.floor(records.length / 10)) === 0);
    const back = new Map((await rows('SELECT id, embedding::text v FROM kb_vectors WHERE namespace = $1 AND id = ANY($2::text[])',
      [ns, sample.map(r => r.id)])).map(r => [r.id, JSON.parse(r.v)]));
    let maxDiff = 0;
    for (const r of sample) {
      const v = back.get(r.id);
      for (let i = 0; i < DIM; i++) maxDiff = Math.max(maxDiff, Math.abs(v[i] - r.values[i]));
    }
    if (maxDiff > 1e-6) fail(`${ns}: sampled vectors differ (max |Δ| ${maxDiff})`);

    // Search spot check — one query vector, both stores.
    let spot = 'skipped (no OpenAI key)';
    const probe = records.map(r => toRow(ns, r)).find(r => r.text.length > 40);
    if (probe && process.env.OPENAI_API_KEY) {
      const { embedding } = await embeddingService.embedQuery(probe.text.slice(0, 400), { namespace: ns });
      const pcHits = (await pns.query({ vector: embedding, topK: 5, includeMetadata: false })).matches.map(m => m.id);
      const pgHits = (await rows(`SELECT id FROM kb_vectors WHERE namespace = $1 AND embedding_model = $2
        ORDER BY embedding <=> $3::vector LIMIT 5`, [ns, modelOf(ns), `[${embedding.join(',')}]`])).map(r => r.id);
      const same = pcHits.filter(id => pgHits.includes(id)).length;
      spot = `top-5 overlap ${same}/${Math.max(pcHits.length, pgHits.length)}, rank 1 ${pcHits[0] === pgHits[0] ? 'same' : `differs (${pcHits[0]} vs ${pgHits[0]})`}`;
    }

    // File records (agent KBs only — HQ's chunks are atoms, not library files).
    let added = 0;
    let orphanRecords = [];
    if (ns !== 'hq') {
      const files = await rows(`SELECT file_id, min(file_name) AS file_name, count(*)::int AS chunks, min(metadata->>'fileType') AS file_type
        FROM kb_vectors WHERE namespace = $1 AND file_id IS NOT NULL GROUP BY file_id`, [ns]);
      const recs = await rows('SELECT file_id FROM library_files WHERE index_name = $1 AND namespace = $2', [vectorStore.KB_LIBRARY, ns]);
      const recorded = new Set(recs.map(r => r.file_id));
      for (const f of files.filter(f => !recorded.has(f.file_id))) {
        await rows(`INSERT INTO library_files (index_name, namespace, file_id, file_name, file_type, chunk_count, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'completed')`,
          [vectorStore.KB_LIBRARY, ns, f.file_id, f.file_name || `file ${f.file_id}`, f.file_type || (f.file_name || '').split('.').pop() || null, f.chunks]);
        added++;
      }
      const withChunks = new Set(files.map(f => f.file_id));
      orphanRecords = recs.filter(r => !withChunks.has(r.file_id)).map(r => r.file_id);
    }

    summary.push({ ns, pinecone: ids.length, pgvector: c.n });
    console.log(`✅ ${ns}: ${c.n} = Pinecone ${ids.length}${removed ? ` (${removed} stale removed)` : ''}; ${sample.length} sampled vectors identical (max |Δ| ${maxDiff.toExponential(1)}); search ${spot}`
      + `${added ? `; ${added} file record(s) added` : ''}${orphanRecords.length ? `; ⚠ file record(s) with no chunks: ${orphanRecords.join(', ')}` : ''}`);
  }
  await pool.end();
  console.log(`\nDone — ${summary.length} KB(s), ${summary.reduce((s, x) => s + x.pgvector, 0)} vectors in ${env.name}'s kb_vectors, every count equal to Pinecone's.`);
})().catch(err => fail(err.message));
