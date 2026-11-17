-- Task #117: the Aspect demo "fashion" crew runs on an ACTIVE Crew Editor
-- version "Faster" (crew_prompts.id 104, 2026-09-07) that pins model gpt-4o
-- and carries a copy of the old prompt. Shlomi: no demo agent below Terra.
-- Deactivating it makes the crew fall back to agents/aspect/crew/fashion.crew.js
-- (gpt-5.6-terra + the #117 table/CTA rules). The row is kept, so this is
-- reversible: set is_active back to true (or activate it in the Crew Editor).
UPDATE crew_prompts
   SET is_active = false,
       updated_at = now()
 WHERE id = 104
   AND agent_id = 2
   AND crew_member_name = 'fashion'
   AND name = 'Faster'
   AND model = 'gpt-4o'
   AND is_active = true;
