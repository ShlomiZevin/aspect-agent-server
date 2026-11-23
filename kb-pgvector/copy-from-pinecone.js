#!/usr/bin/env node
/**
 * Copy one knowledge base (a Pinecone namespace) into pgvector — kb_vectors —
 * in an environment's own Postgres. Vectors and metadata are copied AS THEY
 * ARE (list + fetch): same ids, same embeddings, nothing re-embedded, so a
 * search on either side is apples to apples. Read-only on Pinecone.
 *
 *   node kb-pgvector/copy-from-pinecone.js --env staging --namespace account-opening-kb [--index lybi]
 *
 * The environment is resolved from builder/environments.js (Cloud SQL public IP
 * + the env file with the DB credentials, the Pinecone key and index name) —
 * never the local .env (Origin). Frozen environments are refused. Needs
 * migration 073 applied there first.
 *
 * Re-running refreshes the copy: rows are upserted, and rows whose vector no
 * longer exists in Pinecone are deleted, so the copy always equals the source.
 * Ends with a check: row count = Pinecone's count, and a sample of vectors are
 * bit-for-bit the same.
 */
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { Pinecone } = require('@pinecone-database/pinecone');
const { ENVIRONMENTS } = require('../builder/environments');
const embeddingService = require('../services/kb.embedding.service');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
function fail(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

const env = ENVIRONMENTS.find(e => e.id === opt('--env'));
const namespace = opt('--namespace');
if (!env || !namespace) fail(`usage: copy-from-pinecone.js --env <${ENVIRONMENTS.map(e => e.id).join('|')}> --namespace <ns> [--index <name>]`);
if (env.frozen) fail(`${env.name} is frozen — nothing is written there`);
if (!env.db) fail(`no database entry for ${env.id} in builder/environments.js`);
const credFile = path.join(ROOT, env.db.credentialsFrom);
if (!fs.existsSync(credFile)) fail(`missing ${env.db.credentialsFrom}`);
const e = Object.fromEntries(fs.readFileSync(credFile, 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const indexName = opt('--index') || e.PINECONE_INDEX_NAME;
if (!e.PINECONE_API_KEY || !indexName) fail(`no PINECONE_API_KEY / PINECONE_INDEX_NAME in ${env.db.credentialsFrom}`);

// The model the runtime embeds this namespace's QUERIES with (kb.embedding.service
// decides per namespace) — recorded on every row so the search side can refuse a
// mismatch instead of silently comparing different vector spaces.
const embeddingModel = embeddingService.isLegacyNamespace(namespace) ? embeddingService.LEGACY_MODEL : embeddingService.EMBEDDING_MODEL;
const DIM = 1536;
const FETCH_BATCH = 100;

const toVec = values => `[${values.join(',')}]`;

(async () => {
  const pc = new Pinecone({ apiKey: e.PINECONE_API_KEY });
  const described = await pc.describeIndex(indexName);
  if (described.dimension !== DIM) fail(`index ${indexName} is ${described.dimension}d; kb_vectors is ${DIM}d`);
  if (described.metric !== 'cosine') fail(`index ${indexName} uses ${described.metric}; kb_vectors' index is cosine`);
  const stats = await pc.index(indexName).describeIndexStats();
  const expected = stats.namespaces?.[namespace]?.recordCount;
  if (!expected) fail(`namespace "${namespace}" is empty or missing in index ${indexName}`);
  const ns = pc.index(indexName).namespace(namespace);

  // 1. List every id.
  const ids = [];
  let token;
  do {
    const page = await ns.listPaginated({ limit: 100, ...(token ? { paginationToken: token } : {}) });
    for (const v of page.vectors || []) ids.push(v.id);
    token = page.pagination?.next;
  } while (token);
  console.log(`Pinecone ${indexName}/${namespace}: ${ids.length} ids listed (stats say ${expected})`);

  // 2. Fetch values + metadata.
  const records = [];
  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const res = await ns.fetch({ ids: ids.slice(i, i + FETCH_BATCH) });
    for (const r of Object.values(res.records || {})) {
      if (r.sparseValues && r.sparseValues.indices?.length) fail(`vector ${r.id} has sparse values — this copy is dense-only`);
      if (!r.values || r.values.length !== DIM) fail(`vector ${r.id} has ${r.values?.length} dims`);
      records.push(r);
    }
  }
  if (records.length !== ids.length) fail(`fetched ${records.length} of ${ids.length}`);

  // 3. Write — one transaction: upsert all, delete what Pinecone no longer has.
  const pool = new Pool({ host: env.db.host, port: 5432, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 15000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      const m = r.metadata || {};
      await client.query(
        `INSERT INTO kb_vectors (index_name, namespace, id, embedding_model, embedding, text, file_name, file_id, chunk_index, metadata, copied_at)
         VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10, NOW() AT TIME ZONE 'UTC')
         ON CONFLICT (index_name, namespace, id) DO UPDATE SET
           embedding_model = EXCLUDED.embedding_model, embedding = EXCLUDED.embedding, text = EXCLUDED.text,
           file_name = EXCLUDED.file_name, file_id = EXCLUDED.file_id, chunk_index = EXCLUDED.chunk_index,
           metadata = EXCLUDED.metadata, copied_at = EXCLUDED.copied_at`,
        [indexName, namespace, r.id, embeddingModel, toVec(r.values),
          String(m.text || m.chunkText || ''), m.fileName || m.source || null,
          Number.isFinite(Number(m.fileId)) ? Number(m.fileId) : null,
          Number.isFinite(Number(m.chunkIndex)) ? Number(m.chunkIndex) : null, m],
      );
    }
    const del = await client.query(
      `DELETE FROM kb_vectors WHERE index_name = $1 AND namespace = $2 AND NOT (id = ANY($3::text[]))`,
      [indexName, namespace, ids],
    );
    await client.query('COMMIT');
    console.log(`kb_vectors: ${records.length} upserted, ${del.rowCount} stale removed`);

    // 4. Check.
    const { rows: [c] } = await client.query(`SELECT count(*)::int n FROM kb_vectors WHERE index_name = $1 AND namespace = $2`, [indexName, namespace]);
    if (c.n !== ids.length) fail(`kb_vectors has ${c.n} rows, Pinecone ${ids.length}`);
    const sample = records.filter((_, i) => i % Math.max(1, Math.floor(records.length / 10)) === 0);
    const { rows } = await client.query(`SELECT id, embedding::text v FROM kb_vectors WHERE index_name = $1 AND namespace = $2 AND id = ANY($3::text[])`, [indexName, namespace, sample.map(r => r.id)]);
    const back = new Map(rows.map(r => [r.id, JSON.parse(r.v)]));
    let maxDiff = 0;
    for (const r of sample) {
      const v = back.get(r.id);
      for (let i = 0; i < DIM; i++) maxDiff = Math.max(maxDiff, Math.abs(v[i] - r.values[i]));
    }
    // float32 on both sides; the text round-trip may differ in the last printed digit only.
    if (maxDiff > 1e-6) fail(`sample vectors differ (max |Δ| ${maxDiff})`);
    console.log(`✅ ${env.name}: ${c.n} vectors of ${indexName}/${namespace} in kb_vectors (model ${embeddingModel}); ${sample.length} sampled vectors identical (max |Δ| ${maxDiff.toExponential(1)})`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(err.message);
  } finally {
    client.release();
    await pool.end();
  }
})().catch(err => fail(err.message));
