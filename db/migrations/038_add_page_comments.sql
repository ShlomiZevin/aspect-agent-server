-- Review comments on internal spec/explainer pages (/aspect/*, /lybi/*).
--
-- Deliberately the simplest thing that works: a free-text name and a body,
-- anchored to a page and one of that page's sections. No auth, no threads, no
-- editing — these pages are internal review documents shared by link, and the
-- people commenting are a handful of named colleagues and clients. Anything
-- heavier would go unused.
--
-- `section_id` matches the DOM id of the section the comment was left on, so a
-- comment always lands back beside the paragraph it is about. 'general' is the
-- fallback for a page-level note.

CREATE TABLE IF NOT EXISTS page_comments (
  id         BIGSERIAL PRIMARY KEY,
  page_key   TEXT        NOT NULL,
  section_id TEXT        NOT NULL DEFAULT 'general',
  author     TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_comments_page ON page_comments (page_key, created_at);
