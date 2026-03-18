# Claude Scripts

Scripts in this folder that Claude Code uses when working on tasks. Run from the `aspect-agent-server` directory.

## Task Management

### `create-claude-kb-task.js`
Create (or re-seed) the Claude KB Files API task in the DB. Safe to re-run — updates description if already exists.

```bash
node scripts/create-claude-kb-task.js
```

### `create-task.js`
Create (or update) a task in the DB via CLI args. Safe to re-run — updates if title already exists.

```bash
node scripts/create-task.js --title "My Task" --assignee "Noa" --type "feature" --priority "high"
node scripts/create-task.js --title "Read This" --type "read" --assignee "Kosta" --opener "Shlomi" --description "<p>Content here</p>"
```

**Flags** (all optional except `--title`):
- `--title` — Task title (required)
- `--description` — HTML description
- `--status` — todo | in_progress | done (default: todo)
- `--priority` — low | medium | high | critical (default: medium)
- `--type` — task | feature | bug | idea | goal | agenda | read | test (default: task)
- `--domain` — general | freeda | banking | etc. (default: general)
- `--assignee` — Person name
- `--opener` — Who opened it (default: same as assignee)
- `--tags` — Comma-separated tags

**Special task types:**
- `read` — Opens in read-only view with "Mark as Read" button. Use for announcements.
- `test` — Regular task with test-specific features: "Tests Task" field links to the task being tested. Use the ☑ checklist button in the rich text editor to add test steps with checkboxes. Moving to Done warns if checkboxes are unchecked.

**Creating a test task — IMPORTANT:**
Test tasks MUST use real HTML `<input type="checkbox">` elements, NOT Unicode characters (☐ ☑ ✓ etc.).
The system tracks checked/unchecked state via HTML attributes and warns when moving to Done with unchecked steps.
Unicode checkboxes look similar but are just text — the system cannot detect or toggle them.

Each checklist item must follow this exact HTML structure:
```html
<div><div class="checklist-item" style="display:flex;align-items:flex-start;gap:6px;padding:2px 0;">
  <input type="checkbox" style="margin-top:3px;cursor:pointer;accent-color:#2563eb;flex-shrink:0;">
  <span>Your test step text here</span>
</div></div>
```

**Example:**
```bash
node scripts/create-task.js --title "Test crew transitions" --type "test" --assignee "Noa" --opener "Shlomi" --description "<p>Test the following:</p><div><div class='checklist-item' style='display:flex;align-items:flex-start;gap:6px;padding:2px 0;'><input type='checkbox' style='margin-top:3px;cursor:pointer;accent-color:#2563eb;flex-shrink:0;'><span>Send greeting and verify response</span></div></div><div><div class='checklist-item' style='display:flex;align-items:flex-start;gap:6px;padding:2px 0;'><input type='checkbox' style='margin-top:3px;cursor:pointer;accent-color:#2563eb;flex-shrink:0;'><span>Verify crew switches to profiler</span></div></div>"
```

**Note:** The script upserts by title — if a task with the same title exists, it updates it. For creating multiple tasks with the same title (e.g. for different assignees), use the API directly:
```bash
curl -X POST http://localhost:3000/api/tasks -H "Content-Type: application/json" -d '{"title":"...","type":"read","assignee":"Noa","opener":"Shlomi","description":"<p>...</p>"}'
```

### `read-claude-tasks.js`
Read tasks assigned to Claude from the database, with full descriptions and comments.

```bash
node scripts/read-claude-tasks.js              # in_progress tasks only (default)
node scripts/read-claude-tasks.js all          # all statuses
node scripts/read-claude-tasks.js done         # done tasks only
```

**When to use:** At the start of a session to see what needs to be done, or when the user says "check your tasks."

## Playground & Crew Configs

### `read-playground-config.js`
Read saved playground crew configurations from Google Cloud Storage. These are crew designs created by Noa in the playground UI.

```bash
node scripts/read-playground-config.js                                    # list all agents
node scripts/read-playground-config.js "Banking Onboarder V2"             # list saved configs
node scripts/read-playground-config.js "Banking Onboarder V2" <id>        # read full config
```

**When to use:** When creating or updating a crew member based on a playground design. The playground is where prompts and crew configs are tested before being committed to code.

**Output includes:** guidance prompt, thinking prompt, persona, fields, tools, KB sources, and the exported `.crew.js` file.

## Workflow

1. **Start of session:** Run `read-claude-tasks.js` to see pending tasks
2. **Creating/updating a crew:** Run `read-playground-config.js` to fetch the latest tested version from the playground
3. **Implement:** Apply changes to the crew files in `agents/` based on the playground config, adapting to current architecture patterns (imports, hooks, KB connections)
4. **Tasks reference the DB** — task descriptions and comments contain prompts, field lists, and requirements written by the team
