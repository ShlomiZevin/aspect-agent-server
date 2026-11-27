#!/usr/bin/env node
/**
 * Battery for the knowledge-base vector store (pgvector, board #1014) —
 * services/kb.vectorStore.service.js, the KB library's file / KB deletes,
 * and the agent copy carrying a KB's chunks.
 *
 *   node scripts/test-kb-vector-store.js --env staging [--api http://localhost:3000]
 *
 * The environment is named explicitly and resolved from builder/environments.js
 * (never the local .env, which points at Origin); frozen environments are
 * refused. Needs migration 075 there. No model calls: vectors are synthetic.
 *
 * Writes ONLY to its own scratch KBs (zz-kb-store-battery*), removed again
 * in a finally. The copy check writes inside a transaction that is rolled
 * back. --api also reads the KB export through a running server's API (the
 * copy door's reader). Run with TZ=UTC like every local process that writes
 * to a shared DB.
 */
const path = require('path');
const fs = require('fs');
const { ENVIRONMENTS } = require('../builder/environments');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
function fatal(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
const env = ENVIRONMENTS.find(e => e.id === opt('--env'));
if (!env) fatal(`usage: test-kb-vector-store.js --env <${ENVIRONMENTS.map(e => e.id).join('|')}> [--api <server url>]`);
if (env.frozen) fatal(`${env.name} is frozen — this battery writes scratch rows`);
const credFile = path.join(__dirname, '..', env.db.credentialsFrom);
const e = Object.fromEntries(fs.readFileSync(credFile, 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
Object.assign(process.env, {
  DB_HOST: env.db.host, DB_PORT: '5432', DB_SSL: 'true', DB_NAME: e.DB_NAME, DB_USER: e.DB_USER, DB_PASSWORD: e.DB_PASSWORD,
  DB_POOL_MIN: '0', DB_POOL_MAX: '3',
});

const db = require('../services/db.pg');
const vs = require('../services/kb.vectorStore.service');
const kbLibrary = require('../services/kbLibrary.service');
const agentCopy = require('../builder/services/agentCopy');

const NS = 'zz-kb-store-battery';
const NS_COPY = 'zz-kb-store-battery-copy';
const DIM = vs.DIMENSIONS;
let fails = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
}
const section = t => console.log(`\n── ${t} ──`);

// Deterministic unit vectors (no model call).
function vec(seed) {
  let x = seed * 9301 + 49297;
  const v = Array.from({ length: DIM }, () => { x = (x * 9301 + 49297) % 233280; return x / 233280 - 0.5; });
  const n = Math.hypot(...v);
  return v.map(a => a / n);
}
const chunks = (n, tag) => Array.from({ length: n }, (_, i) => ({ chunkIndex: i, text: `${tag} chunk ${i} ${'x'.repeat(40)}` }));
const count = async (ns, fileId) => (await db.query(
  `SELECT count(*)::int n FROM kb_vectors WHERE namespace = $1${fileId != null ? ' AND file_id = $2' : ''}`,
  fileId != null ? [ns, String(fileId)] : [ns])).rows[0].n;

async function cleanup() {
  await db.query('DELETE FROM kb_vectors WHERE namespace LIKE $1', ['zz-kb-store-battery%']).catch(() => {});
  await db.query('DELETE FROM library_files WHERE namespace LIKE $1', ['zz-kb-store-battery%']).catch(() => {});
}

(async () => {
  await db.initialize();
  try {
    await cleanup();

    section('status');
    const st = await vs.getStatus();
    check('the store is set up here', st.configured && st.store === 'pgvector' && st.library === 'lybi', JSON.stringify(st));
    const fresh = await db.query(`SELECT current_setting('hnsw.iterative_scan', true) AS v`);
    check('HNSW iterative scan is on (filtered searches keep a full top K)', fresh.rows[0].v === 'strict_order', fresh.rows[0].v);

    section('index · list · search');
    const e3 = [vec(1), vec(2), vec(3)];
    const r1 = await vs.indexFile({ namespace: NS, fileId: 111, fileName: 'zz-a.md', chunks: chunks(3, 'A'), embeddings: e3, kbId: 0, agentId: 0 });
    check('a file indexes', r1.vectorCount === 3 && (await count(NS, 111)) === 3);
    const listed = await vs.listVectors(NS, { fileId: '111' });
    check("a file's chunks list in order, with their text", listed.map(v => v.metadata.chunkIndex).join() === '0,1,2' && listed[1].metadata.text.startsWith('A chunk 1'));
    check('…numeric file ids come back as numbers', listed[0].metadata.fileId === 111 && listed[0].metadata.fileType === 'md');
    const q1 = await vs.query([NS], 'unused', { topK: 3, scoreThreshold: -1, maxTokens: 100000, embedding: e3[1] });
    check('search: the chunk itself ranks first, cosine 1', q1.results[0]?.chunkIndex === 1 && Math.abs(q1.results[0].score - 1) < 1e-5, JSON.stringify(q1.results.map(r => [r.chunkIndex, r.score.toFixed(4)])));
    check('…every hit carries file, KB and namespace', q1.results.every(r => r.fileName === 'zz-a.md' && r.namespace === NS && r.fileId === 111));
    const q2 = await vs.query([NS], 'unused', { topK: 3, scoreThreshold: 0.99, embedding: e3[1] });
    check('minScore cuts the rest', q2.results.length === 1 && q2.totalResults === 1);
    const q3 = await vs.query([NS], 'unused', { topK: 3, scoreThreshold: -1, maxTokens: 1, embedding: e3[1] });
    check('the token budget keeps at least the best hit', q3.results.length === 1);

    section('replace · string ids · model isolation');
    await vs.indexFile({ namespace: NS, fileId: 111, fileName: 'zz-a.md', chunks: chunks(2, 'A2'), embeddings: [vec(4), vec(5)] });
    check('re-indexing a file replaces it — no stale chunks', (await count(NS, 111)) === 2);
    await vs.indexFile({ namespace: NS, fileId: 'atom-5', fileName: 'HQ atom', fileType: 'meeting', chunks: chunks(1, 'H'), embeddings: [vec(6)] });
    const qh = await vs.query([NS], 'unused', { topK: 1, scoreThreshold: -1, embedding: vec(6) });
    check("HQ's string file ids round-trip ('atom-<id>')", qh.results[0]?.fileId === 'atom-5' && (await count(NS, 'atom-5')) === 1);
    await vs.insertVectors(db, [{ namespace: NS, id: 'zz-legacy-0', embeddingModel: 'text-embedding-ada-002', embedding: vec(7), text: 'legacy', fileId: 'zz', chunkIndex: 0 }]);
    const qm = await vs.query([NS], 'unused', { topK: 10, scoreThreshold: -1, maxTokens: 100000, embedding: vec(7) });
    check('a search compares only rows of its own embedding model', !qm.results.some(r => r.text === 'legacy'));
    let dimErr = null;
    await vs.insertVectors(db, [{ namespace: NS, id: 'zz-bad', embeddingModel: 'x', embedding: [1, 2, 3] }]).catch(err => { dimErr = err; });
    check('a vector of the wrong size is refused', dimErr instanceof vs.KbStoreError && dimErr.status === 400);
    const stats = await vs.getStats();
    check('stats list the KB with its chunk count', stats.namespaces.some(n => n.name === NS && n.vectorCount === 4));
    check('namespaceExists', (await vs.namespaceExists(NS)) && !(await vs.namespaceExists('zz-kb-store-battery-none')));

    section('deletes clean up');
    check('deleting a file removes its chunks', (await vs.deleteFile(NS, 111)) === 2 && (await count(NS, 111)) === 0);
    await db.query(`INSERT INTO library_files (index_name, namespace, file_id, file_name, chunk_count) VALUES ('lybi', $1, '222', 'zz-b.md', 1)`, [NS]);
    await vs.indexFile({ namespace: NS, fileId: 222, fileName: 'zz-b.md', chunks: chunks(1, 'B'), embeddings: [vec(8)] });
    const [row] = (await db.query(`SELECT id FROM library_files WHERE namespace = $1 AND file_id = '222'`, [NS])).rows;
    const byRow = await kbLibrary.deleteFileByRowId(row.id);
    check('the screen\'s file delete removes record AND chunks', byRow?.fileName === 'zz-b.md' && (await count(NS, 222)) === 0
      && (await db.query('SELECT 1 FROM library_files WHERE id = $1', [row.id])).rows.length === 0);
    await db.query(`INSERT INTO library_files (index_name, namespace, file_id, file_name, chunk_count) VALUES ('lybi', $1, '333', 'zz-c.md', 1)`, [NS]);
    const gone = await kbLibrary.deleteKb(NS);
    check('deleting a KB removes every chunk and record, together', gone.vectors === 2 && gone.files === 1 && (await count(NS)) === 0, JSON.stringify(gone));

    section('the agent copy carries the chunks');
    const ol = agentCopy.oneLibrary({
      kbLinks: [{ index_name: 'freeda', namespace: 'k', agent_id: 'a' }, { index_name: 'lybi', namespace: 'k', agent_id: 'a' }],
      libraryFiles: [
        { index_name: 'freeda', namespace: 'k', file_id: '1', file_name: 'x.pdf' },
        { index_name: 'lybi', namespace: 'k', file_id: '2', file_name: 'x.pdf' },
        { index_name: 'freeda', namespace: 'k', file_id: '3', file_name: 'y.pdf' },
      ],
    });
    check('old index names fold into the one library (duplicates dropped, like 075)',
      ol.kbLinks.length === 1 && ol.libraryFiles.map(f => f.file_id).sort().join() === '2,3'
      && [...ol.kbLinks, ...ol.libraryFiles].every(r => r.index_name === 'lybi'));
    // An agent of this environment with linked KBs that hold chunks.
    const [src] = (await db.query(`SELECT a.slug, count(v.*)::int n FROM builder_agents a
        JOIN kb_links l ON l.agent_id = a.id JOIN kb_vectors v ON v.namespace = l.namespace
       WHERE a.archived_at IS NULL GROUP BY a.slug ORDER BY n DESC, a.slug LIMIT 1`)).rows;
    if (!src) {
      check('an agent with linked, filled KBs exists here', false);
    } else {
      const q = (sql, p = []) => db.query(sql, p).then(r => r.rows);
      const bundle = await agentCopy.readFromDb(q, src.slug, { from: env.id });
      const want = (await db.query(`SELECT count(*)::int n FROM kb_vectors WHERE namespace = ANY($1)`,
        [[...new Set(bundle.kbLinks.map(k => k.namespace))]])).rows[0].n;
      check(`the DB reader carries every chunk of ${src.slug}'s KBs`, bundle.kbVectors?.length === want && want > 0, `${bundle.kbVectors?.length} of ${want}`);
      check('…with embeddings of the store\'s size', bundle.kbVectors.every(v => v.embedding.length === DIM && v.embeddingModel));
      check('…and every link / file record in the one library', bundle.kbLinks.every(k => k.index_name === 'lybi') && bundle.libraryFiles.every(f => f.index_name === 'lybi'));
      check('the plan counts them', agentCopy.planOf(bundle).kbVectors === want);

      if (opt('--api')) {
        const viaApi = await agentCopy.readFromApi(opt('--api').replace(/\/$/, ''), src.slug, { from: 'api' });
        check('the API reader (copy door) carries the same chunks', viaApi?.kbVectors?.length === want
          && viaApi.kbVectors.every(v => v.embedding.length === DIM), `${viaApi?.kbVectors?.length} of ${want}`);
      }

      // Write it as a copy would — into a scratch KB, inside a transaction that is rolled back.
      const probe = {
        ...bundle,
        folders: [], kbLinks: [], libraryFiles: [], agentLog: [], legacy: [],
        kbVectors: bundle.kbVectors.map(v => ({ ...v, namespace: NS_COPY })),
      };
      let inside = -1;
      const connect = async () => {
        const c = await db.getClient();
        return {
          query: async (sql, p) => {
            if (sql === 'COMMIT') {
              inside = (await c.query('SELECT count(*)::int n FROM kb_vectors WHERE namespace = $1', [NS_COPY])).rows[0].n;
              return c.query('ROLLBACK');
            }
            return c.query(sql, p);
          },
          release: () => c.release(),
        };
      };
      const { written } = await agentCopy.copyBundle({ connect, bundle: probe, existing: null, placement: { mode: 'keep' } });
      check('copyBundle writes every chunk into the target, in its transaction', written.kbVectors === want && inside === want, `${written.kbVectors} written, ${inside} seen`);
      check('…(rolled back here: nothing left behind)', (await count(NS_COPY)) === 0);
    }
  } catch (err) {
    console.error('\nBATTERY ERROR:', err.stack || err.message);
    fails++;
  } finally {
    await cleanup();
    await db.close().catch(() => {});
  }
  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASSED'}`);
  process.exit(fails ? 1 : 0);
})();
