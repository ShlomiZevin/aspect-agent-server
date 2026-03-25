# Profiler — User Profile Builder

## Overview

The Profiler is a background LLM that runs alongside conversations and builds a structured user profile in real-time. It analyzes the conversation, extracts facts, infers behavioral patterns, and produces a profile that updates live on a side panel.

The profiler is **completely decoupled** from the conversation — it never blocks the chat, never affects the response, and runs on its own schedule. The user sees a profile panel on the right side that fills up progressively as the conversation develops.

---

## How It Works

1. **User sends a message** — the conversation flows normally (crew, thinker, talker)
2. **After 5 seconds of silence** — the profiler fires in the background
3. **The profiler LLM** receives the profiler prompt + conversation history + existing profile
4. **Returns a structured JSON** with all profile fields — each with a value, confidence score, and source
5. **Low-confidence fields are filtered** — anything below 70% confidence is set to null (server-side)
6. **Profile is saved** to user-level context (persists across conversations)
7. **The panel updates** with a subtle animation

If more than 5 seconds have passed since the last profiler run and a new message arrives, the profiler fires immediately — no extra wait.

---

## Profile Structure

The profile is organized into **clusters** (groups of related fields). Each agent defines its own clusters and fields via the profiler prompt. For the banking agent, the clusters are:

| # | Cluster | Display Mode | Description |
|---|---------|-------------|-------------|
| 1 | Identity & Eligibility | Fields | Name, age, city, account type, KYC status |
| 2 | Financial Status | Fields | Employment, income, commitments, bank details |
| 3 | Behavior & Intent | Fields | Inferred insights — goal, literacy, sensitivity |
| 4 | Personal Context | Tags | Only appears when evidence exists |
| 5 | Account Progress | Fields | Process status, blockers, risk, next action |
| 6 | Recommendations | Tags | Only when process is near completion |
| 7 | Profile Summary | Summary | Narrative overview + potential index |

**Display modes:**
- **Fields** — shows all fields, filled or empty (empty ones show a dash)
- **Tags** — only shows fields that have values (as colored chips)
- **Summary** — special narrative rendering with traits and a potential bar

---

## Depth & Scoring

The profile panel shows an **overall depth percentage** and a **tier label**:

| Range | Tier |
|-------|------|
| 0–25% | פרופיל בסיסי |
| 26–50% | פרופיל פונקציונאלי |
| 51–75% | פרופיל תובנות מוכן |
| 76–100% | פרופיל פרסונליזציה מלא |

Depth is calculated as a weighted average of filled fields per cluster. Each cluster has a weight that determines its contribution to the overall score. Clusters with weight 0 (like summary) are excluded.

---

## Field Confidence & Badges

Each field has:
- **Confidence** (0–100) — how certain the profiler is about the value. Fields below 70 are filtered out server-side.
- **Source badge:**
  - **לקוח** (user) — explicitly stated by the user
  - **מערכת** (system/inferred) — derived from behavior or context
  - **חיצוני** (external) — from external tools or knowledge base

---

## Profiler Configuration

### Agent-Level Config

Each agent has a `profiler.config.js` file in its folder:

```
agents/banking-onboarder-v2/profiler.config.js
```

This file defines:
- **prompt** — the full profiler prompt with all field definitions baked in
- **model** — which LLM to use (e.g., `claude-sonnet-4-6`)
- **maxTokens** — response size limit

The prompt is the single source of truth — it defines the JSON structure the LLM should return, the fields, the rules. No schema injection or separate field definitions.

### Debug Mode (Ctrl+Shift+D)

When debug mode is active, two expandable sections appear at the top of the profile panel:

**Profiler Config:**
- View and edit the profiler prompt
- Switch provider (OpenAI / Anthropic / Google) and model
- Save changes (session-only, not persisted to DB)
- Reset to code default

**Last Response:**
- See the raw JSON the profiler returned
- Shows duration and model used (e.g., "4.2s · claude-sonnet-4-6")
- Click "View Full" for a full-screen modal view

### Fresh Start

The **"מאפס" checkbox** next to the panel title (debug mode only) controls whether the profiler starts with an empty profile or builds on the existing one from previous conversations. Default: checked (start fresh).

---

## Data Persistence

Profile data is saved at **user-level context** under the `profile_data` namespace. This means:
- The profile persists across conversations for the same user
- A returning user starts with their accumulated profile
- The profiler builds on top of what it already knows (unless "מאפס" is checked)

---

## Architecture

### Server Components

| Component | Location | Role |
|-----------|----------|------|
| ProfilerAgent | `crew/micro-agents/ProfilerAgent.js` | Runs the LLM call, returns profile JSON |
| scheduleProfiler | `server.js` | Smart debounce — 5s silence or immediate if enough time passed |
| runProfilerAsync | `server.js` | Loads data, calls profiler, filters low-confidence, saves, pushes SSE |
| profiler.config.js | `agents/{name}/profiler.config.js` | Per-agent prompt, model, and settings |

### Client Components

| Component | Location | Role |
|-----------|----------|------|
| ProfilePanel | `components/chat/ProfilePanel/` | Renders the profile clusters, fields, scores |
| ProfilerConfigEditor | Inside ProfilePanel | Debug-mode prompt/model editor |
| chatService | `services/chatService.ts` | Handles `profile_update` and `profiler_raw` SSE events |
| ChatContext | `context/ChatContext.tsx` | Stores `profileData` and `profilerLastRaw` state |

### SSE Events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `profile_update` | Server → Client | Full computed profile + scores for panel rendering |
| `profiler_raw` | Server → Client | Raw LLM response + timing (debug only) |

Both events arrive after `[DONE]` (the chat completion signal) — the client keeps reading the SSE stream until `[STREAM_END]`.

---

## Adding a Profiler to a New Agent

1. Create `agents/{your-agent}/profiler.config.js` with a prompt, model, and maxTokens
2. Define the JSON structure in the prompt — list all clusters and fields
3. Add a `profileSchema` to the client agent config (`agents/{name}.config.ts`) with matching cluster IDs and field keys
4. The profiler will automatically run for any agent that has a `profiler.config.js`

The cluster IDs and field keys in the client schema must exactly match the JSON keys in the profiler prompt.
