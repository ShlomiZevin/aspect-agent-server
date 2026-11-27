-- 075 — pgvector becomes THE knowledge-base store (board #1014, 2026-11-27).
--
-- Shlomi, meeting 24.11: "Replace Pinecone with pgvector completely." Each
-- environment's knowledge lives in its OWN database (Cloud SQL, in the
-- environment's own region) instead of the one Pinecone index every
-- environment used to share. Read and written by services/kb.vectorStore.service.js
-- only; filled once from Pinecone by scripts/kb-copy-from-pinecone.js.
--
-- 073 made kb_vectors as a proof-of-concept COPY addressed like Pinecone
-- (index_name, namespace, id) with a numeric file_id. This puts it in its
-- final shape, in place (rows kept):
--
--   * A KB is its namespace. One environment = one database = one library,
--     so the Pinecone index name is not part of a vector's address any more.
--   * file_id is text: library_files.file_id is text, and Lybi HQ indexes
--     its atoms as 'atom-<id>'.
--   * (namespace, file_id) is indexed: a file's delete / re-index and a
--     file's chunk listing are one index range, and a small KB's search can
--     be planned as an exact scan of its own rows.
--
-- Search index: HNSW, cosine (vector_cosine_ops) — the metric the
-- embeddings were made for and that the Pinecone index used. HNSW, not
-- IVFFlat: IVFFlat clusters the rows that exist when the index is built and
-- needs a rebuild as KBs are added (an empty or growing table gets poor
-- lists), while HNSW is built incrementally, works from the first row, and
-- has the better recall / speed trade-off at our sizes (thousands to a few
-- hundred thousand chunks per environment). Filtered searches (one KB out
-- of many) keep walking the graph until top K rows pass the filter
-- (hnsw.iterative_scan = strict_order, set per database by 073 and again
-- here so a new environment needs only this file).
--
-- Dimensions: 1536 — text-embedding-3-small (every KB) and ada-002 (the
-- legacy '__default__' namespace) are both 1536. The model each row was
-- made with is stored; a search embeds with the namespace's model and only
-- compares rows of that model.
--
-- Also: library_files and kb_links keep an index_name column from the
-- Pinecone era. From now on it is one constant (KB_LIBRARY = 'lybi' in the
-- vector store service) in every environment; rows under another name
-- (staging holds copies made under Origin's old 'freeda' index) are folded
-- into it — a duplicate of a row that already exists under 'lybi' is
-- removed, the rest renamed.
--
-- Safe to run twice; safe on a database that never ran 073.

CREATE EXTENSION IF NOT EXISTS vector;

-- From the 073 proof-of-concept shape (if this database has it) to the final one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'kb_vectors' AND column_name = 'index_name') THEN
    -- Keep one row per (namespace, id) — the copy only ever held one index.
    DELETE FROM kb_vectors a USING kb_vectors b
     WHERE a.namespace = b.namespace AND a.id = b.id AND a.index_name > b.index_name;
    ALTER TABLE kb_vectors DROP CONSTRAINT IF EXISTS kb_vectors_pkey;
    ALTER TABLE kb_vectors DROP COLUMN index_name;
    ALTER TABLE kb_vectors ALTER COLUMN file_id TYPE VARCHAR(255) USING file_id::text;
    ALTER TABLE kb_vectors RENAME COLUMN copied_at TO created_at;
    ALTER TABLE kb_vectors ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');
    -- The full Pinecone metadata was stored WITH the chunk text; the text has its own column.
    UPDATE kb_vectors SET metadata = metadata - 'text' - 'chunkText' WHERE metadata ? 'text' OR metadata ? 'chunkText';
    ALTER TABLE kb_vectors ADD PRIMARY KEY (namespace, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS kb_vectors (
  namespace        VARCHAR(255) NOT NULL,   -- the knowledge base (e.g. 'account-opening-kb'; Lybi HQ: 'hq')
  id               VARCHAR(512) NOT NULL,   -- 'file-<fileId>-chunk-<n>' (ids copied from Pinecone are kept)
  embedding_model  VARCHAR(100) NOT NULL,   -- the model the vector was made with; queries use the same one
  embedding        vector(1536) NOT NULL,
  text             TEXT NOT NULL DEFAULT '',
  file_name        TEXT,
  file_id          VARCHAR(255),            -- library_files.file_id (HQ: 'atom-<id>')
  chunk_index      INTEGER,
  metadata         JSONB,                   -- the rest: kbId, agentId, fileType, totalChunks
  created_at       TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (namespace, id)
);

CREATE INDEX IF NOT EXISTS kb_vectors_namespace_file ON kb_vectors (namespace, file_id);

CREATE INDEX IF NOT EXISTS kb_vectors_embedding_hnsw
  ON kb_vectors USING hnsw (embedding vector_cosine_ops);

DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET hnsw.iterative_scan = strict_order', current_database());
END $$;

-- One library per environment (see above).
DELETE FROM kb_links a USING kb_links b
 WHERE a.index_name <> 'lybi' AND b.index_name <> 'lybi' AND a.id > b.id
   AND a.namespace = b.namespace AND a.agent_id = b.agent_id;
DELETE FROM kb_links a USING kb_links b
 WHERE a.index_name <> 'lybi' AND b.index_name = 'lybi'
   AND a.namespace = b.namespace AND a.agent_id = b.agent_id;
UPDATE kb_links SET index_name = 'lybi' WHERE index_name <> 'lybi';

DELETE FROM library_files a USING library_files b
 WHERE a.index_name <> 'lybi' AND b.index_name = 'lybi'
   AND a.namespace = b.namespace AND (a.file_id = b.file_id OR a.file_name = b.file_name);
UPDATE library_files SET index_name = 'lybi' WHERE index_name <> 'lybi';
