-- 042_backfill_byline_url_slug.sql
--
-- Byline is the only agent row with a NULL url_slug, while the client routes to
-- it as /byline like every other agent (src/agents/agentRegistry.ts).
--
-- That gap was harmless while nothing looked agents up by slug. It stopped being
-- harmless when modules gained client scope: anything that resolves a client
-- from its URL slug answers "unknown client" for Byline, so its Modules tab
-- 404s where every other agent's works.
--
-- Written as a guarded UPDATE rather than a blind one: it touches the row only
-- while the slug is still absent, so a re-run cannot overwrite a value someone
-- has since set deliberately.

UPDATE agents
   SET url_slug = 'byline',
       updated_at = now()
 WHERE lower(name) = 'byline'
   AND url_slug IS NULL;
