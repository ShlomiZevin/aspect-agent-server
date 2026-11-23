#!/usr/bin/env node
/**
 * Proves the pgvector copy of a KB answers like Pinecone: runs every query in
 * kb-pgvector/queries.json through the SAME search the page uses
 * (kb-pgvector/service.js), 3 times each, and records overlap + latency.
 * Writes verification/pgvector-poc/results.json. Read-only everywhere (a few
 * tiny embedding calls).
 *
 *   node kb-pgvector/verify.js --env staging [--topK 10] [--runs 3]
 *
 * Runs on this machine against the named environment's database (Cloud SQL
 * public IP) and its Pinecone index — never the local .env (Origin). Latency
 * is therefore laptop → Tel Aviv / laptop → us-east-1, not Cloud Run's.
 *
 * Ground truth, outside the page's path: with ONE query vector, the exact top K
 * (brute-force cosine in float64 over the stored vectors) against Pinecone,
 * pgvector as the planner runs it (for one KB it reads that KB's rows by the
 * primary key and sorts them — exact), and pgvector walking the HNSW index
 * (the approximate path a large KB takes), to prove that one is right too.
 */
const path = require('path');
const fs = require('fs');
const { ENVIRONMENTS } = require('../builder/environments');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'verification', 'pgvector-poc');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
function fail(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

const env = ENVIRONMENTS.find(e => e.id === opt('--env'));
if (!env || !env.db) fail(`usage: verify.js --env <${ENVIRONMENTS.filter(e => e.db).map(e => e.id).join('|')}>`);
if (env.frozen) fail(`${env.name} is frozen — not this script's target`);
const TOP_K = Number(opt('--topK', 10));
const RUNS = Number(opt('--runs', 3));

// Point this process at the environment BEFORE the services load.
const e = Object.fromEntries(fs.readFileSync(path.join(ROOT, env.db.credentialsFrom), 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
Object.assign(process.env, {
  DB_HOST: env.db.host, DB_PORT: '5432', DB_SSL: 'true', DB_NAME: e.DB_NAME, DB_USER: e.DB_USER, DB_PASSWORD: e.DB_PASSWORD,
  DB_POOL_MIN: '1', DB_POOL_MAX: '2',
  OPENAI_API_KEY: e.OPENAI_API_KEY, PINECONE_API_KEY: e.PINECONE_API_KEY, PINECONE_INDEX_NAME: e.PINECONE_INDEX_NAME,
});
delete process.env.OPENAI_ORG_ID;

const db = require('../services/db.pg');
const embeddingService = require('../services/kb.embedding.service');
const kbService = require('../services/kb.pinecone.service');
const poc = require('./service');

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = xs => { const s = [...xs].sort((a, b) => a - b); return { p50: median(s), p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)], min: s[0], max: s[s.length - 1] }; };
const keyOf = (fileId, chunkIndex) => `${fileId == null ? 0 : Number(fileId)}:${chunkIndex ?? 0}`;
const same = (a, b) => a.filter(k => b.includes(k)).length;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SEARCH_SQL = `SELECT file_id, chunk_index, 1 - (embedding <=> $1::vector) AS score FROM kb_vectors
                     WHERE index_name = $2 AND namespace = $3 ORDER BY embedding <=> $1::vector LIMIT $4`;
const HNSW_SQL = `SELECT file_id, chunk_index, 1 - (embedding <=> $1::vector) AS score FROM kb_vectors
                   ORDER BY embedding <=> $1::vector LIMIT $2`;
const usesHnsw = plan => plan.some(p => /kb_vectors_embedding_hnsw/.test(p['QUERY PLAN']));

/** One vector → exact, Pinecone, pgvector (planner), pgvector (HNSW forced). */
async function groundTruth(query, info, stored) {
  const { embedding } = await embeddingService.embedQuery(query, { namespace: info.namespace });
  const nq = Math.hypot(...embedding);
  const exact = stored
    .map(s => ({ key: s.key, score: embedding.reduce((acc, x, i) => acc + x * s.v[i], 0) / (nq * s.norm) }))
    .sort((a, b) => b.score - a.score).slice(0, TOP_K);
  const exactKeys = exact.map(x => x.key);
  const exactScore = new Map(stored.map(s => [s.key, embedding.reduce((acc, x, i) => acc + x * s.v[i], 0) / (nq * s.norm)]));

  const pc = await kbService.query([info.namespace], query, { topK: TOP_K, scoreThreshold: -Infinity, maxTokens: Infinity, embedding });
  const pcList = pc.results.map(r => ({ key: keyOf(r.fileId, r.chunkIndex), score: r.score }));

  const params = [`[${embedding.join(',')}]`, info.index, info.namespace, TOP_K];
  const pgList = (await db.query(SEARCH_SQL, params)).rows.map(r => ({ key: keyOf(r.file_id, r.chunk_index), score: Number(r.score) }));

  // HNSW forced: with the per-KB filter the planner reads the KB's rows through
  // the primary key and sorts them (exact). Without the filter it walks the HNSW
  // index — equivalent here because the table holds only this KB (checked in main).
  // (On 86 rows even that prefers a scan + sort, hence enable_seqscan off.)
  const hnswParams = [params[0], TOP_K];
  const client = await db.getClient();
  let hnswPlan, hnswList;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    hnswPlan = (await client.query(`EXPLAIN ${HNSW_SQL}`, hnswParams)).rows;
    hnswList = (await client.query(HNSW_SQL, hnswParams)).rows.map(r => ({ key: keyOf(r.file_id, r.chunk_index), score: Number(r.score) }));
    await client.query('COMMIT');
  } finally { client.release(); }

  const side = list => ({
    sameAsExact: same(list.map(x => x.key), exactKeys),
    identicalToExact: eq(list.map(x => x.key), exactKeys),
    maxScoreError: Number(Math.max(...list.map(x => Math.abs(x.score - exactScore.get(x.key)))).toExponential(1)),
  });
  return { pinecone: side(pcList), pgvector: side(pgList), pgvectorHnswForced: { ...side(hnswList), usesHnsw: usesHnsw(hnswPlan) } };
}

