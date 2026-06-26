-- KB↔agent visibility links (many-to-many).
--
-- A "KB" is a Pinecone namespace, global in the shared index. This table
-- records which builder agents each namespace is related to, so the
-- builder surfaces only the relevant KBs per agent. Pure visibility — no
-- owner, no shared flag. A KB is visible to an agent iff a link row exists.
--
-- Duplicating an agent copies its link rows (handled in
-- builder/services/builderProjects.js) so the clone sees the same KBs.

CREATE TABLE IF NOT EXISTS kb_links (
  id          SERIAL PRIMARY KEY,
  index_name  VARCHAR(255) NOT NULL,
  namespace   VARCHAR(255) NOT NULL,
  agent_id    VARCHAR(64)  NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS kb_links_unique   ON kb_links (index_name, namespace, agent_id);
CREATE INDEX        IF NOT EXISTS kb_links_agent_idx ON kb_links (agent_id);
CREATE INDEX        IF NOT EXISTS kb_links_ns_idx    ON kb_links (index_name, namespace);

-- ── Backfill from existing usage ──────────────────────────────────────
-- Reconstruct links from KB Retriever addons already wired in agents'
-- ACTIVE versions: every namespace a retriever selects gets linked to
-- that addon's agent. The index_name is taken from the namespace's
-- tracked files (library_files), so only real, populated KBs are linked.
-- Idempotent (ON CONFLICT DO NOTHING) — safe to re-run.

-- Retrievers living in crew addons (the common case).
INSERT INTO kb_links (index_name, namespace, agent_id)
SELECT DISTINCT lf.index_name, ns.namespace, c.agent_id
FROM builder_crews c
JOIN builder_crew_versions cv ON cv.id = c.active_version_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cv.body->'addons', '[]'::jsonb)) AS addon
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(addon->'config'->'kbNamespaces', '[]'::jsonb)) AS ns(namespace)
JOIN library_files lf ON lf.namespace = ns.namespace
WHERE addon->>'pluginId' = 'kb-retriever'
ON CONFLICT (index_name, namespace, agent_id) DO NOTHING;

-- Retrievers living in the agent cortex (less common, but supported).
INSERT INTO kb_links (index_name, namespace, agent_id)
SELECT DISTINCT lf.index_name, ns.namespace, a.id
FROM builder_agents a
JOIN builder_agent_versions av ON av.id = a.active_version_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(av.body->'cortex', '[]'::jsonb)) AS addon
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(addon->'config'->'kbNamespaces', '[]'::jsonb)) AS ns(namespace)
JOIN library_files lf ON lf.namespace = ns.namespace
WHERE addon->>'pluginId' = 'kb-retriever'
ON CONFLICT (index_name, namespace, agent_id) DO NOTHING;
