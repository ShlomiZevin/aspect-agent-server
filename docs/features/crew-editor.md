# Crew Editor - Edit, Version & Refine Crew Members

## What It Does

The Crew Editor is a suite of editing tools for managing crew members across the platform. Unlike the Playground (ephemeral sandbox), all changes here are **persistent and versioned**.

It consists of five editing surfaces:

| Surface | What It Edits | Storage | AI-Assisted? |
|---------|---------------|---------|--------------|
| **Crew Editor** | DB-created crew configs | `crew_members` table | No |
| **Crew Editor AI** | File-based crew source code | Disk + GCS | Yes (Claude) |
| **Prompt Editor** | Guidance prompt versions | `crew_prompts` table | No |
| **Fields Editor** | Collected fields mid-conversation | `context_data` table | No |
| **Context Editor** | User/conversation context data | `context_data` table | No |

---

## 1. Crew Editor (Database Crews)

**Component:** `CrewEditor.tsx` (517 lines)
**Route:** Dashboard panel

Edits crew members stored in the `crew_members` database table. File-based crews (source=`'file'`) are shown as **read-only** with a lock icon.

### Editable Fields

| Field | Description |
|-------|-------------|
| `displayName` | Human-readable name |
| `description` | What the crew does |
| `isDefault` | Whether this is the agent's default crew |
| `model` | GPT-5, GPT-4o, Claude, Gemini, etc. |
| `maxTokens` | Response token limit |
| `knowledgeBase` | Assigned KB (dropdown from available KBs) |
| `guidance` | Main system prompt (large textarea) |
| `transitionTo` | Target crew for transitions |
| `transitionSystemPrompt` | Prompt used during transition |

**Read-only sections:** Tools (tags), Fields to Collect (tags with descriptions), Agent Persona (shared across all crews).

### Actions

- **Save Changes** — PATCH to database, clears crew cache for immediate effect
- **Delete** — soft delete with confirmation dialog
- **Export to File** — downloads as `.crew.js` for migration to production
- **Cancel** — discards unsaved changes

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/agents/:agentName/crew-members` | Create new DB crew |
| `PATCH` | `/api/agents/:agentName/crew-members/:crewName` | Update DB crew |
| `DELETE` | `/api/agents/:agentName/crew-members/:crewName` | Soft delete DB crew |
| `GET` | `/api/agents/:agentName/crew-members/:crewName` | Get crew details |

### Database Schema (`crew_members`)

```
id, agentId, name, displayName, description, guidance, model, maxTokens,
knowledgeBase (JSONB), knowledgeBaseSources (JSONB string[]),
fieldsToCollect (JSONB), transitionTo, transitionSystemPrompt,
tools (JSONB string[]), isActive, isDefault, createdBy, createdAt, updatedAt
```

---

## 2. Crew Editor AI (File-Based Crews)

**Component:** `CrewEditorAI.tsx` (1,350 lines)
**Service:** `crew-editor.service.js` (1,175 lines)
**Route:** Dashboard panel

An AI-assisted editor for production crew files. Product experts describe changes conversationally, Claude generates updated code, and the system validates, applies, backs up, and hot-reloads — no server restart needed.

### UI Layout

```
┌──────────────────────────────────────────┐
│ [Crew Selector]  [View Mode]  [Actions]  │
├────────────────────┬─────────────────────┤
│   Code Viewer      │  Chat Interface     │
│ (current/proposed) │  (Claude + user)    │
├────────────────────┴─────────────────────┤
│ [Apply] [Export] [Discard] [Versions]    │
└──────────────────────────────────────────┘
```

### Two Modes

**Discuss Mode** (for product experts):
- Claude uses simplified language — no code, no jargon
- Conversational exploration of what to change
- Understands thinker+talker architecture
- Suggests what's changeable vs. what needs deeper work
- Model: Claude Sonnet 4.6, 2048 tokens

**Generate Mode** (full code output):
- Claude loads `AGENT_BUILDING_GUIDE.md` for context
- Outputs complete updated crew file
- Full source code visible
- Model: Claude Opus 4.6, 16384 tokens

### Typical Workflow

1. User selects a crew in the dropdown
2. Left panel shows current source code
3. User describes desired changes in chat (Discuss mode)
4. Claude asks clarifying questions, suggests approach
5. User clicks **Generate Changes**
6. Claude outputs complete updated file
7. Left panel shows proposed changes
8. User reviews, clicks **Apply** (with optional version name)
9. Server validates → writes to disk → backs up to GCS → hot-reloads

### Apply Flow (5 Steps)

1. **Validate** — syntax check via `vm.Script`
2. **Write to Disk** — `fs.writeFileSync` to crew file
3. **Backup to GCS** — timestamped version saved
4. **Set as Default** — `_default.json` marker written to GCS
5. **Hot-Reload** — clears `require()` cache, calls `crewService.reloadCrew()`

### Version Control (GCS)

```
crew-versions/{agentName}/{crewName}/
├── 2024-03-14T10-30-45-123Z.crew.js   # Timestamped versions
├── 2024-03-14T11-00-00-456Z.crew.js
├── _default.json                       # Marker: { timestamp, setAt }
└── _project.crew.js                    # Original deployed file
```

**Version Operations:**
- **List** — view all backed-up versions with timestamps
- **Set Default** — mark a version as "known-good" (writes to disk + hot-reloads)
- **Restore** — revert to a previous version (full apply flow)
- **Unset Default** — revert to original project file
- **Delete** — remove a version from GCS

**Retention:** Max 5 versions kept; oldest auto-deleted.

### Startup Sync

On server start:
1. Original deployed file captured in memory
2. `syncDefaultToDisk()` checks GCS for `_default.json` marker
3. If exists, overwrites disk with GCS version and hot-reloads
4. Enables zero-downtime deployments via GCS defaults

### Thinker+Talker Awareness

- Detects `usesThinker = true` in crew source
- Extracts `THINKING_PROMPT` constant separately
- Generate prompt explains JSON schema rules for thinking output
- Strategy brain and talking brain prompts edited as distinct concerns

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/admin/crew/:agentName/:crewName/source` | Read crew source |
| `POST` | `/api/admin/crew/:agentName/:crewName/chat` | Chat with Claude |
| `POST` | `/api/admin/crew/:agentName/:crewName/apply` | Apply changes |
| `GET` | `/api/admin/crew/:agentName/:crewName/versions` | List versions |
| `GET` | `/api/admin/crew/:agentName/:crewName/versions/default` | Get default marker |
| `DELETE` | `/api/admin/crew/:agentName/:crewName/versions/default` | Unset default |
| `GET` | `/api/admin/crew/:agentName/:crewName/versions/project` | Get original file |
| `GET` | `/api/admin/crew/:agentName/:crewName/versions/:timestamp` | Get version source |
| `POST` | `/api/admin/crew/:agentName/:crewName/versions/:timestamp/restore` | Restore version |
| `POST` | `/api/admin/crew/:agentName/:crewName/versions/:timestamp/set-default` | Set as default |
| `DELETE` | `/api/admin/crew/:agentName/:crewName/versions/:timestamp` | Delete version |

