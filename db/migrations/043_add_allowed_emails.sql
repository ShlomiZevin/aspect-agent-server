-- 043_add_allowed_emails.sql
--
-- Who may sign in with Google, and to which agent.
--
-- Access is granted ahead of time, one email at a time, which is how Shlomi
-- asked for it. A row here is an invitation: the person does not exist as a
-- user until they actually sign in, and signing in without a row is refused.
--
-- Kept separate from `users` on purpose. A `users` row is someone who has been
-- here; a row here is someone who is allowed to be. Merging them would mean
-- either creating hollow user rows for people who never arrive, or deciding
-- access from a flag on a record that anonymous chat also writes to.
--
-- `tenant` is the agent slug, so the same email can be allowed on one client and
-- not another. NULL means every agent -- that is us, not a customer.

CREATE TABLE IF NOT EXISTS allowed_emails (
  id          serial PRIMARY KEY,
  email       varchar(255) NOT NULL,
  tenant      varchar(100),
  role        varchar(20)  NOT NULL DEFAULT 'user',
  invited_by  varchar(255),
  note        text,
  revoked_at  timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT allowed_emails_role_valid CHECK (role IN ('user', 'admin')),
  CONSTRAINT allowed_emails_email_lower CHECK (email = lower(email))
);

-- One grant per email per agent. A partial unique index rather than a plain
-- one, because NULL tenant would otherwise never collide with itself and the
-- same address could be granted global access twice.
CREATE UNIQUE INDEX IF NOT EXISTS allowed_emails_scoped_idx
  ON allowed_emails (email, tenant) WHERE tenant IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS allowed_emails_global_idx
  ON allowed_emails (email) WHERE tenant IS NULL;

-- The question asked on every sign-in.
CREATE INDEX IF NOT EXISTS allowed_emails_lookup_idx
  ON allowed_emails (email) WHERE revoked_at IS NULL;
