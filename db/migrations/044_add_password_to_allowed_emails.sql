-- 044_add_password_to_allowed_emails.sql
--
-- The second way in: email and password, beside Google.
--
-- The password lives on the invitation rather than on `users`, because the
-- invitation IS the account here — it is what an admin creates ahead of time,
-- and a `users` row only appears once the person actually arrives. Putting the
-- credential on `users` would mean creating hollow rows for people who may
-- never sign in.
--
-- Stored as scrypt, salt and hash together in one field so there is no way to
-- read one without the other. Node has scrypt built in; adding bcrypt would
-- have been a native dependency for the same guarantee.
--
-- NULL means this person signs in with Google only, which is the normal case.

ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS password_hash text;

ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS password_set_at timestamptz;
