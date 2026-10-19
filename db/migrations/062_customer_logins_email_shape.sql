-- 062_customer_logins_email_shape.sql
--
-- Task #113 follow-up (Shlomi): the per-project customer users are named like
-- an email address, `zolstock@aspect.com`, not `zolstock.aspect.com`.
-- Passwords, projects and admin marks stay as they are.
--
-- Idempotent: only rows still in the old shape are touched.

UPDATE allowed_emails
SET email = split_part(email, '.aspect.com', 1) || '@aspect.com'
WHERE email IN (
  'aspect.aspect.com', 'hypertoy.aspect.com', 'newdeli.aspect.com', 'superhist.aspect.com',
  'tevanaot.aspect.com', 'thestock.aspect.com', 'zer4u.aspect.com', 'zolstock.aspect.com'
)
AND NOT EXISTS (
  SELECT 1 FROM allowed_emails a2
  WHERE a2.email = split_part(allowed_emails.email, '.aspect.com', 1) || '@aspect.com'
);
