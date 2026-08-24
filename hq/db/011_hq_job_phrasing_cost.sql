-- Split a job's token spend into thinking and voice.
--
-- `llm_cost_usd` was written from the agent loop's own usage, so it only ever
-- counted Claude — a job that sent five briefs to OpenAI reported the phrasing
-- as free. Two providers bill separately and a person should be able to see
-- which one the money went to, so they are recorded apart.
ALTER TABLE hq_jobs ADD COLUMN IF NOT EXISTS phrasing_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0;
