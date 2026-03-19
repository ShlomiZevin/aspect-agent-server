-- Dynamic KB files: admin-created files that can be edited in-platform and synced to KB providers
CREATE TABLE IF NOT EXISTS dynamic_kb_files (
  id            SERIAL PRIMARY KEY,
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  name          VARCHAR(255) NOT NULL,
  file_type     VARCHAR(20) NOT NULL,
  gcs_path      VARCHAR(1024),
  file_size     INTEGER DEFAULT 0,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- Junction table: which dynamic files are attached to which KBs
CREATE TABLE IF NOT EXISTS dynamic_kb_attachments (
  id                SERIAL PRIMARY KEY,
  dynamic_file_id   INTEGER NOT NULL REFERENCES dynamic_kb_files(id) ON DELETE CASCADE,
  knowledge_base_id INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  kb_file_id        INTEGER REFERENCES knowledge_base_files(id) ON DELETE SET NULL,
  created_at        TIMESTAMP DEFAULT NOW(),
  UNIQUE(dynamic_file_id, knowledge_base_id)
);
