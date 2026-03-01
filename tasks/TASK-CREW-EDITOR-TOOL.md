# Task: Crew Editor Tool (Admin)

## Goal
Enable super users (e.g., Noa) to view and edit crew member files directly from the web UI, using Claude as AI assistant — without needing a local dev environment, IDE, or git access.

## Why
Currently, editing crew members requires: local codebase + IDE + Claude Code + git + deploy. This is developer-only. The super user knows the product best and should be able to iterate on crew prompts, fields, and logic independently.

## How It Works (High Level)

```
Admin UI (chat + code viewer)
    ↓
API endpoints (read / chat / apply)
    ↓
Server file system (crew .js files)
    ↓
Hot-reload (clear require cache, re-register crew)
    ↓
Google Cloud Storage (version backups)
```

---

## Components

### 1. API Endpoints

#### `GET /api/admin/crew/:agentName/:crewName/source`
- Reads the crew member `.js` file from disk
- Returns: `{ source: string, filePath: string, lastModified: string }`

#### `POST /api/admin/crew/:agentName/:crewName/chat`
- Body: `{ messages: [...], currentSource: string }`
- Calls Anthropic Claude API server-side
- System prompt includes:
  - Current crew file content
  - AGENT_BUILDING_GUIDE.md as reference
  - Rules: keep class structure, keep imports, output full file
- Returns: `{ response: string, updatedSource?: string }`
- If Claude proposes changes, `updatedSource` contains the full updated file

#### `POST /api/admin/crew/:agentName/:crewName/apply`
- Body: `{ source: string }`
- Flow:
  1. Validate — try to compile/require the new code in a try/catch
  2. Backup — upload current version to Google Cloud Storage
  3. Write — overwrite the file on disk
  4. Hot-reload — clear require cache + re-register crew member
- Returns: `{ success: boolean, error?: string, backupVersion?: string }`

#### `GET /api/admin/crew/:agentName/:crewName/versions`
- Lists last 5 versions from Google Cloud Storage
- Returns: `{ versions: [{ timestamp, size, url }] }`

#### `POST /api/admin/crew/:agentName/:crewName/rollback`
- Body: `{ version: string }` (timestamp)
- Downloads version from GCS, applies it (same as apply flow)

### 2. Hot-Reload Mechanism

```js
function reloadCrewMember(agentName, crewName) {
  const filePath = path.resolve(`./agents/${agentName}/crew/${crewName}.crew.js`);

  // 1. Clear from Node.js require cache
  delete require.cache[require.resolve(filePath)];

  // 2. Re-require (loads updated file)
  const CrewClass = require(filePath);

  // 3. Re-register with crew service
  crewService.registerCrewMember(agentName, new CrewClass());
}
```

### 3. Version Backup (Google Cloud Storage)

- Bucket: `aspect-crew-versions` (or similar)
- Path pattern: `{agentName}/{crewName}/{timestamp}.crew.js`
- Keep last 5 versions per crew member
- Auto-cleanup: delete oldest when exceeding 5

### 4. Validation Before Apply

```js
function validateCrewSource(source, filePath) {
  try {
    const Module = require('module');
    const m = new Module(filePath);
    m._compile(source, filePath);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}
```

### 5. Frontend — Admin Crew Editor Page

#### Layout
- **Left panel**: Code viewer (read-only, syntax highlighted, shows current file)
- **Right panel**: Chat with Claude (conversation interface)
- **Top bar**: Agent selector, crew member selector, version history dropdown
- **Action bar**: "Apply Changes" button, "Rollback" dropdown, diff toggle

#### Flow
1. Noa selects agent + crew member → sees current code on the left
2. Types feedback in the chat: "The agent asks too many questions, make it one at a time"
3. Claude responds with explanation + proposed updated file
4. Noa sees a diff view (current vs proposed)
5. Clicks "Apply" → server validates, backs up, writes, reloads
6. Noa opens a test conversation with the updated crew to verify
7. If bad → clicks "Rollback" to restore previous version

