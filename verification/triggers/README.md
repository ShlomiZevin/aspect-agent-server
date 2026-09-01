# Triggers (Builder V2 — phase T2)

What was checked: the trigger primitive itself — the rules that decide
*which* conversations deserve a proactive turn, and the explainer that
answers why one didn't get one.

## Reproduce

```bash
cd aspect-agent-server
node scripts/test-triggers.js --offline          # Part A only: instant, no DB, no LLM
node scripts/test-triggers.js [agentSlug] [crewId]
# defaults: onboarding-foreign / crew_adz1iw5 ("Ongoing support")
```

Part B creates a throwaway conversation, backdates it to simulate real
elapsed silence, fires for real, and deletes everything in a `finally`.

## Results — 2026-08-31

**46/46 passed** (26 offline + 20 end-to-end). Raw output in
`results.json`.

| Group | What it proves |
|---|---|
| quiet long enough | Fires past the threshold, not before; a customer who never spoke has no silence to measure; the reason reads in the author's units. |
| spacing | An attempt inside the window blocks the next. Includes the **forever-loop guard**: a *silent* attempt a minute ago does not re-fire, even on a 3-day silence. |
| under the cap | Counts **attempts, not messages**. Attempt 3 of 3 fires, attempt 4 doesn't, a missing `maxAttempts` falls back to 3 rather than unlimited. |
| after switch-on | A conversation that went quiet **before** the trigger was enabled is never touched — no backfill is structurally possible. |
| config robustness | A hand-edited body with a missing / zero / negative / garbage duration falls back to the default instead of matching everything. |
| quiet hours | Midnight-wrapping and same-day windows; an unknown timezone **fails open** and says so. |
| end to end | Dry run finds and launches nothing · a real sweep speaks · the event row records the reason, the brief and the message · spacing and cap hold live · a customer reply resets the sequence · the explainer reconstructs a past moment · the status row keeps a heartbeat · scope holds. |

## The bug this battery caught before it shipped

The first end-to-end run found **zero** conversations, with no error
anywhere. Root cause: migrations 044 and 045 declared their columns as
`timestamp` (no time zone), matching the older tables around them. The
database runs UTC and the Node process runs Israel time, and
node-postgres compares a JS `Date` against a naive column as *local*
wall-clock. Measured on this database:

```sql
SELECT now()::timestamp > $1::timestamp    -- $1 = one hour ago
→ false
```

"One hour ago is not in the past." Every clause a trigger evaluates is a
comparison of exactly that shape, so the symptom was a trigger that
matched nobody, ever, silently — the failure mode that is hardest to
notice and worst to ship. **Migration 046** converts the columns the
engine reads to `timestamptz` (verified: 0 minutes skew, both
directions correct) and makes the two remaining reads of the still-naive
`messages.created_at` explicit with `AT TIME ZONE 'UTC'`.

## Two failures that were the test's fault, kept as comments

Worth knowing, because both looked like product bugs:

1. Backdating the *events* alone pushed them before the customer's last
   message — which legitimately resets the counter, since the cap counts
   "attempts since they last spoke". An exhausted trigger firing again
   was correct behaviour on incorrectly-staged data.
2. Ageing the conversation to 5 hours of silence while leaving
   `activeSince` at one hour ago made the no-backfill clause correctly
   refuse it.

Both fixes are in the script with the reasoning inline, so the next
person staging a scenario doesn't rediscover them.

## Not covered here

The clock (T3), live push (T4), and the Triggers screen. This battery
drives the sweep directly.
