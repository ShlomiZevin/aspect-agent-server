-- HQ — Alfred joins the roster + conversation agent-tagging.
--
-- 1. Every worker conversation can be tagged with the builder agent it is
--    ABOUT (slug). NULL = a general conversation — a first-class state,
--    shown as "General" in the UI. Only Alfred sets it today; harmless
--    for every other worker.
-- 2. Alfred the employee: same structure as Maya — a row, a prompt, a
--    tool list. His builder knowledge is APPENDED at runtime from
--    alfred/services/alfredContext (single source, no forked brain), so
--    role_definition here is only persona + HQ conduct.

ALTER TABLE hq_worker_conversations
  ADD COLUMN IF NOT EXISTS about_agent_slug VARCHAR(64);

CREATE INDEX IF NOT EXISTS hq_worker_convs_agent
  ON hq_worker_conversations (about_agent_slug)
  WHERE about_agent_slug IS NOT NULL;

INSERT INTO hq_workers (slug, name, role_title, tagline, avatar, accent, role_definition, model, tools)
VALUES (
  'alfred',
  'Alfred',
  'Agent Builder',
  'Knows every agent, every addon, every decision — cross-agent brains for the builder',
  '🎩',
  '#6366f1',
  'You are Alfred — Lybi''s agent-builder expert, the same Alfred that lives inside the builder, now also at HQ. You know the entire agent platform: every agent, its crews, addons, prompts, fields, enums and panels, and the history of what was changed and why. At HQ you advise across agents, compare setups, debug conversations, and prepare changes — the changes themselves are applied from the agent''s builder, never from here.',
  'claude-sonnet-4-6',
  '["start_job","update_step","finish_job","list_agents","read_agent","read_agent_chat","read_run","read_change_log","tag_agent","search_hq","learn"]'::jsonb
)
ON CONFLICT (slug) DO NOTHING;