#### Claude System Prompt (for the chat)

The prompt must be strict and opinionated. The user is a super user (product/domain expert), NOT a developer. Claude should act as a constrained editor that follows a clear priority order and knows when to escalate.

**Server injects dynamically:**
- `{{CURRENT_CREW_FILE}}` — the full source code of the crew file being edited
- `{{AGENT_BUILDING_GUIDE}}` — contents of `AGENT_BUILDING_GUIDE.md`, read from disk at request time

##### Draft Prompt (v1)

```
You are a crew member editor for the Aspect multi-agent platform.
Your job is to help improve how a specific AI agent crew member behaves — how it talks, what it collects, and how it transitions.
The user talking to you is a product expert who tests and refines agents. They are NOT a developer. Speak in plain, non-technical language.

===== WHAT YOU'RE EDITING =====

A "crew member" is a step in a multi-step AI agent conversation. Each crew member is defined as a Node.js file with:
- **Guidance** — the main prompt that tells the agent how to behave, what to say, and what tone to use. This is your PRIMARY edit target.
- **Fields** — data the agent collects from the user during conversation (name, phone, etc.). Each field has a name and description that tells the extraction system what to look for.
- **Transition logic** — code that decides when this step is done and the next one begins.
- **Context builder** — additional information passed to the agent at runtime.

For full technical reference, see the building guide below.

===== CURRENT CREW FILE =====

{{CURRENT_CREW_FILE}}

===== AGENT BUILDING GUIDE (reference) =====

{{AGENT_BUILDING_GUIDE}}

===== HOW TO FIX PROBLEMS — PRIORITY ORDER =====

When the user reports a problem, fix it using the FIRST approach that works.
Only move to the next level if the previous one genuinely cannot solve it.

**Level 1: Change the GUIDANCE (prompt)** ← Try this first, always
- Rewrite or adjust the guidance text
- The guidance must be flat and uniform — the same text applies to every conversation, every user
- NEVER add if/else logic, conditional sections, or dynamic placeholders inside the guidance
- Use general behavioral rules ("ask one question at a time", "keep it short") not case-specific patches ("if user says X, respond with Y")
- Most problems (tone, phrasing, flow, too many questions, wrong language) are solved here

**Level 2: Improve FIELD DESCRIPTIONS**
- If a field isn't being extracted correctly, the description probably isn't clear enough
- Make descriptions simple and self-contained
- You may add a few general examples of what values to expect, but NEVER use the user's specific failed scenario as the example — generalize
- Use type:'boolean' for yes/no fields, allowedValues for fields with a fixed set of options

**Level 3: Modify CODE (only if levels 1-2 can't solve it)**
- Transition conditions (preMessageTransfer) — when to move to the next step
- Field sequencing (getFieldsForExtraction) — which fields to show when
- Context (buildContext) — what runtime info to pass to the agent
- Keep code minimal. Avoid adding complexity.

**Level 4: ESCALATE — you cannot fix this**
Some problems are outside the scope of a single crew file. If the fix requires ANY of:
- Changes to the field extraction engine itself
- Changes to the dispatcher (the system that routes between crew members)
- Changes to the base crew class or shared infrastructure
- New tool/function implementations
- Database schema changes
- Changes to how streaming or the chat UI works
- Changes to a DIFFERENT crew member (you can only edit the current one)

Then DO NOT attempt a fix. Instead:
1. Explain to the user in simple terms why this can't be fixed from here
2. Help them phrase a clear bug report with a title and description
3. Open the bug using the bug tool

===== OUTPUT RULES =====

- When you make changes, output the COMPLETE updated file — not a partial snippet or diff
- Keep the file structure intact: the class name, imports, and exports must stay the same
- Explain what you changed and why in 1-3 simple sentences. No code jargon.
- If the user's request is vague, ask a clarifying question before making changes
- Never remove fields, methods, or transitions unless the user explicitly asks
- If the user asks for something that could break the agent, warn them and suggest a safer way
- When showing the updated file, say "here's the updated version" — not "here's the refactored class"

===== WHAT YOU CANNOT DO =====

- You cannot test the agent — suggest the user opens a test conversation after applying
- You cannot edit other crew members — only the one currently loaded
- You cannot change infrastructure, shared code, or the platform itself
- You cannot deploy — changes take effect immediately on the running server after "Apply"
```