---

## 3. Prompt Editor Panel

**Component:** `PromptEditorPanel.tsx`
**Access:** Debug mode panel in chat UI

Version control for crew member **guidance/system prompts**. Each crew can have multiple prompt versions with only one active at a time.

### Features

- **Multi-provider model selection** — GPT-4o, GPT-5, o3-mini, Claude, Gemini
- **Version list** — all versions with timestamps and activation status
- **Activate** — set a version as the one used during chat
- **Save as New** — create a new version from current edits
- **Save/Update** — overwrite an existing version
- **Delete** — remove a version
- **Transition prompt editing** — separate textarea for transition system prompts

### Database Schema (`crew_prompts`)

```
id, agentId, crewMemberName, version (1, 2, 3...), name ("Added empathy guidelines"),
prompt (full text), transitionSystemPrompt, isActive (one per crew),
createdBy, createdAt, updatedAt
```

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/agents/:agentName/prompts` | List all prompts for all crews |
| `GET` | `/api/agents/:agentName/crew/:crewName/prompts` | Get all versions for a crew |
| `GET` | `/api/agents/:agentName/crew/:crewName/prompts/active` | Get active version |
| `POST` | `/api/agents/:agentName/crew/:crewName/prompts` | Create new version |
| `PATCH` | `/api/agents/:agentName/crew/:crewName/prompts/:versionId` | Update version |
| `POST` | `/api/agents/:agentName/crew/:crewName/prompts/:versionId/activate` | Activate version |
| `DELETE` | `/api/agents/:agentName/crew/:crewName/prompts/:versionId` | Delete version |

---

## 4. Fields Editor Panel

**Component:** `FieldsEditorPanel.tsx` (514 lines)
**Access:** Debug mode panel in chat UI

Real-time editing of **collected fields** during a conversation. Fields are extracted by crew members via `fieldsToCollect` and stored per-conversation.

### Features

- **Progress display** — shows current crew and "3/5 fields collected"
- **Field editing** — text inputs for each field value
- **Auto-save on blur** — individual fields save when you click away
- **Save All** — batch save all modified fields
- **Clear / Remove** — reset or delete individual fields
- **Filter & Sort** — by field name, alphabetically, or grouped by crew
- **Field definitions** — shows description hints from crew's `fieldsToCollect`

### How Fields Are Stored

Fields live in the `context_data` table with `namespace: 'fields'` at conversation level:

```json
{
  "name": "Sarah",
  "age": "52",
  "menstrual_status": "irregular"
}
```

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/conversation/:conversationId/fields` | Fetch fields + crew info |
| `PATCH` | `/api/conversation/:conversationId/fields` | Update field values |
| `DELETE` | `/api/conversation/:conversationId/fields` | Delete specific fields |

