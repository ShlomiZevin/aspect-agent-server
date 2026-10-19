-- 061_allowed_emails_projects.sql
--
-- Task #113: one sign-in account can belong to several projects. Until now an
-- account was one row per (login, project), so a person on 2-3 projects had
-- 2-3 rows, each with its own password and admin mark.
--
-- Now: one row per login, `tenants` = the projects it opens, NULL = every
-- project (us). The old `tenant` column stays for now so a server still on the
-- previous revision keeps working while the new one rolls out; nothing reads it
-- after that, and a later migration can drop it.
--
-- Idempotent.

ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS tenants text[];

UPDATE allowed_emails
SET tenants = ARRAY[tenant]
WHERE tenant IS NOT NULL AND tenants IS NULL;

-- Folding several rows of one login into one is a decision about passwords and
-- admin marks, not something to guess here. There are none today; stop if that
-- has changed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM allowed_emails GROUP BY email HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'allowed_emails has a login on several rows - merge them by hand first';
  END IF;
END $$;

DROP INDEX IF EXISTS allowed_emails_scoped_idx;
DROP INDEX IF EXISTS allowed_emails_global_idx;
CREATE UNIQUE INDEX IF NOT EXISTS allowed_emails_email_idx ON allowed_emails (email);
