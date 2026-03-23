# Profiler Tool — Feature Plan

## Overview

A **generic, async background LLM** that runs after each user message to build a structured user profile. Completely decoupled from the conversation flow — never blocks streaming, never affects the talker or thinker pipeline.

The profiler observes the conversation and progressively enriches a structured profile (clusters, fields, tags, scores) that is:
1. Displayed in a real-time **Profile Panel** on the client
2. Persisted to the **context system** (user-level) so it accumulates across conversations and crews/thinkers can leverage it
3. Domain-agnostic — each agent defines its own profile schema and can override the profiler prompt

---

## Decisions (Resolved)

| Question | Decision |
|----------|----------|
| Prompt structure | One generic prompt. Agent can **fully replace** it with its own override |
| Prompt editing location | On the **Profile Panel** itself (debug mode), NOT in PromptEditorPanel |
| Schema location | Per-agent, defined in agent config. **Editable at runtime** via debug/admin |
| Profile data scope | **User-level** — persists across conversations |
| Profiler frequency | After **every user message** |
| Profile panel loading state | None — panel never "loads". It simply receives updates whenever the profiler finishes |
| Profiler input | Conversation history + existing profile. Thinker output (`advisor_state`) NOT included initially — can be added later |
| Merge strategy | **Delta-based** — profiler only outputs changed/new fields per run, not the full profile. Merges into existing. Fields can be updated with good reason, but not recalculated from scratch every message |
| Verbal summary (Cluster 7) | Profiler generates it as part of its JSON output — a narrative summary section rendered as a special cluster |
| Recommendations (Clusters 5 & 6) | Profiler handles these — not the thinker |
| Hebrew/RTL | Full support. Direction comes from language chooser (existing system). All labels, values, cluster names respect RTL/LTR |
| Context integration | Profiler writes to `profile_data` context (user-level). Crews/thinkers can read it on demand |
| Fields ↔ Screen connection | Profile schema fields drive both what the profiler extracts AND what the panel renders. Single source of truth — to be designed further |

---

## Architecture

### Position in the System

```
User Message
    │
    ├──► Dispatcher (sync) ──► Crew/Thinker/Talker ──► SSE Stream ──► Client
    │
    └──► Profiler (async, fire-and-forget)
              │
              ├──► LLM call (profiler prompt + conversation + existing profile)
              │
              ├──► Write to context: `profile_data` namespace (user-level)
              │
              └──► Push SSE event: `profile_update` ──► ProfilePanel updates
```

**Key principle:** The profiler is a parallel pipeline. It does NOT run inside the dispatcher, does NOT block streaming, and does NOT affect crew transitions.

### New Micro-Agent: `ProfilerAgent.js`

Lives in `crew/micro-agents/ProfilerAgent.js` alongside `ThinkingAdvisorAgent.js` and `FieldsExtractorAgent.js`.

```
crew/micro-agents/
├── ThinkingAdvisorAgent.js    # Existing — strategic advice for crews
├── FieldsExtractorAgent.js    # Existing — field extraction for crews
└── ProfilerAgent.js           # NEW — async profile enrichment
```

### Why a New Micro-Agent (Not Reusing Thinker)

| Concern | Thinker | Profiler |
|---------|---------|----------|
| Timing | Runs before talker, blocks response | Runs after dispatch starts, never blocks |
| Scope | Per-crew, crew-specific prompt | Per-agent, agent-wide prompt |
| Output | Strategy/routing JSON | Profile data JSON (clusters, fields, scores, summary) |
| Lifecycle | Tied to crew transitions | Runs regardless of which crew is active |
| Persistence | `{crew}_state` context (conversation-level) | `profile_data` context (user-level) |

---

## Components

### 1. Server: `ProfilerAgent.js` (Micro-Agent)

**Responsibility:** Run the profiler LLM and return structured profile deltas.

