# Claude Scripts

Scripts in this folder that Claude Code uses when working on tasks. Run from the `aspect-agent-server` directory.

## Task Management

### `create-claude-kb-task.js`
Create (or re-seed) the Claude KB Files API task in the DB. Safe to re-run — updates description if already exists.

```bash
node scripts/create-claude-kb-task.js
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
