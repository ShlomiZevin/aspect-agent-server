-- HQ — reports a worker can hand you, instead of only talking in chat.
--
-- The pattern comes from the Matzav campaign: thirty creatives are unreviewable
-- as chat messages, but a single page showing every option with its reasoning
-- is how you actually decide. This is a worker presenting work, not answering.
--
-- The HTML is stored with {{media:ID}} placeholders rather than image URLs,
-- because our media URLs are SIGNED and expire in hours. A report with baked-in
-- links would look perfect the day it was made and be a page of broken images
-- a week later. Substitution happens at view time.
CREATE TABLE IF NOT EXISTS hq_reports (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER REFERENCES hq_workers(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES hq_worker_conversations(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES hq_jobs(id) ON DELETE SET NULL,
  title VARCHAR(300) NOT NULL,
  summary TEXT,
  html TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hq_reports_recent ON hq_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS hq_reports_conv ON hq_reports (conversation_id);