**Input:**
- `profilerPrompt` — System prompt (agent's full override OR generic default)
- `profileSchema` — The cluster/field definitions the profiler should populate
- `conversationHistory` — Recent messages from current conversation
- `existingProfile` — Current `profile_data` from context (user-level, accumulated across conversations)

**Output:** Delta-based JSON — only fields that changed or were newly discovered:
```json
{
  "_profilerDescription": "Learned employment and income range from advisor conversation",
  "deltas": {
    "identity": {
      "fields": {
        "age": { "value": "28", "confidence": 90, "source": "user" }
      }
    },
    "financial_status": {
      "fields": {
        "employment": { "value": "הייטק", "confidence": 80, "source": "user" },
        "incomeRange": { "value": "15,000-25,000", "confidence": 60, "source": "inferred" }
      }
    }
  },
  "summary": {
    "overview": "דוד, בן 28, עובד בהייטק. מחפש לפתוח חשבון עו\"ש ראשי...",
    "keyTraits": ["צעיר בתחילת דרך פיננסית", "הכנסה יציבה בינונית-גבוהה"],
    "potentialIndex": 72,
    "recommendedAction": "להציע חבילת פלוס עם כרטיס אשראי מותאם"
  }
}
```

**Key behavior:**
- Only outputs **deltas** — fields that are new or changed based on the latest exchange
- Does NOT recalculate the entire profile from scratch each message
- The prompt instructs the LLM: "Focus on what's new in the latest messages. Only output fields where you have new evidence."

**Model:** Configurable per agent. Default: `gpt-4o-mini` (fast, cheap — runs every message).

### 2. Server: Profiler Trigger in `dispatcher.service.js`

At the start of `dispatch()`, after resolving the crew but **before** streaming begins, fire the profiler as a detached async operation:

```js
// Inside dispatch(), early — fire and forget
this._runProfilerAsync(params, crew);
```

The `_runProfilerAsync` method:
1. Checks if agent has profiler enabled (has a profile schema)
2. Loads conversation history
3. Loads existing `profile_data` from context (user-level)
4. Resolves the profiler prompt (DB override > agent override > generic default)
5. Loads the profile schema from agent config
6. Calls `profilerAgent.run(...)`
7. **Merges deltas** into existing `profile_data` and writes back (user-level context)
8. Computes cluster depths and overall depth/tier from merged data
9. Sends SSE `profile_update` event to client with full computed profile

**Important:** This is `async` but NOT `await`ed. Errors are caught and logged, never propagated to the conversation.

### 3. Server: SSE Event for Profile Updates

New SSE event type pushed to the client when the profiler completes:

```json
{
  "type": "profile_update",
  "data": {
    "clusters": {
      "identity": {
        "depth": 85,
        "fields": {
          "name": { "value": "דוד", "confidence": 95, "source": "user", "updatedNow": true },
          "age": { "value": "28", "confidence": 90, "source": "user", "updatedNow": false }
        }
      }
    },
    "summary": {
      "overview": "...",
      "keyTraits": ["..."],
      "potentialIndex": 72,
      "recommendedAction": "..."
    },
    "overallDepth": 35,
    "overallConfidence": 72,
    "profileTier": "functional"
  }
}
```

The `updatedNow` flag is computed server-side by comparing the delta keys against the existing profile. The client uses this for field highlight animations.

**Implementation:** The dispatcher already has a `sendCallback` (used by thinking service for step events). The profiler will use the same callback to push the `profile_update` event after it completes.

### 4. Server: Profiler Prompt Resolution

**Resolution order:**
1. DB override (active version for this agent) — highest priority
2. Agent code default (`profilerPrompt` in agent config) — if no DB override
3. Generic fallback (built into ProfilerAgent) — if agent doesn't define one

When an agent provides a prompt, it **fully replaces** the generic one. It is the agent author's responsibility to include all necessary instructions.

**Endpoints (new):**
```
GET    /api/agents/:agentName/profiler/config     — Get current profiler config (prompt + model + schema)
PATCH  /api/agents/:agentName/profiler/config     — Update profiler prompt and/or model
POST   /api/agents/:agentName/profiler/config/reset — Revert to code default
```

### 5. Profiler Prompt

Since the agent can fully override, the generic prompt serves as a solid default:

```
You are a profile enrichment engine. You analyze conversation messages and build a structured user profile.

You receive:
- The profile schema (clusters and fields to populate)
- The existing profile (what was collected so far)
- Recent conversation messages

Your job:
- Analyze ONLY the latest messages for NEW information
- Output ONLY fields that are new or have meaningfully changed
- Do NOT recalculate fields that haven't changed
- Do NOT output fields where you have no evidence

For each field you output:
- value: the extracted or inferred value
- confidence: 0-100 (explicit statement: 90+, strong inference: 60-89, weak inference: 30-59)
- source: "user" (explicitly stated), "inferred" (derived from context), "external" (from tools/KB)

For the summary section:
- overview: 2-3 sentence narrative of the current profile state
- keyTraits: array of key characteristics identified so far
- potentialIndex: 0-100 score of the user's potential/value
- recommendedAction: single most important next step

Respond ONLY with valid JSON. No markdown, no explanation.
```

An agent like banking-onboarder-v2 would provide its own prompt that includes domain-specific instructions (banking terminology, what clusters mean, Hebrew output, inference rules for financial fields, etc.).

### 6. Client: Profile Panel — Data Flow

The ProfilePanel currently reads from context and collected fields. With the profiler, it shifts to a simpler model:

**Before (current):** Panel resolves data from multiple sources (`context:user:*`, `context:conv:*`, `field:*`)
**After (with profiler):** Panel receives complete profile data via `profile_update` SSE events. Single source of truth.

**Changes needed:**
- `useChat.ts`: Add `profile_update` SSE event handler
- `ChatContext.tsx`: Add `profileData` state, updated when `profile_update` arrives
- `ProfilePanel.tsx`: Render from `profileData` state. Mark `updatedNow` fields with highlight animation
- On conversation load: fetch initial profile from `GET /api/conversation/:id/context` (`profile_data` namespace)

**No loading state.** The panel starts empty (or with data from a previous conversation if user-level profile exists). It receives updates silently — fields appear/update with subtle animation as the profiler completes.

### 7. Client: Profiler Prompt Editor (on Profile Panel, Debug Mode)

When debug mode is active, the Profile Panel shows an expandable section at the top:

```
┌─────────────────────────────────┐
│ ⚙ Profiler Config (debug)      │  ← collapsible, only in debug mode
│ ┌─────────────────────────────┐ │
│ │ Profiler Prompt             │ │
│ │ [textarea with current      │ │
│ │  prompt - editable]         │ │
│ ├─────────────────────────────┤ │
│ │ Model: [dropdown]           │ │
│ ├─────────────────────────────┤ │
│ │ [Save] [Reset to Default]   │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ Profile data below...           │
│ Cluster 1: זהות וזכאות          │
│ ...                             │
└─────────────────────────────────┘
```

- **Save** persists to DB (becomes the active override for this agent)
- **Reset** reverts to code default
- Session overrides apply immediately without saving to DB

---

## Profile Schema Definition

Each agent defines its profile schema in its config. This is the **single source of truth** that drives:
1. What the profiler LLM extracts (schema is injected into the prompt context)
2. What the Profile Panel renders (schema defines clusters, fields, display modes)

```typescript
// In agent config (e.g., banking-onboarder-v2.config.ts)
const profileSchema: ProfileSchema = {
  title: 'User Profile Builder',
  profilerModel: 'gpt-4o-mini',       // Optional — default model for this agent
  clusters: [
    {
      id: 'identity',
      name: 'זהות וזכאות',
      icon: '🪪',
      displayMode: 'fields',           // Show all fields (empty ones visible as placeholders)
      weight: 15,                       // Weight for overall depth calculation
      fields: [
        { key: 'name', label: 'שם' },
        { key: 'age', label: 'גיל' },
        { key: 'city', label: 'עיר מגורים' },
        { key: 'eligibility_status', label: 'סטטוס זכאות' },
        { key: 'account_type', label: 'סוג חשבון' },
        { key: 'kyc_status', label: 'סטטוס KYC' },
      ]
    },
    {
      id: 'personal_context',
      name: 'הקשר אישי והעדפות',
      icon: '🏷️',
      displayMode: 'tags',              // Only show fields that have values (tags style)
      weight: 10,
      fields: [
        { key: 'financial_life_stage', label: 'שלב חיים פיננסי' },
        { key: 'banking_experience', label: 'רמת ניסיון בנקאי' },
        { key: 'decision_pattern', label: 'דפוס קבלת החלטות' },
        { key: 'cost_sensitivity', label: 'רגישות לעלויות' },
        { key: 'financial_confidence', label: 'רמת ביטחון פיננסי' },
        { key: 'core_need', label: 'צורך מרכזי שזוהה' },
      ]
    },
    {
      id: 'summary',
      name: 'סיכום פרופיל',
      icon: '📋',
      displayMode: 'summary',           // Special rendering for verbal summary
      weight: 0,                         // Not counted in depth calculation
      fields: []                         // Content comes from summary section, not fields
    },
    // ... all 7 clusters
  ]
};
```

**Schema editability:** The schema should be editable at runtime (via debug or admin). This means:
- Schema is loaded from agent config as default
- Can be overridden in DB (same pattern as prompt overrides)
- Future: admin UI for editing schema (adding/removing fields, changing display modes)

---

## Profile Tier Mapping

Overall depth % maps to a tier label:

| Range | Tier | Hebrew |
|-------|------|--------|
| 0–25% | Basic Profile | פרופיל בסיסי |
| 26–50% | Functional Profile | פרופיל פונקציונאלי |
| 51–75% | Insight-Ready Profile | פרופיל תובנות מוכן |
| 76–100% | Full Personalization Profile | פרופיל פרסונליזציה מלא |

---

## Depth Calculation

**Per-cluster depth:**
```
clusterDepth = (fieldsWithValues / totalFieldsInCluster) * 100
```
For `tags` display mode clusters: all defined fields count, but depth is still based on how many have values.

**Overall depth:**
```
overallDepth = Σ(clusterDepth × clusterWeight) / Σ(clusterWeight)
```
Clusters with `weight: 0` (like summary) are excluded from the calculation.

**Overall confidence:**
```
overallConfidence = average(confidence of all populated fields)
```

These are computed **server-side** after merging deltas, and sent as part of the `profile_update` event.

---

## Data Flow — Full Lifecycle

```
1. User sends message
2. Dispatcher starts:
   a. Resolves crew, starts streaming (sync path)
   b. Fires _runProfilerAsync() (async, detached)
3. Conversation streams normally to client
4. Meanwhile, profiler:
   a. Loads last N messages from current conversation
   b. Loads existing profile_data from user-level context
   c. Resolves profiler prompt (DB override > agent code > generic)
   d. Injects profile schema into prompt context
   e. Calls ProfilerAgent.run() with prompt + schema + conversation + existing profile
   f. Gets delta JSON back
   g. Merges deltas into existing profile_data (field-level merge)
   h. Computes cluster depths, overall depth, tier
   i. Writes merged profile to user-level context
   j. Pushes SSE event: profile_update (full computed profile + updatedNow flags)
5. Client receives profile_update event
6. ProfilePanel re-renders — new/changed fields highlighted with animation
7. On next message, crews/thinkers can read profile_data from user-level context
```

---

## Badge Design

Fields display badges indicating data source:

| Badge | Meaning | Visual |
|-------|---------|--------|
| `user` | Explicitly stated by user | Solid accent color, person icon |
| `inferred` | Derived by profiler from context | Dashed border, lightbulb icon |
| `external` | From external source / KB / tool | Dotted border, link icon |

Badges are subtle — small colored dots or mini-icons next to the field value. Color-coded for quick scanning.

---

## Context Integration

The profiler writes to `profile_data` context at **user-level** (persists across conversations).

```js
// Profiler writes (user-level — NOT conversation-level)
await contextService.writeContext(userId, agentName, 'profile_data', mergedProfile, false);

// Any crew can read it
const profile = await this.getContext('profile_data');  // user-level by default
```

This means:
- A returning user already has a partial profile from previous conversations
- The profiler builds on top of what it already knows
- Crews/thinkers can use profile data for personalization without being coupled to the profiler

---

## RTL/Hebrew Support

- Profile Panel respects the `direction` from the language context (existing `LanguageContext`)
- All text (cluster names, field labels, field values, summary) renders in the correct direction
- Layout mirrors in RTL: close button position, text alignment, badge placement
- The profiler LLM prompt should specify output language when the agent is Hebrew-oriented
- Schema labels are already in Hebrew (defined per-agent)

---

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `aspect-agent-server/crew/micro-agents/ProfilerAgent.js` | Core profiler micro-agent — LLM call + delta output |
| `aspect-react-client/src/services/profilerService.ts` | Client service for profiler config API |
| `aspect-react-client/src/types/profiler.ts` | TypeScript types for profiler data and config |

### Modified Files
| File | Change |
|------|--------|
| `aspect-agent-server/crew/services/dispatcher.service.js` | Add `_runProfilerAsync()` fire-and-forget call at dispatch start |
| `aspect-agent-server/server.js` | Add profiler config endpoints (GET/PATCH/POST reset) |
| `aspect-react-client/src/hooks/useChat.ts` | Handle `profile_update` SSE event |
| `aspect-react-client/src/context/ChatContext.tsx` | Add `profileData` state, expose to ProfilePanel |
| `aspect-react-client/src/components/chat/ProfilePanel/ProfilePanel.tsx` | Consume profiler data via SSE events; add debug mode prompt editor section |
| Agent config files (e.g., `banking-onboarder-v2.config.ts`) | Add `profilerPrompt`, `profilerModel`, full profile schema |

### DB Storage
Reuse `prompt_versions` table with a special crew name convention (e.g., `_profiler`) to store profiler prompt overrides per agent. No new table needed.

---

## Implementation Order

### Phase 1 — Server: Core Profiler
- `ProfilerAgent.js` micro-agent with generic prompt
- Delta-based output format
- `_runProfilerAsync()` in dispatcher (fire-and-forget)
- Merge logic (deltas into existing profile)
- Write to `profile_data` user-level context
- Push `profile_update` SSE event via sendCallback
- Profiler config endpoints

### Phase 2 — Client: Profile Panel Integration
- Handle `profile_update` SSE event in `useChat`
- `profileData` state in `ChatContext`
- ProfilePanel renders from profiler data
- `updatedNow` field highlight animations
- Load existing profile on conversation open (from user-level context)

### Phase 3 — Banking-v2 Domain
- Full 7-cluster schema matching the spec (all ~60 fields)
- Domain-specific profiler prompt (Hebrew, banking terminology, inference rules)
- Summary cluster with narrative output
- Wire into `banking-onboarder-v2` agent config

### Phase 4 — Profiler Prompt Editor
- Debug-mode collapsible section on Profile Panel
- Prompt textarea + model dropdown
- Save to DB / Reset to default
- Session override (immediate, no save)

### Phase 5 — Polish & Depth Scoring
- Cluster depth bars (0-100%)
- Overall depth + tier label display
- Confidence indicators per field
- Badge icons (user / inferred / external)
- RTL layout testing
- Schema runtime editing (future)
