-- 060_ic_existing_access.sql
--
-- Task #113: the Intelligence Center now needs a grant for the customer it
-- shows. Before this, Google sign-in was open registration and nobody needed a
-- grant — so without this migration everyone who already signs in would be
-- locked out the moment the gate ships.
--
-- 1. Our own team gets a GLOBAL grant (tenant NULL = every customer).
-- 2. Everyone who has already signed in (Google or password) gets a grant for
--    the customer they signed in on, so they keep working.
--
-- Idempotent: re-running adds nothing that is already there and never revives
-- a grant someone has since revoked.

INSERT INTO allowed_emails (email, tenant, role, invited_by, note)
SELECT v.email, NULL, 'admin', 'migration-060', v.note
FROM (VALUES
  ('shlomi@boostart.io',          'Shlomi'),
  ('ziben.konstantin@gmail.com',  'Kosta'),
  ('ziben.julianna16@gmail.com',  'Kosta')
) AS v(email, note)
WHERE NOT EXISTS (
  SELECT 1 FROM allowed_emails a WHERE a.email = v.email AND a.tenant IS NULL
);

INSERT INTO allowed_emails (email, tenant, role, invited_by, note)
SELECT DISTINCT lower(u.email), u.tenant, 'user', 'migration-060', 'Signed in before task #113'
FROM users u
WHERE (u.external_id LIKE 'google\_%' OR u.external_id LIKE 'email\_%')
  AND u.email IS NOT NULL
  AND u.tenant IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM allowed_emails a
    WHERE a.email = lower(u.email) AND (a.tenant = u.tenant OR a.tenant IS NULL)
  );
