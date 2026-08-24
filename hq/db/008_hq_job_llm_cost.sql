-- Track what a job cost in THINKING, not just in images.
--
-- `cost_usd` was image spend only, so a job that generated three pictures
-- looked like it cost 12 cents when the reasoning behind them cost more. Both
-- halves are real money and both should be reportable — an employee who can
-- tell you what a piece of work cost is more useful than one who cannot.
ALTER TABLE hq_jobs ADD COLUMN IF NOT EXISTS llm_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0;
ALTER TABLE hq_jobs ADD COLUMN IF NOT EXISTS llm_tokens_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hq_jobs ADD COLUMN IF NOT EXISTS llm_tokens_out INTEGER NOT NULL DEFAULT 0;