**Response includes:** `collectedFields`, `currentCrewMember`, `fieldDefinitions`, `totalFieldsToCurrentCrew` (calculated by following the `transitionTo` chain).

---

## 5. Context Editor Panel

**Component:** `ContextEditorPanel.tsx` (396 lines)
**Access:** Debug mode panel in chat UI

Inspect and edit **context data** (persistent state) at both user-level and conversation-level. This is the data written by crews via `getContext()` / `writeContext()`.

### Features

- **Two-level display:**
  - **User-Level** — persists across conversations (e.g., journey profile, preferences)
  - **Conversation-Level** — specific to one conversation (e.g., assessment state)
- **Namespace organization** — each context namespace is collapsible
- **JSON editing** — full JSON editor with validation
- **CRUD operations** — edit, save, delete, refresh per namespace

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/conversation/:conversationId/context` | Fetch all context (both levels) |
| `PATCH` | `/api/conversation/:conversationId/context/:namespace` | Update namespace |
| `DELETE` | `/api/conversation/:conversationId/context/:namespace` | Delete namespace |

**Response format:**
```json
{
  "userLevel": {
    "journey": { "stage": "profiling", "score": 75 }
  },
  "conversationLevel": {
    "assessment": { "symptoms": ["fatigue"] }
  }
}
```

---

## Crew Editor vs. Playground

| Aspect | Crew Editor | Playground |
|--------|-------------|------------|
| **Persistence** | Permanent (DB + GCS) | Ephemeral (in-memory, 2hr expiry) |
| **Versioning** | Yes (prompt versions, GCS backups) | No |
| **AI Assistance** | Yes (Claude for file-based crews) | Yes (Claude for config design) |
| **Target User** | Product experts & admins | Developers & quick experiments |
| **Hot-Reload** | Yes (no server restart) | N/A (in-memory registration) |
| **Scope** | Individual properties or full file | Entire crew config |
| **Testing** | Changes affect production crew | Isolated sandbox conversation |
| **Rollback** | Yes (version restore, unset default) | No (session is discarded) |

---

## File Structure

**Server:**
```
aspect-agent-server/
├── services/
│   ├── crew-editor.service.js         # AI chat, apply, version control (1,175 lines)
│   ├── context.service.js             # getContext/writeContext
│   └── crewMembers.service.js         # DB crew CRUD
├── crew/
│   ├── base/DynamicCrewMember.js      # Base class for DB crews
│   └── services/crew.service.js       # Crew registration, reload
├── db/schema/index.js                 # Tables: crewMembers, crewPrompts, contextData
└── server.js                          # All API endpoints
```

**Client:**
```
aspect-react-client/src/
├── components/
│   ├── dashboard/
│   │   ├── CrewEditor/CrewEditor.tsx           # DB crew editing (517 lines)
│   │   └── CrewEditorAI/CrewEditorAI.tsx       # AI file editing (1,350 lines)
│   └── chat/
│       ├── PromptEditorPanel/                  # Prompt versioning
│       ├── FieldsEditorPanel/                  # Field editing (514 lines)
│       └── ContextEditorPanel/                 # Context editing (396 lines)
├── services/
│   ├── crewEditorService.ts                    # AI editor API (284 lines)
│   ├── promptService.ts                        # Prompt version API (138 lines)
│   ├── contextService.ts                       # Context CRUD API (65 lines)
│   └── fieldsService.ts                        # Fields CRUD API (67 lines)
└── types/
    ├── crew.ts                                 # Crew type definitions (256 lines)
    └── promptEditor.ts                         # Prompt editor types
```
