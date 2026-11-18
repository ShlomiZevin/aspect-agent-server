---
name: lybi-task-board
description: How to work with the LYBI task board (tasks, bugs, Done, What changed, release). Use whenever you pick up, finish, or report on a board task — "task #NNN", "the board", "mark done", "what changed", "release", "deploy task".
---

# LYBI task board — how we work

The board lives on **Lybi Staging** (moved from Origin on 2026-11-01: all tasks, comments,
notifications and What's New watermarks copied, ids kept). Site: https://lybi-staging.web.app/tasks.
The old copy on Origin (lybi.ai/tasks) is no longer the board — never read or write it.
It is **not** the Aspect board (`/api/taskboard`, `aspect_tasks_db`) — never touch that one from here.

```bash
BOARD=https://lybi-server-700084613835.me-west1.run.app/api
```

## The flow — three steps, one owner each

| Step | Owner | What happens |
|---|---|---|
| **1. Done** | The task's assignee (Claude for tasks assigned to Claude) | Move to `done` and fill **What changed** + the **headline** |
| **2. Release** | Shlomi only | His Release button marks what shipped as deployed → everyone gets it in the What's New popup |
| **3. Close** | Noa (the reviewer) | "Works" closes the task · "Not yet" reopens it with a reason |

## When you (Claude) finish a task

1. Move it to `done` **and** fill both texts **in the same call**:
   ```bash
   curl -s -X PATCH "$BOARD/tasks/837" -H 'Content-Type: application/json' -d '{
     "status": "done",
     "whatsNewHeadline": "…",
     "whatChanged": "מה השתנה: …\nמה לבדוק: …",
     "updatedBy": "Claude"
   }'
   ```
2. **Never** mark a task deployed — releasing is Shlomi's.
3. **No comments** on tasks you handle. What changed is the only text you write.
4. One task at a time — stop after each and wait for a go.

## How to write What changed

For a non-technical reader. Hebrew. Two short lines, nothing else:

```
מה השתנה: <one sentence — what is different now, as the user sees it>
מה לבדוק: <one sentence — where to go and what to try>
```

- **Voice: always ONE person — Shlomi.** First person singular (הוספתי, תיקנתי, מצאתי, אני עוקב). Never "we", never "the team", never mention other developers.
- **Human tone, no commands, addressed to no one in particular.** Several people read it, so never speak to one reader (no "את יכולה", "תראי", "עדכני", no gendered forms). Use impersonal phrasing: "מעכשיו אפשר…", "מעכשיו תמיד יהיה אפשר…", "אפשר לפתוח…", "אשמח לעדכון…" — not "פתחי", "לחצי", "המשיכי", "תראי".
- No file names, no code words (API, endpoint, component, migration, refactor…).
- Say what the user **sees or can do**, not how it was built.
- If a bug fix: say what used to go wrong and that it no longer does.
- If only part of the task was done, say what is still missing in the first line.

## How to write the headline

One short Hebrew line, the way the user would describe the change to a colleague — same voice as What changed (Shlomi, first person when a person is implied).
It is what shows in the What's New popup. No task number, no emoji.

## Reading the board

```bash
curl -s "$BOARD/tasks/837"                 # one task
curl -s "$BOARD/tasks?assignee=Claude"     # Claude's tasks (filters: status, assignee, type, priority)
curl -s "$BOARD/tasks/837/comments"
```

Or from `aspect-agent-server/`: `node scripts/read-claude-tasks.js` (in-progress Claude tasks with comments).

Board basics:
- `status`: `todo` · `in_progress` · `done`. `isCompleted` = closed by the reviewer — never set it yourself.
- `type`: `task` · `bug` · `feature` · `idea` · `test` · `read` · `goal` · `agenda`. Goals and agenda are sidebar items, not work.
- `priority`: `low` · `medium` · `high` · `critical` · `blocker`. `blocker` = fix now: opening a task as Blocker (or raising one to it) emails Shlomi immediately and pins it to the top of the board.
- Assignee `Limbo` = parked. `domain` is almost always `general`; it does not separate products — read the task.
- Prefer the API over direct SQL: it notifies people and refreshes open boards.
