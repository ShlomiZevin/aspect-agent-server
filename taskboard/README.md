# Aspect Task Board

Our own task board. Separate tool, separate database.

## Why it exists

The board in `agents_platform_db` was built for LYBI — full coverage for Noa and
Hodaya. Shlomi asked for a second, lighter board for us, with the separation
being physical rather than a filter:

> i dont want rules i want different tools
> Even if its the same code which we have the saparation must be 100%

A shared table with a `board` column was built first and rejected for exactly
that reason. The important consequence: **there is no query in this folder that
can reach LYBI's board**, because the connection here does not open that
database. Nothing can be got wrong by setting a flag incorrectly.

## Layout

| Path | What it is |
|---|---|
| `db/connection.js` | Own pool to `aspect_tasks_db`. Not `services/db.pg`. |
| `db/schema.js` | Drizzle tables. The migration is the source of truth. |
| `db/migrations/001_init.sql` | Schema, constraints, indexes, triggers. |
| `db/migrations/run-001-init.js` | Applies it. Sends the file whole — see below. |
| `db/migrations/verify-001-schema.js` | Proves the constraints reject what they claim to. |
| `services/tasks.service.js` | Task reads and writes, What's New. |
| `services/comments.service.js` | Comments, likes, needs-attention, notifications. |
| `services/people.service.js` | Roster and the notification bell. |
| `services/events.service.js` | SSE broadcast. |
| `routes/taskboard.routes.js` | `/api/taskboard/*`, mounted with one line in `server.js`. |

## Three databases now, and the naming is still misleading

The root `CLAUDE.md` warns that this repo has two databases whose names mislead.
There are three:

- `services/db.pg` → `agents_platform_db` — the platform, **and LYBI's board**.
- `services/db.zer4u` → `zer4u_db` — customer data, one schema per dataset.
- `taskboard/db/connection` → `aspect_tasks_db` — **this board, and nothing else**.

If you are writing a task query and reaching for `services/db.pg`, you are in the
wrong board.

## Rebuilt, not copied

Same features, different model. Three things the old board got wrong:

**JSONB arrays used as sets.** `liked_by`, `linked_tasks`, `deployed_reviewed_by`
and `deployed_email_sent_to` were arrays inside a JSONB column. Postgres cannot
index a membership test written that way, so What's New and needs-attention both
read every row and filtered in JavaScript — on endpoints polled every 10 seconds
per open tab. That is what hit the statement timeout in production. They are
`comment_likes`, `task_links` and `task_acks` here, with indexes.

**Foreign keys with no `ON DELETE`.** Deleting a task either failed on its
comments or orphaned its notifications. Everything cascades from the task now,
and there is a check that proves it.

**`is_completed` next to `status`.** Two columns that both looked like "done".
It never meant done — it meant *acknowledged*, for `read` tasks. It is called
`acknowledged`.

## Running the migration

```bash
cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
node taskboard/db/migrations/run-001-init.js
```

The database itself must exist first (`CREATE DATABASE aspect_tasks_db`) — that
cannot be done from a connection to the database being created.

The runner sends the `.sql` file **whole** rather than splitting on semicolons,
unlike the older runners in `db/migrations/`. It has to: the `touch_updated_at`
function body is a `$$`-quoted block containing its own semicolons, and naive
splitting tears it in half. Sending it whole also makes the migration atomic.

## Verification

See `verification/taskboard/README.md`. Two suites, 46 checks, both self-cleaning.

## Not done yet

- The client. `/api/taskboard/*` has no UI; the existing board still talks to
  `/api/tasks` in the platform DB.
- The Aspect Module descriptor, so the board can be switched on per client.
- Auth. Anyone who can reach the endpoint can act as any name — the same trust
  model the old board has. That changes with the Google-auth work.
