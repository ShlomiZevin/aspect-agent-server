# pgvector proof of concept — Pinecone vs pgvector on the same KB

> **Outcome (2026-11-27, board #1014):** pgvector replaced Pinecone. The PoC page,
> `kb-pgvector/` and `kb.pinecone.service.js` were removed (git history has them);
> the store is `services/kb.vectorStore.service.js` on `kb_vectors` (migration 075),
> and the one-time move is `scripts/kb-copy-from-pinecone.js`. The reproduce steps
> below describe the PoC as it ran.

**Checked (2026-11-23):** can pgvector inside an environment's own Cloud SQL (Tel Aviv)
replace Pinecone for knowledge-base retrieval? Same KB, same stored vectors, same query
vector on both sides; compare the ranked lists and the latency.

## Setup

| | |
|---|---|
| Environment | Lybi Staging (`lybi-staging-db`, PostgreSQL 15, pgvector 0.8.5) |
| KB | `lybi/account-opening-kb` — 86 chunks, 2 Hebrew files (general Israeli banking knowledge + "anti-jargon" guide). Linked to `account-opening`, the agent with by far the most real staging traffic (226 conversations, 1,861 user messages). |
| Embeddings | `text-embedding-3-small`, 1536d — vectors **copied from Pinecone as they are** (list + fetch), not re-embedded. Sampled copies identical to 3.6e-9. Queries embedded once by `services/kb.embedding.service.js` (the namespace's own model, the runtime's call) and the same vector sent to both sides. |
| Today's retrieval (mirrored) | KB Retriever add-on → `kb.pinecone.service.query`: dense only (Pinecone index type `dense`, cosine, no sparse values, no reranker, no metadata filter), top K per namespace, then min-score and token-budget cuts. Nothing keyword-based, so no full-text search on the pgvector side. |
| Compared | Raw top 10 on both sides (no min-score / token cut). Pinecone = `kb.pinecone.service.query` given the vector. pgvector = `ORDER BY embedding <=> $1 LIMIT k` on `kb_vectors` (HNSW cosine index). |
| Ground truth | Brute-force cosine in float64 over the 86 stored vectors. |
| Latency | Measured from a laptop in Israel: → Cloud SQL Tel Aviv (one query, SSL) and → Pinecone AWS us-east-1. Median of 3 runs per query, after one warm-up. From Cloud Run in me-west1 the pgvector side should be lower still (same region, Unix socket). |

## Results — 20 real queries (14 Hebrew, 6 English)

| | Pinecone | pgvector |
|---|---|---|
| Overlap with each other | **98.5%** (197/200); 14/20 lists in identical order | |
| Overlap with the exact answer | 98.5%, 14/20 identical | **100%, 20/20 identical** |
| Max score error vs exact | 1.4e-3 | 1.2e-7 |
| Search latency p50 / p95 | **165 / 173 ms** | **17 / 20 ms** |

- **Every difference is Pinecone's.** Pinecone serverless returns approximate scores
  (±0.001), so near-ties swap places and once in a while the 10th result changes. pgvector
  returned the exact top 10 for all 20 queries.
- **The HNSW path is also exact here**: with the index forced (`enable_seqscan off`, plan
  checked), 20/20 identical to the exact answer. For one KB of this size the planner reads
  the KB's rows by the primary key and sorts them (exact) — HNSW takes over on large KBs.
- Embedding the query (OpenAI) costs ~220 ms p50 on both paths alike; it dominates either way.
- Not every run is identical: OpenAI returns slightly different vectors for the same text
  on different calls, so a near-tie can swap between runs — on both sides together.

| # | Query | Lang | Same | Order | Pinecone vs exact | pgvector vs exact | Pinecone ms | pgvector ms |
|---|---|---|---|---|---|---|---|---|
| 1 | הי, מה הדמי ניהול של חשבון אצלכם? | he | 10/10 | same | 10 | 10 | 168 | 18 |
| 2 | כסף. כמה אני משלמת וכמה אוכל לקבל על פיקדון לשנה | he | 10/10 | same | 10 | 10 | 165 | 16 |
| 3 | הי, איזה פקדונות יש לכם? | he | 10/10 | same | 10 | 10 | 163 | 17 |
| 4 | אם יש תחנת יציאה בעוד כמה חודשים בלי קנס משמעותי… | he | 10/10 | same | 10 | 10 | 167 | 17 |
| 5 | בעיקר ריבית נמוכה והאפשרות לפרוע מוקדם… הרכב משועבד לבנק | he | 10/10 | same | 10 | 10 | 175 | 17 |
| 6 | מה המסמכים שאני צריכה להביא? | he | 9/10 | differs | 9 | 10 | 173 | 17 |
| 7 | תעודת הזהות שלי ישנה, בלי שבב… | he | 10/10 | differs | 10 | 10 | 170 | 18 |
| 8 | חשבון אישי, רק על שמי. כבר יש לי חשבון בבנק אחר… | he | 10/10 | same | 10 | 10 | 169 | 18 |
| 9 | מסגרת! כי אני מבזבזת מלא | he | 10/10 | same | 10 | 10 | 167 | 16 |
| 10 | מה לגבי כרטיס אשראי? | he | 10/10 | same | 10 | 10 | 165 | 17 |
| 11 | הי, אני רוצה לפתוח חשבון לי ולבעלי ביחד | he | 10/10 | same | 10 | 10 | 165 | 16 |
| 12 | הי, אני משלם כרגע עמלות גבוהות בבנק שלי ושוקל לעבור בנק | he | 10/10 | differs | 10 | 10 | 165 | 18 |
| 13 | לא. אבל למה ההכנסה מההורים שלי לא נחשבת משכורת? | he | 10/10 | same | 10 | 10 | 165 | 17 |
| 14 | יש לי בערך 60 אלף לשים בצד… | he | 10/10 | same | 10 | 10 | 167 | 16 |
| 15 | Hi, I would like to open a bank account | en | 10/10 | same | 10 | 10 | 161 | 16 |
| 16 | hi, I am 16 and I want to open an account | en | 9/10 | differs | 9 | 10 | 164 | 16 |
| 17 | How much is the monthly account management fee? | en* | 9/10 | differs | 9 | 10 | 163 | 17 |
| 18 | If I break a one-year deposit early, do I lose the interest? | en* | 10/10 | same | 10 | 10 | 166 | 15 |
| 19 | I mostly want a low interest rate on a car loan… | en* | 10/10 | differs | 10 | 10 | 164 | 15 |
| 20 | My ID card is the old one without a chip… | en* | 10/10 | same | 10 | 10 | 163 | 15 |

Queries 1–16 are real customer messages from `account-opening` conversations on staging,
verbatim; \* = an English rendering of a real Hebrew message (staging has almost no English
knowledge questions). Full queries: `kb-pgvector/queries.json` (the script input). Raw run, per-run timings,
top 3: `results.json` (git-ignored like every verification JSON; regenerate with the commands below).

## For the next step (not built)

- One table holds every KB, so a search filters by KB. For small KBs Postgres reads that KB's
  rows exactly (what happened here). For large KBs with HNSW, migration 073 turns on
  `hnsw.iterative_scan = strict_order` so a filtered walk still fills top K; at real scale,
  per-KB partial indexes or partitioning are the options to measure.
- Not measured: a large KB (thousands of chunks) and latency from Cloud Run itself — both
  easy with the same scripts once more KBs are copied.

## Reproduce

```bash
cd aspect-agent-server
node db/migrations/run-073-pgvector-kb-vectors.js --env staging                     # once per environment
node kb-pgvector/copy-from-pinecone.js --env staging --namespace account-opening-kb   # read-only on Pinecone
node kb-pgvector/verify.js --env staging                                              # writes results.json
```
Page: `/account-opening/pgvector-poc` (server `GET/POST /api/kb-pgvector/:agent/{info,search}`).
