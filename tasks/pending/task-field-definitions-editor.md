# Editable Field Definitions in Debug Mode (Prompt Editor Panel)

## Overview

Add the ability to edit field definitions (name + description) for crew members directly from the PromptEditorPanel debug panel. Field definitions control what the fields extractor attempts to extract from user messages. Currently, these definitions are hardcoded in crew `.crew.js` files and cannot be changed without a code deploy. This feature enables real-time iteration on field definitions through the same versioning system used for guidance, persona, KB sources, and thinking prompts.

## Current State

### How Fields Work Today

1. **Definition**: Each crew member defines `fieldsToCollect` as an array of `{ name, description }` objects in its constructor (e.g., `advisor.crew.js`).

2. **Shared fields**: Agent-level shared fields are defined in a persona file via `getSharedFields()`. The `CrewService._mergeSharedFields()` method appends these to every crew's `fieldsToCollect` with `{ shared: true }`.

3. **Extraction**: The dispatcher checks `crew.fieldsToCollect.length > 0` to decide whether to run the fields extractor in parallel. The extractor receives `fieldsToCollect` and uses the `description` to understand what to look for.

4. **Override chain for guidance**: Session override > DB active version > Code default. Resolved in `dispatcher.service.js` `_streamCrewFull()`.

5. **No override chain for fields**: `fieldsToCollect` is always read from the crew instance. There is no DB column, no session override, and no version storage for field definitions.

6. **FieldsEditorPanel**: Shows collected field **values** (the data extracted from conversation). Allows editing/clearing collected values. Does NOT allow editing field definitions (name/description).

7. **PromptEditorPanel**: Currently manages guidance, persona, thinking prompt, KB sources, model/provider, and transition system prompt. Each follows the same pattern: session override > DB version > code default, with dirty flag + OVERRIDE badge.

## Proposed Changes

### 1. Database: Add `fieldDefinitions` Column

Add a new JSONB column to the `crew_prompts` table:

```sql
ALTER TABLE crew_prompts ADD COLUMN field_definitions JSONB;
```

- `null` means "use code default" (same convention as `persona`, `kbSources`, etc.)
- When set, contains the full array of field definitions for the crew member
- Shared fields stored with `shared: true` flag so the UI can distinguish them

### 2. Server Changes

#### 2.1 Schema (`db/schema/index.js`)

Add `fieldDefinitions` column to `crewPrompts` table:

```js
fieldDefinitions: jsonb('field_definitions'),
```

#### 2.2 Prompt Service (`services/prompt.service.js`)

- Add `fieldDefinitions` to all SELECT projections in `getPromptVersions()`, `getActivePrompt()`, `getAllCrewPrompts()`
- Add `fieldDefinitions` to destructured options in `createPromptVersion()` and `updatePromptVersion()`
- Apply the same `if (fieldDefinitions !== undefined)` guard pattern used for other optional fields

#### 2.3 Server Endpoints (`server.js`)

- **GET `/api/agents/:agentName/prompts`**: Include `fieldDefinitions` in each version. For v0, include `crewMember.fieldsToCollect` so client can display code defaults
- **POST create / PATCH update**: Accept `fieldDefinitions` in request body, pass through

#### 2.4 Dispatcher Resolution (`crew/services/dispatcher.service.js`)

Add field definitions resolution in `_streamCrewFull()`:

```
Priority: 1. Session override (fieldsOverrides[crew.name])
          2. DB active version (dbPrompt.fieldDefinitions)
          3. Code default (crew.fieldsToCollect)
```

Add `fieldsOverrides = {}` to destructured params.

### 3. Client Changes

#### 3.1 Types

Add to `PromptVersion` and `SaveVersionPayload`:

```ts
fieldDefinitions?: { name: string; description: string; shared?: boolean }[];
```

#### 3.2 PromptEditorPanel

**New prop**: `onFieldsOverride: (crewMemberId: string, fields: FieldDef[]) => void`

**New state**:
```ts
const [fieldsOverrides, setFieldsOverrides] = useState<Record<string, FieldDef[]>>({});
const [originalFieldDefs, setOriginalFieldDefs] = useState<FieldDef[]>([]);
const [showFieldsModal, setShowFieldsModal] = useState(false);
```

**Version load/save**: Integrate `fieldDefinitions` into the version load effect and both save handlers.

**Dirty detection**: Compare current field defs to original (loaded from active version or code).

#### 3.3 ChatContext / useChat Wiring

Pass `fieldsOverrides` through to the chat service SSE request body, same as `promptOverrides`, `modelOverrides`, etc.

#### 3.4 New Component: FieldDefinitionsModal

```ts
interface FieldDefinitionsModalProps {
  fields: FieldDef[];
  onChange: (fields: FieldDef[]) => void;
  onClose: () => void;
}
```

## UI/UX Design

### Location in PromptEditorPanel

