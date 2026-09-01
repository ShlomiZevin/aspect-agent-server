# Working the Aspect task board (Claude's cheat sheet)

Everything needed to read status from, and create tasks on, **the Aspect board**
— the empty one, the new one, the one Kosta uses. Written so a fresh session can
pick it up without relearning any of it.

## Rule zero: there are two boards, and this is the other one

| | **THIS board** | The LYBI board |
|---|---|---|
| Database | `aspect_tasks_db` | `agents_platform_db` |
| API | `/api/taskboard/*` | `/api/tasks/*` |
| Server code | `taskboard/` | `services/task.service.js` |
| Client code | `src/taskboard/` | `src/components/tasks/` |
| URL | `/zolstock/taskboard` | `Ctrl+Shift+Space` anywhere |
| Size (2026-09-01) | 1 task | 611 tasks |

The separation is **physical, not a filter** — see `taskboard/README.md`. If a
query is reaching `services/db.pg` or `/api/tasks`, it is on the wrong board.

> **Never touch the LYBI board unless asked for it by name.** It holds live work
> for Noa and Hodaya. Everything below is the Aspect board only.

## The fastest way in: the live API

The production server answers without auth, so no local server and no proxy are
needed. This is the preferred path — it validates input, emits the SSE event the
open browser tabs listen to, and cannot hit the wrong database.

```bash
BOARD=https://aspect-agent-server-1018338671074.europe-west1.run.app/api/taskboard
```

### Read

```bash
curl -s "$BOARD/tasks"                      # everything
curl -s "$BOARD/tasks?openOnly=true"        # status <> 'done'
curl -s "$BOARD/tasks?assignee=Kosta"
curl -s "$BOARD/tasks?status=in_progress"
curl -s "$BOARD/tasks/53"                   # one task, with comments-free detail
curl -s "$BOARD/tasks/53/comments"
curl -s "$BOARD/people"                     # the roster
```

Filters accepted by `GET /tasks`: `status`, `assignee`, `type`, `priority`,
`tag`, `openOnly`. Anything else is ignored.

### Create

```bash
curl -s -X POST "$BOARD/tasks" -H 'Content-Type: application/json' -d '{
  "title": "Short imperative title",
  "description": "What needs doing and how we will know it is done.",
  "type": "task",
  "priority": "high",
  "assignee": "Kosta",
  "opener": "Shlomi",
  "status": "todo"
}'
```

Only `title` is required. Everything else has a default.

### Update / delete

```bash
curl -s -X PATCH "$BOARD/tasks/53" -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}'
curl -s -X DELETE "$BOARD/tasks/53"          # cascades to comments, links, acks
curl -s -X POST "$BOARD/tasks/53/comments" -H 'Content-Type: application/json' \
  -d '{"author":"Shlomi","body":"..."}'
```

## The fields, and what may go in them

Writable: `title` `description` `status` `priority` `type` `assignee` `opener`
`dueDate` `tags` `atRisk` `acknowledged` `isDraft` `dependsOn`
`linkedTaskIds`. Anything else in the body is dropped, not trusted.

| Field | Values / rules |
|---|---|
| `status` | `todo` · `in_progress` · `done` — default `todo` |
| `priority` | `low` · `medium` · `high` · `critical` — default `medium` |
| `type` | `task` · `bug` · `feature` · `idea` · `goal` · `agenda` · `read` · `test` — default `task` |
| `title` | required, trimmed, ≤255 chars |
| `assignee` / `opener` | free text, but use a roster name |
| `dueDate` | `YYYY-MM-DD` or null |
| `tags` | array of strings, de-duplicated server-side |
| `dependsOn` | another task id; a task may not depend on itself |
| `acknowledged` | **not** "done". It means *seen*, and only matters for `read` tasks. |

Bad values come back as a 400 with a sentence (`priority must be one of: …`),
not a Postgres error. The CHECK constraints are still the real guarantee.

## The roster

Three people, in `people`:

```
Kosta · Shlomi · Vladimir
```

`POST /people {"name":"…"}` adds one. Note the existing task was opened by
**"Konstantin"**, which is not on the roster — the board allows free-typed names
(`allowGuestNames: true`). Prefer the roster spelling **Kosta** so filtering by
assignee actually groups.

## Direct SQL, when the API will not do

Only for reading something the API does not expose, or when the server is down.
It skips validation and does not emit the SSE event, so open tabs will not
refresh until reloaded.

```js
require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  database: process.env.TASKS_DB_NAME || 'aspect_tasks_db',
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10), max: 2,
});
```

Run it from `aspect-agent-server/` so `.env` is picked up. Tables:
`tasks` `task_comments` `comment_likes` `task_links` `task_acks`
`notifications` `people`.

Two column names differ from the LYBI board and will break a copied query:
there is **no `domain`** column, and completion is `status`, never
`is_completed`. `people` has **no `id`** — `name` is the key.

## Gotchas worth carrying between sessions

**The module is currently `degraded`, so the screen is off.** `client_modules`
row 515 (`zolstock` / `taskboard`) is `enabled: true` but `status: 'degraded'`,
set by `nightly-build` on 2026-09-01 00:04. `getLiveModules()` needs
`enabled AND status = 'ready'`, so `/api/modules/zolstock` does not list the
board and `/zolstock/taskboard` renders "Task board is not enabled here".
The API is unaffected. `taskboard` is an `app` module with no `nightlyBuild`
hook, so the nightly run should not have been able to touch it at all — treat
this as a bug, not a setting, and confirm before flipping it back.

**The board deliberately has no chat tool.** Unlike Replenishment, this module
registers no `chatTools` and no `manifestFragment`, so the ZolStock agent cannot
read or mention tasks. That is on purpose: task notes are internal, and the
separate database exists to keep them away from a client's chat agent. Do not
"helpfully" wire it in.

**No comments unless asked.** Status changes go on the task. Do not narrate
progress in `task_comments` — same convention as the other board.

**One task at a time.** Create or update what was asked for, report back, stop.
Do not batch a list of inferred follow-ups.

**Write the task Shlomi described, not the task you would write.** Translate to
English and make the wording clearer; complete a sentence that is incomplete.
Add nothing else — no implementation guidance, no suggested approach, no
acceptance criteria, no file or table references he did not mention, no
background he did not give. His words: *"don't dig. Stick to what I write, just
phrase it more clearly and complete it, but don't add things."* Show him the
English wording before opening it.

**Hebrew in a task body needs a file, not `-d`.** A task title or description
containing Hebrew sent as `curl -d '{...}'` from Git Bash arrives as mojibake and
is stored that way — it is not a display problem, it round-trips broken. Write
the JSON with Python and post it as bytes:

```bash
python -c "
import json, io
body = {'title': '...', 'description': '...'}
io.open('body.json','wb').write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
"
curl -s -X POST "$BOARD/tasks" -H 'Content-Type: application/json; charset=utf-8'   --data-binary @body.json
```

Always read the task back afterwards and check the Hebrew survived. This hit
task #60 and had to be repaired with a PATCH.

**Check before creating.** `GET /tasks?openOnly=true` first; the board is small
enough that a duplicate is obvious and embarrassing.

## Source of truth, if this file goes stale

- `taskboard/README.md` — why the board exists and how it is built
- `taskboard/routes/taskboard.routes.js` — the endpoint list, in a header comment
- `taskboard/services/tasks.service.js` — `WRITABLE`, `STATUSES`, `PRIORITIES`, `TYPES`
- `taskboard/db/migrations/001_init.sql` — the constraints that actually bind
- `modules/taskboard/module.js` — why it is an `app` module and what it refuses to do
