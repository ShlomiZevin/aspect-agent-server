-- Page comments: threaded comments on internal pages (e.g. /lybi/bank-jerusalem).
-- The router (page-comments/routes.js) also creates this lazily on first request.
CREATE TABLE IF NOT EXISTS internal_brainstorm_comments (
  id SERIAL PRIMARY KEY,
  page_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  parent_id INTEGER,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by TEXT,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS internal_brainstorm_comments_page_idx ON internal_brainstorm_comments (page_id);

CREATE TABLE IF NOT EXISTS internal_brainstorm_settings (
  page_id TEXT PRIMARY KEY,
  hidden_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