```
Prompt Editor Panel
├── Crew Member Selector
├── Versions (collapsible)
├── Model (collapsible)
├── Knowledge Bases (collapsible)
├── Prompting (collapsible, default open)
│   ├── Agent Persona          [OVERRIDE badge]  [expand]
│   ├── Guidance               [OVERRIDE badge]  [expand]
│   ├── Thinking Prompt        [OVERRIDE badge]  [expand]
│   ├── Field Definitions      [OVERRIDE badge]  [expand]  ← NEW
│   ├── Transition System Msg  [SET badge]
│   └── Transition Logic       [modal button]
└── Status bar
```

### Inline Summary (collapsed)

```
┌─────────────────────────────────────────────┐
│ Field Definitions   OVERRIDE   [↗ expand]   │
├─────────────────────────────────────────────┤
│ 14 fields (9 crew + 5 shared)               │
│                                             │
│ ┌─ Crew Fields ──────────────────────────┐  │
│ │ userIntent · employment · income · ... │  │
│ └────────────────────────────────────────┘  │
│ ┌─ Shared Fields ────────────────────────┐  │
│ │ current_bank · life_stage · ...        │  │
│ └────────────────────────────────────────┘  │
│                                             │
│ [Revert]                                    │
└─────────────────────────────────────────────┘
```

### Modal Editor (expanded)

```
┌──────────────────────────────────────────────────┐
│  Field Definitions — advisor          [X close]  │
├──────────────────────────────────────────────────┤
│                                                  │
│  Crew-Specific Fields (9)                        │
│  ┌──────────────┬──────────────────────┬───┐     │
│  │ Name         │ Description          │   │     │
│  ├──────────────┼──────────────────────┼───┤     │
│  │ [userIntent] │ [Reason for opening] │ ✕ │     │
│  │ [employment] │ [Employment status]  │ ✕ │     │
│  │ [incomeRang] │ [Approximate income] │ ✕ │     │
│  └──────────────┴──────────────────────┴───┘     │
│  [+ Add Field]                                   │
│                                                  │
│  Shared Fields (5)                    [shared]   │
│  ┌──────────────┬──────────────────────┬───┐     │
│  │ [current_ban]│ [Current bank name]  │ ✕ │     │
│  │ [life_stage] │ [Life stage]         │ ✕ │     │
│  └──────────────┴──────────────────────┴───┘     │
│  [+ Add Shared Field]                            │
│                                                  │
│  [Apply]                          [Cancel]       │
└──────────────────────────────────────────────────┘
```

## Integration with Existing Versioning System

| Aspect | How It Works |
|--------|-------------|
| **Storage** | `field_definitions` JSONB column on `crew_prompts` table |
| **Code default** | `crew.fieldsToCollect` from `.crew.js` + shared fields merged by `CrewService` |
| **DB override** | Active `crew_prompts` row with `field_definitions` set (non-null) |
| **Session override** | `fieldsOverrides[crewName]` passed in SSE request, applied in dispatcher |
| **Version switching** | Selecting a version loads its `fieldDefinitions` (or falls back to code default if null) |
| **Save** | `fieldDefinitions` included in create/update payload |
| **Revert to Code** | Deactivates all DB versions; dispatcher uses code `fieldsToCollect` |
| **Dirty flag** | Compares current field defs to original (loaded version or code) |
| **OVERRIDE badge** | Shown when `isFieldsDirty` is true |

### Null Semantics

- `fieldDefinitions: null` → use code default
- `fieldDefinitions: []` → explicitly disable extraction (zero fields)
- `fieldDefinitions: [...]` → use these specific field definitions

## Implementation Tasks

### Phase 1: Database & Server
1. Add `fieldDefinitions` JSONB column to `crewPrompts` schema + migration
2. Update prompt service: all SELECT/create/update methods
3. Update API endpoints: accept and return `fieldDefinitions`
4. Update dispatcher: add fields resolution chain (session > DB > code)

### Phase 2: Client Types & Services
5. Add `fieldDefinitions` to `PromptVersion` and `SaveVersionPayload` types
6. Add `fieldsOverrides` to SSE request body in chatService

### Phase 3: PromptEditorPanel Integration
7. Add `onFieldsOverride` prop and state management
8. Integrate into version load effect and save handlers
9. Add dirty detection and OVERRIDE badge
10. Add inline summary sub-section with field chips

### Phase 4: Modal Editor
11. Create `FieldDefinitionsModal` component
12. Editable table: name + description per field
13. Add/remove fields, shared field distinction
14. Apply/Cancel actions

### Phase 5: Wiring
15. Wire `onFieldsOverride` from page/context level
16. Pass `fieldsOverrides` through chat service to server

### Critical Files
- `aspect-agent-server/db/schema/index.js` — add column
- `aspect-agent-server/services/prompt.service.js` — add to queries
- `aspect-agent-server/crew/services/dispatcher.service.js` — resolution chain
- `aspect-agent-server/server.js` — API endpoints
- `aspect-react-client/src/components/chat/PromptEditorPanel/PromptEditorPanel.tsx` — UI + state
- `aspect-react-client/src/services/chatService.ts` — SSE request body