(async () => {
  const { agent, queries } = JSON.parse(fs.readFileSync(path.join(__dirname, 'queries.json'), 'utf8'));
  await db.initialize();
  const info = await poc.info(agent);
  console.log(`${env.name} · ${agent} · ${info.index}/${info.namespace}: ${info.chunks} chunks in pgvector, ${info.pineconeChunks} in Pinecone · ${info.embeddingModel}`);

  const { rows: storedRows } = await db.query(
    `SELECT file_id, chunk_index, embedding::text AS v FROM kb_vectors WHERE index_name = $1 AND namespace = $2`, [info.index, info.namespace]);
  const { rows: [{ n: tableRows }] } = await db.query('SELECT count(*)::int AS n FROM kb_vectors');
  if (tableRows !== storedRows.length) fail(`kb_vectors holds other KBs too (${tableRows} rows vs ${storedRows.length}) — the HNSW-forced check needs a filtered index walk`);
  const stored = storedRows.map(r => { const v = JSON.parse(r.v); return { key: keyOf(r.file_id, r.chunk_index), v, norm: Math.hypot(...v) }; });

  // The planner's own choice for the page's query.
  const { embedding } = await embeddingService.embedQuery(queries[0].q, { namespace: info.namespace });
  const plannerUsesHnsw = usesHnsw((await db.query(`EXPLAIN ${SEARCH_SQL}`, [`[${embedding.join(',')}]`, info.index, info.namespace, TOP_K])).rows);

  await poc.search(agent, { query: 'warm-up', topK: TOP_K }); // connections + TLS, not measured

  const rows = [];
  for (const { q, lang, source } of queries) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await poc.search(agent, { query: q, topK: TOP_K }));
    const first = runs[0];
    const keys = side => runs.map(r => JSON.stringify(r[side].results.map(x => x.key)));
    const truth = await groundTruth(q, info, stored);
    const r = {
      query: q, lang, source, topK: TOP_K,
      overlap: first.overlap.same, of: first.overlap.of, sameOrder: first.overlap.sameOrder,
      maxScoreDiff: Number(first.overlap.maxScoreDiff.toExponential(1)),
      stableAcrossRuns: { pinecone: new Set(keys('pinecone')).size === 1, pgvector: new Set(keys('pgvector')).size === 1 },
      vsExact: truth,
      pineconeMs: runs.map(x => x.pinecone.ms), pgvectorMs: runs.map(x => x.pgvector.ms), embedMs: runs.map(x => x.embedMs),
      pineconeMsMedian: median(runs.map(x => x.pinecone.ms)), pgvectorMsMedian: median(runs.map(x => x.pgvector.ms)),
      top3: first.pgvector.results.slice(0, 3).map(x => `${x.fileName}#${x.chunkIndex} (${x.score.toFixed(3)})`),
    };
    rows.push(r);
    console.log(`${r.overlap}/${r.of}${r.sameOrder ? ' same order' : '           '} · exact: pc ${truth.pinecone.sameAsExact} pg ${truth.pgvector.sameAsExact} hnsw ${truth.pgvectorHnswForced.sameAsExact} · Pinecone ${r.pineconeMsMedian} ms · pgvector ${r.pgvectorMsMedian} ms · [${lang}] ${q.slice(0, 40)}`);
  }

  const total = rows.reduce((s, r) => s + r.of, 0);
  const sumOf = f => rows.reduce((s, r) => s + f(r), 0);
  const exactSide = name => ({
    overlapPct: Math.round(1000 * sumOf(r => r.vsExact[name].sameAsExact) / total) / 10,
    identicalLists: rows.filter(r => r.vsExact[name].identicalToExact).length,
    maxScoreError: Math.max(...rows.map(r => r.vsExact[name].maxScoreError)),
  });
  const summary = {
    queries: rows.length,
    overlapPct: Math.round(1000 * sumOf(r => r.overlap) / total) / 10,
    identicalLists: rows.filter(r => r.sameOrder).length,
    maxScoreDiff: Math.max(...rows.map(r => r.maxScoreDiff)),
    vsExact: { pinecone: exactSide('pinecone'), pgvector: exactSide('pgvector'), pgvectorHnswForced: exactSide('pgvectorHnswForced') },
    pineconeMs: pct(rows.flatMap(r => r.pineconeMs)),
    pgvectorMs: pct(rows.flatMap(r => r.pgvectorMs)),
    embedMs: pct(rows.flatMap(r => r.embedMs)),
    plannerUsesHnsw,
  };
  const out = {
    ranAt: new Date().toISOString(), environment: env.id, from: 'local machine (Israel) → Cloud SQL me-west1 / Pinecone aws us-east-1',
    agent, index: info.index, namespace: info.namespace, chunks: info.chunks, pineconeChunks: info.pineconeChunks,
    embeddingModel: info.embeddingModel, topK: TOP_K, runsPerQuery: RUNS, summary, results: rows,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('\nSUMMARY', JSON.stringify(summary, null, 1));
  await db.close();
})().catch(err => { console.error(err); process.exit(1); });
