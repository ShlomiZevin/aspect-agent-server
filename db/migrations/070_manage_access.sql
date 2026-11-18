-- Management center access (task #985): who may sign in to /manage, and to
-- which agents. One row = one grant:
--
--   agent_id NULL      → every agent (the Lybi team)
--   agent_id <id>      → that one Builder agent (a customer's super user, later)
--
-- A person with three agents has three rows. Sign-in is with Google; the
-- email here is matched against the address Google vouches for, so it is
-- stored lowercased and trimmed (the CHECK keeps it that way).
--
-- `agent_id` is the Builder agent's id, not its slug: slugs are unique only
-- inside a project and can change; the FK also removes a grant when its
-- agent is deleted. Reads and the MCP show the slug.
--
-- Revoking = deleting the row. The server re-reads the grants on every
-- request, so a removed grant closes the door at once (the browser's
-- session token only proves WHO someone is, never what they may see).
--
-- Safe to run twice: IF NOT EXISTS everywhere, and the seed skips rows that
-- are already there (ON CONFLICT DO NOTHING covers the partial unique indexes).
CREATE TABLE IF NOT EXISTS manage_access (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  agent_id    VARCHAR(64) REFERENCES builder_agents(id) ON DELETE CASCADE,  -- NULL = every agent
  note        TEXT,
  granted_by  VARCHAR(255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT manage_access_email_clean CHECK (email <> '' AND email = lower(btrim(email)))
);

-- One "every agent" row per person, and one row per person per agent.
CREATE UNIQUE INDEX IF NOT EXISTS manage_access_email_all_unique
  ON manage_access (email) WHERE agent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS manage_access_email_agent_unique
  ON manage_access (email, agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS manage_access_agent_idx ON manage_access (agent_id);

-- The Lybi team: every agent.
INSERT INTO manage_access (email, agent_id, note, granted_by) VALUES
  ('shlomi@lybi.ai', NULL, 'Lybi team', 'migration 070'),
  ('noa@lybi.ai',    NULL, 'Lybi team', 'migration 070'),
  ('hila@lybi.ai',   NULL, 'Lybi team', 'migration 070')
ON CONFLICT DO NOTHING;
