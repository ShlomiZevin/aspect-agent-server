# Aspect task board — verification

What is checked, and how to reproduce it.

## Reproduce

Needs the Cloud SQL Proxy up (`cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432`).

```bash
node taskboard/db/migrations/verify-001-schema.js    # 15 checks — constraints, cascades, triggers
node verification/taskboard/test-taskboard-api.js    # 31 checks — routes + services + SQL end to end
```

Both clean up after themselves. The schema check runs inside a transaction it
rolls back; the API check deletes every task, person and notification it made,
including when it fails. `aspect_tasks_db` is the board people actually use, so
a run that left rows behind would be indistinguishable from real work.

## Results — 2026-08-31

| Check | Result |
|---|---|
| `verify-001-schema.js` | 15/15 |
| `test-taskboard-api.js` | 31/31 |

## What the API check covers

Creation and validation, partial updates, symmetric links, comments, likes as a
toggle, `@mention` notification, What's New deploy/dismiss/redeploy, the
needs-attention rules, notifications, filters, and delete cascades. It runs the
real router on a real port against the real database — calling the services
directly would pass while the router silently dropped a parameter, and the
routes are where the ordering traps are.

## Bugs these checks caught before the code shipped

Worth recording, because all four were invisible to reading:

1. **`setLinks` never filtered unknown ids.** `FROM unnest($2) AS id` names the
   *table* `id`, so `WHERE EXISTS (SELECT 1 FROM tasks WHERE tasks.id = id)`
   resolved to `tasks.id = tasks.id` — always true. Every id went through to the
   foreign key, and a link to a deleted task raised a 500 instead of being
   dropped. Fixed with `AS wanted(id)`, which names the column.
2. **The same alias trap in `notifyAbout`**, on the `@mention` list. Found by
   review rather than by the suite, because the first version of the suite had
   no mention in it — so a case was added.
3. **Notification insert failed on type inference.** A bare `$n` in a `SELECT`
   list has no surrounding expression to infer from, so Postgres typed the ids
   as `text` and the insert was rejected. Needs an explicit `::bigint`.
4. **The `updated_at` trigger could not be tested by watching the clock.**
   It uses `now()`, which is transaction start time, so inside one transaction a
   correct trigger produces no visible movement. The check writes a deliberately
   wrong timestamp and asserts it did not survive.