#### Prompt Writing Principles (learned from iteration)

When Claude edits guidance prompts, it MUST follow these principles:

1. **Identity first** — The opening sentence defines WHO the agent is, not what it does. Bake the voice, tone, language, and personality into the identity. Example: "You are a warm, knowledgeable banking advisor having a conversation in Hebrew" — this naturally produces Hebrew, warm tone, no jargon, without needing separate rules for each.

2. **Describe behavior, not prohibitions** — Instead of listing "don't do X" rules for every problem, describe the desired behavior positively. "Be curious when the customer pushes back" works better than "Do NOT give up immediately. Do NOT suggest branch on first refusal."

3. **No whack-a-mole** — When fixing a problem, never just add "don't do [the thing that went wrong]". Instead, find what in the prompt is CAUSING the wrong behavior and fix that. If the agent sounds robotic, the problem isn't missing "don't be robotic" — it's that the prompt reads like a flowchart.

4. **Short and natural** — Keep guidance concise. A short, well-written prompt with clear identity produces better results than a long prompt with many rules. The model follows the tone of the prompt itself.

5. **Conversation, not flowchart** — Describe how the agent should handle situations as natural conversation behavior, not as if/then decision trees. Flowcharts produce robotic agents.

#### Bug Escalation Integration
When Claude determines the issue is outside scope (level 4), it should:
1. Explain why it can't fix it from the crew file
2. Draft a bug report: title, description, which infra component is involved
3. Submit via the bug tool (same bug system used in the agent chat)
4. Confirm to the user that the bug was opened

#### UI Requirements
- **Code panel** — collapsible side panel showing the current crew file with nice syntax highlighting. Not always open, but easy to expand whenever needed. Updates live when changes are applied
- **Export to file** — button to download the current crew file as a `.js` file to local machine (in addition to GCS backups)
- **Non-technical chat** — Claude's responses should avoid code jargon. When showing the updated file, frame it as "here's the updated version" not "here's the refactored class"

---

## Scope

### Phase 1 (MVP)
- [ ] Read endpoint (view crew source)
- [ ] Chat endpoint (Claude conversation for editing)
- [ ] Apply endpoint (validate + write + hot-reload)
- [ ] Basic admin page with code viewer + chat
- [ ] GCS backup (save before overwrite)

### Phase 2
- [ ] Diff view (before/after)
- [ ] Version history + rollback
- [ ] Syntax highlighting in code viewer
- [ ] "Test conversation" quick-link after apply

### Phase 3 (Nice to have)
- [ ] Edit history log (who changed what, when)
- [ ] Side-by-side: test conversation + editor on same page
- [ ] Batch apply across multiple crew members
- [ ] Auto-validate by running a test message through the crew after apply

---

## Risk: Deploy Overwrites

Server file changes are NOT in git. A redeploy from git will overwrite them.

Options (pick one):
1. **Manual sync** — periodically pull changes into git (simplest)
2. **Post-deploy hook** — after deploy, re-apply latest GCS version for each crew
3. **GCS as source of truth** — server always loads from GCS on startup, falls back to local file

Recommended: Option 2 or 3 for production. Option 1 is fine during development.

---

## Dependencies
- Anthropic API key (already available on server)
- Google Cloud Storage bucket + credentials (already have GCP setup for Cloud Run)
- Admin auth (existing admin routes/middleware)
