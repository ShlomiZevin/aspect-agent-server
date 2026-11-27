-- 073 — pgvector in the environment's own Postgres (proof of concept, 2026-11-23).
--
-- Knowledge-base vectors live in Pinecone today (index + namespace per KB).
-- This puts the same vectors inside each environment's Cloud SQL so we can
-- prove pgvector is good enough to replace Pinecone. The table mirrors
-- Pinecone's own addressing (index / namespace / vector id) one to one, so a
-- KB copied from Pinecone keeps its ids, its embeddings and its metadata as
-- they are — nothing is re-embedded. Filled by kb-pgvector/copy-from-pinecone.js;
-- read by kb-pgvector/ (the /:agent/pgvector-poc page).
--
-- Cloud SQL for PostgreSQL ships the `vector` extension (0.8.x on PG 15); the
-- app user is a member of cloudsqlsuperuser, so CREATE EXTENSION needs no
-- database flag and no extra Google Cloud API.
--
-- Today's retrieval is dense only (Pinecone index type "dense", cosine, no
-- sparse values, no reranker), so there is no full-text column here: the
-- comparison is cosine against cosine on the same vectors.
--
-- Superseded by 075 (board #1014): kb_vectors's final shape, keyed by
-- (namespace, id). A new environment runs 075 only.
--
-- Safe to run twice.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kb_vectors (
  index_name       VARCHAR(255) NOT NULL,   -- the Pinecone index it came from (e.g. 'lybi')
  namespace        VARCHAR(255) NOT NULL,   -- the KB (Pinecone namespace, e.g. 'account-opening-kb')
  id               VARCHAR(512) NOT NULL,   -- the Pinecone vector id ('file-<fileId>-chunk-<n>')
  embedding_model  VARCHAR(100) NOT NULL,   -- the model the vector was made with; queries must use the same one
  embedding        vector(1536) NOT NULL,
  text             TEXT NOT NULL DEFAULT '',
  file_name        TEXT,
  file_id          BIGINT,
  chunk_index      INTEGER,
  metadata         JSONB,                   -- the full Pinecone metadata, as it was
  copied_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (index_name, namespace, id)
);

-- Approximate nearest neighbour, cosine — the same metric as the Pinecone index.
CREATE INDEX IF NOT EXISTS kb_vectors_embedding_hnsw
  ON kb_vectors USING hnsw (embedding vector_cosine_ops);

-- One table holds every KB, so a search filters on (index_name, namespace)
-- AFTER the HNSW walk. With pgvector's default the walk stops after
-- ef_search (40) candidates and a filtered search can come back short of top K.
-- Iterative scan (pgvector 0.8+) keeps walking until top K rows pass the
-- filter, in exact distance order. Set for the whole database (only HNSW
-- scans read it — kb_vectors is the only HNSW index), so every search is a
-- single plain query.
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET hnsw.iterative_scan = strict_order', current_database());
END $$;
