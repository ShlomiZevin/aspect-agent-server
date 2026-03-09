# Crew Playground - Complete Guide

## Overview

The Crew Playground is a sandbox dashboard tool where domain experts (non-technical users) can design, test, and export AI crew members without writing code. It provides two authoring modes: **Design AI** (chat with Claude to build a config) and **Manual Config** (direct editing via accordion panels). A live test chat panel on the right side of the screen connects to the real streaming infrastructure so you can try the crew immediately.

**Access:** Navigate to Dashboard, then select Playground for the agent you want to work with.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Accessing the Playground](#accessing-the-playground)
3. [Design AI Mode](#design-ai-mode)
4. [Manual Config Mode](#manual-config-mode)
5. [Thinker Mode (Strategy + Talker)](#thinker-mode-strategy--talker)
6. [Activating and Testing](#activating-and-testing)
7. [Save / Load / Export](#save--load--export)
8. [Architecture](#architecture)
9. [API Reference](#api-reference)
10. [File Locations](#file-locations)
11. [Known Limitations / Future Work](#known-limitations--future-work)
12. [Troubleshooting](#troubleshooting)
13. [Best Practices](#best-practices)

---

## Core Concepts

### What the Playground Does

The Playground lets you go from an idea to a working crew member in minutes:

1. **Design** — Describe what the crew should do (via AI chat or manual config)
2. **Activate** — Register the crew in-memory on the server
3. **Test** — Chat with the crew using the real streaming pipeline
4. **Iterate** — Tweak config, re-activate, test again
5. **Export** — Generate a production `.crew.js` file ready for deployment

### Who It Is For

- **Domain experts** who understand the business logic but do not write code
- **Developers** who want to rapidly prototype before committing to a file
- **Anyone** who wants to experiment with prompts, tools, and knowledge bases

### Key Terminology

| Term | Meaning |
|------|---------|
| **PlaygroundConfig** | The JSON object describing a crew member's behavior (mode, model, guidance, tools, etc.) |
| **Activate** | Register the config as a live, in-memory crew member on the server |
| **Design AI** | Chat mode where Claude helps you build a PlaygroundConfig |
| **Manual Config** | Direct editing of the config via collapsible accordion panels |
| **Thinker Mode** | Two-brain architecture: a strategy brain analyzes first, then a talking brain responds |
| **Mock Tool** | A tool definition with a pre-configured test response (no real backend logic) |

---

## Accessing the Playground

1. Open the **Dashboard** page for your agent
2. Click the **Playground** tab or card
3. The Playground inherits the agent's context: its name, knowledge bases, streaming endpoint, and other agent-level configuration

Each agent gets its own isolated Playground. Configs saved for one agent are not visible from another.

---

## Design AI Mode

Design AI mode lets you describe what you want in natural language. Claude acts as a crew-design assistant and produces a ready-to-use config.

### How It Works

1. **Start a conversation.** Type a description of the crew you want to build. For example:
   > "I need a crew member that helps users troubleshoot Wi-Fi issues. It should ask what router they have, check if the firmware is up to date, and walk them through a reset if needed."

2. **Claude asks clarifying questions.** Depending on the complexity, Claude may ask follow-up questions about tone, tools, knowledge base needs, edge cases, etc.

3. **Two sub-modes control Claude's behavior:**

   | Sub-mode | Behavior |
   |----------|----------|
   | **Discuss** | Lightweight back-and-forth. Claude asks questions, makes suggestions, and refines understanding. No config generated yet. |
   | **Generate** | Claude produces a full `PlaygroundConfig` JSON wrapped in a ```json code block. |

4. **Click "Generate" when ready.** This switches Claude to generate mode. Claude synthesizes everything discussed into a complete config.

5. **Auto-extraction.** The client automatically detects the ```json code block in Claude's response and extracts the `PlaygroundConfig`. The config panels update immediately.

### Tips for Design AI

- **Be specific about behavior.** "Be friendly" is vague. "Use casual language, address the user by first name, and add light humor" is actionable.
- **Mention tools explicitly.** If the crew should look things up or take actions, describe what those actions are and what data they return.
- **Describe edge cases.** "If the user asks something outside Wi-Fi troubleshooting, politely redirect them back."
- **Iterate.** You can continue chatting after a config is generated. Say "Actually, also add a tool for checking signal strength" and generate again.

---

## Manual Config Mode

Manual Config mode gives you direct control over every aspect of the crew via collapsible accordion sections. All sections can be expanded or collapsed independently.

### 1. Mode & Model

Choose the crew's operating mode and LLM model.

**Mode:**

| Mode | Description |
|------|-------------|
| **Simple** | Single LLM handles everything — reads the guidance, calls tools, responds to the user. |
| **Thinker** | Two-brain architecture. A strategy brain (thinker) analyzes first and produces structured advice. A talking brain (talker) then uses that advice to respond. See [Thinker Mode](#thinker-mode-strategy--talker). |

**Available Models:**

| Display Name | Model ID | Provider | Notes |
|-------------|----------|----------|-------|
| GPT-5 | gpt-5-chat-latest | OpenAI | Latest GPT-5 |
| GPT-4o | gpt-4o | OpenAI | Default for most crews |
| Claude Sonnet 4 | claude-sonnet-4-20250514 | Anthropic | Strong reasoning |
| Gemini 2.5 Flash | gemini-2.5-flash-preview-04-17 | Google | Fast, cost-effective |
| Gemini 2.0 Flash | gemini-2.0-flash | Google | Previous generation Flash |

### 2. Guidance

The **Guidance** field is the crew's system prompt. This is the single most important field — it defines what the crew says, how it behaves, what it knows, and what it refuses to do.

**What to include:**
- Role and purpose ("You are a Wi-Fi troubleshooting specialist...")
- Behavioral rules ("Always ask for the router model before suggesting fixes")
- Formatting preferences ("Use numbered steps for instructions")
- Boundaries ("Do not discuss topics outside networking")
- Tool usage instructions ("When the user describes a connection drop, call `check_firmware` first")

**Example:**
```
You are a Wi-Fi troubleshooting specialist. Your job is to help users resolve connectivity issues quickly and clearly.

## Rules
- Always ask for the router model and firmware version before suggesting fixes
- Use numbered steps for any multi-step instructions
- If the user's issue requires physical access to the router, say so upfront
- Do not discuss topics outside networking and Wi-Fi

## Tools
- Use `check_firmware` when you need to verify the router's firmware status
- Use `signal_test` when the user reports weak or intermittent signal
```

### 3. Thinking Prompt

**Only available in Thinker mode.**

The Thinking Prompt defines the strategy brain. It receives the conversation so far and produces structured JSON advice that the talking brain uses to craft its response.

The output must be valid JSON. If you do not include a `_thinkingDescription` field in your prompt, it is auto-injected. This field is a human-readable summary displayed in the UI's thinking indicator.

**Example:**
```
Analyze the user's message and conversation history. Return a JSON object with:

{
  "_thinkingDescription": "Brief summary of your analysis for the UI",
  "issue_category": "connectivity | speed | hardware | configuration",
  "confidence": 0.0-1.0,
  "suggested_approach": "Description of how the talker should respond",
  "tools_to_use": ["tool_name_1", "tool_name_2"],
  "escalate": false
}
```

See [Thinker Mode](#thinker-mode-strategy--talker) for more details.

### 4. Persona

An optional voice/personality overlay. This is appended to the guidance and influences tone without changing the core instructions.

**Examples:**
- "Speak like a friendly tech-savvy neighbor who happens to know everything about networking."
- "Professional and concise. No small talk. Get to the solution fast."
- "Patient and encouraging. Assume the user has zero technical background."

### 5. Knowledge Base

Select from existing vector store knowledge bases associated with this agent. Enabling a knowledge base gives the crew access to **file search (RAG)** — the LLM can search through uploaded documents to find relevant information before responding.

**How it works:**
- Each knowledge base is an OpenAI vector store with uploaded files
- When enabled, the crew's LLM calls include a `file_search` tool
- Search results appear in the thinking indicator as expandable items showing which KB files were referenced

**When to use:**
- The crew needs to reference product documentation, FAQs, or manuals
- Answers should be grounded in specific source material
- You want to see which documents informed each response

### 6. Actions (Tools)

Define mock tools the crew can call. Each tool has:

| Field | Description |
|-------|-------------|
| **Name** | Function name the LLM will call (e.g., `check_firmware`) |
| **Description** | When should the LLM use this tool? Written as an instruction. (e.g., "Call this when you need to check if the user's router firmware is up to date.") |
| **Input Parameters** | JSON Schema defining the tool's input (e.g., `{ "router_model": { "type": "string" } }`) |
| **Test Response** | The mock data returned when the LLM invokes this tool during testing. Must be a JSON object. |

**Example tool definition:**

```json
{
  "name": "check_firmware",
  "description": "Call this when you need to check if the user's router firmware is up to date. Requires the router model.",
  "parameters": {
    "router_model": {
      "type": "string",
      "description": "The model name/number of the router"
    }
  },
  "testResponse": {
    "current_version": "2.4.1",
    "latest_version": "2.5.0",
    "update_available": true,
    "release_notes": "Security patches and performance improvements"
  }
}
```

**How mock tools work:**
- The LLM sees the tool definition and decides when to call it (based on the description)
- When the LLM calls the tool, the server returns the configured `testResponse`
- The LLM then incorporates the mock data into its response
- This lets you test the full tool-calling flow without building real backend logic

### 7. Pre-loaded Knowledge (Context)

Key-value JSON pairs that represent information the crew "already knows" before the conversation starts. These are injected into the guidance as additional context.

**Use cases:**
- User profile data the crew should reference
- Session state from a previous crew member
- Configuration values the crew needs

**Example:**
```json
{
  "user_plan": "premium",
  "router_model": "Netgear Nighthawk R7000",
  "previous_tickets": 3,
  "preferred_language": "en"
}
```

These key-value pairs are merged into the system prompt so the LLM can reference them naturally in conversation.

---

## Thinker Mode (Strategy + Talker)

Thinker mode splits the crew's reasoning into two separate LLM calls, creating a "two-brain" architecture.

### How It Works

```
User Message
    │
    ▼
┌──────────────────────┐
│   Strategy Brain     │  ← Thinking Prompt + conversation history
│   (Thinker)          │  ← Default model: Claude Sonnet 4
│                      │
│   Returns structured  │
│   JSON advice        │
└──────────┬───────────┘
           │
           ▼
    ┌──────────────┐
    │  _thinkingDescription displayed in UI  │
    └──────────────┘
           │
           ▼
┌──────────────────────┐
│   Talking Brain      │  ← Guidance + advice injected as "## Current Context"
│   (Talker)           │  ← Selected model (e.g., GPT-4o)
│                      │
│   Produces the       │
│   user-facing reply  │
└──────────────────────┘
```

### Step by Step

1. **User sends a message.**
2. **Strategy brain runs first.** It receives the thinking prompt and conversation history. It returns a structured JSON object.
3. **`_thinkingDescription` is extracted.** This field provides a human-readable summary of the thinker's analysis. The UI displays it in the thinking indicator.
4. **Advice is injected into the talker's prompt.** The full JSON object from the thinker is added to the talker's system prompt under a `## Current Context` section.
5. **Talking brain runs.** It uses the guidance, persona, context, and thinker advice to produce the final user-facing response.
6. **UI flow:** The user sees a thinking indicator, then the thinking description, then the streamed response.

### When to Use Thinker Mode

- The crew needs to analyze or classify before responding
- You want structured reasoning that influences the response
- The conversation requires multi-step decision making (e.g., "Should I escalate? Which tool should I call? What tone is appropriate?")
- You want visibility into the crew's reasoning process via the thinking indicator

### When NOT to Use Thinker Mode

- Simple Q&A or FAQ-style crews
- Latency is a concern (two LLM calls instead of one)
- The crew's logic is straightforward enough for a single prompt

---

## Activating and Testing

### Activating a Config

1. Configure your crew (via Design AI or Manual Config)
2. Click the **"Activate"** button
3. The client sends the config to the server's `/api/playground/register` endpoint
4. The server creates a `DynamicCrewMember` instance and registers it with the crew service
5. The crew is now live and ready to receive messages

### What Happens on Activation

- A `DynamicCrewMember` is instantiated from your `PlaygroundConfig`
- It is registered in-memory with the crew service under a playground-specific name
- If Thinker mode is enabled, a `ThinkingAdvisorAgent` is also created for the strategy brain
- Mock tools are converted into full tool objects with handlers that return the configured test responses
- If a knowledge base is selected, the crew's `storeId` is set for file search

### Testing in the Chat Panel

The right side of the Playground contains a fully functional chat panel. It uses the **same streaming infrastructure** as production:

- **Endpoint:** `POST /api/finance-assistant/stream` (the standard streaming endpoint)
- **Override:** The request includes `overrideCrewMember` to route to the playground crew instead of the agent's normal crew
- **Full SSE streaming:** Thinking steps, knowledge base file search results, tool calls, and chunked response text all stream in real-time
- **Identical behavior:** The test chat behaves exactly as the crew would in production

### Config Changed Badge

When you modify the config after activating, an **amber "Config Changed"** badge appears. This indicates the live crew on the server no longer matches your current config. Click "Activate" again to push the updated config.

### Chat Persistence

Chat history is **not** cleared when you re-activate with a new config. This lets you compare how different configs respond to the same conversation flow. Use the **"Reset"** button to clear everything (config, chat, and session) when you want a fresh start.

---

## Save / Load / Export

### Save

Persists the current `PlaygroundConfig` to **Google Cloud Storage**. Saved configs survive server restarts and can be loaded from any browser session.

- Click **"Save"**
- Enter a name for the config
- The config is stored under the agent's namespace

### Load

Load a previously saved config from the dropdown.

- Click the **load dropdown**
- Select from the list of saved configs for this agent
- The config is loaded into all panels immediately
- You must click **"Activate"** to register it on the server

### Delete

Remove a saved config from Google Cloud Storage.

- Open the load dropdown
- Click the **delete** icon next to the config you want to remove
- The config is permanently deleted

### Export

Generates a production-ready `.crew.js` file that can be placed directly into the agent's crew folder.

- Click **"Export"**
- The server generates a `CrewMember` subclass file based on the current config
- The file includes the guidance, model, tools, persona, knowledge base config, and thinker setup
- Place the exported file in `aspect-agent-server/agents/<agent-name>/crew/` and add it to the `index.js` exports

### Reset

Clears everything in the Playground:
- Current config (all panels)
- Chat history
- Session state
- Server-side in-memory registration

---

## Architecture

### Session Lifecycle

```
Open Playground → Edit Config → Activate → Test → Iterate → Save/Export
                                   │
                                   ▼
                         Server creates DynamicCrewMember
                         in-memory (2-hour auto-cleanup)
                                   │
                                   ▼
                         Test chat uses standard SSE pipeline
                         with overrideCrewMember parameter
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **In-memory sessions** | No database pollution from experimental configs. 2-hour auto-cleanup prevents memory leaks. |
| **Reuses existing streaming** | No new endpoint needed. The `overrideCrewMember` parameter routes to the playground crew via the standard dispatcher and SSE pipeline. |
| **DynamicCrewMember class** | A config-driven `CrewMember` subclass that handles both dashboard crews and playground crews. Accepts a plain JSON config instead of requiring a code file. |
| **Mock tools** | Full tool objects with handlers that return configured test responses. The LLM sees real tool definitions and makes real tool calls — only the backend response is mocked. |
| **GCS for persistence** | Configs saved to Google Cloud Storage survive server restarts. In-memory registration does not. |

### DynamicCrewMember

The `DynamicCrewMember` class extends `CrewMember` and is instantiated from a `PlaygroundConfig` object at runtime:

- Sets `this.guidance` from the config's guidance field
- Sets `this.model` from the config's model selection
- Creates tool definitions from the config's actions array
- If Thinker mode is enabled, instantiates a `ThinkingAdvisorAgent` with the thinking prompt
- If a knowledge base is selected, sets `this.storeId` for file search

### ThinkingAdvisorAgent

The reasoning micro-agent used in Thinker mode:

- Receives the thinking prompt and conversation history
- Calls the thinker model (default: Claude Sonnet 4)
- Returns structured JSON advice
- Extracts `_thinkingDescription` for UI display
- Injects the full advice into the talker's system prompt

---

## API Reference

### Base URL
```
Development: http://localhost:3000
Production: https://aspect-server-138665194481.us-central1.run.app
```

### Endpoints

#### Register Playground Crew
```http
POST /api/playground/register
Content-Type: application/json

{
  "agentName": "Freeda",
  "sessionId": "pg_abc123",
  "config": {
    "mode": "simple",
    "model": "gpt-4o",
    "guidance": "You are a helpful assistant...",
    "thinkingPrompt": null,
    "persona": "Friendly and professional",
    "knowledgeBase": null,
    "actions": [],
    "context": {}
  }
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "pg_abc123",
  "crewMemberName": "playground_pg_abc123"
}
```

---

#### Design AI Chat
```http
POST /api/playground/design
Content-Type: application/json

{
  "agentName": "Freeda",
  "message": "I need a crew that helps with symptom tracking",
  "mode": "discuss",
  "history": []
}
```

**`mode`** can be `"discuss"` (back-and-forth) or `"generate"` (produce full config).

**Response:**
```json
{
  "reply": "Great idea! Let me ask a few questions...",
  "config": null
}
```

When `mode` is `"generate"`, the `config` field contains the extracted `PlaygroundConfig` JSON (if a ```json block was found in the reply).

---

#### Delete Playground Session
```http
DELETE /api/playground/:sessionId
```

**Response:**
```json
{
  "success": true
}
```

---

#### Save Config to GCS
```http
POST /api/playground/save
Content-Type: application/json

{
  "agentName": "Freeda",
  "configName": "Symptom Tracker v1",
  "config": { /* PlaygroundConfig */ }
}
```

**Response:**
```json
{
  "success": true,
  "id": "config_abc123"
}
```

---

#### List Saved Configs
```http
GET /api/playground/configs/:agentName
```

**Response:**
```json
{
  "configs": [
    {
      "id": "config_abc123",
      "name": "Symptom Tracker v1",
      "createdAt": "2026-01-15T10:00:00Z",
      "updatedAt": "2026-01-15T12:30:00Z"
    }
  ]
}
```

---

#### Load Specific Config
```http
GET /api/playground/configs/:agentName/:id
```

**Response:**
```json
{
  "id": "config_abc123",
  "name": "Symptom Tracker v1",
  "config": { /* PlaygroundConfig */ },
  "createdAt": "2026-01-15T10:00:00Z",
  "updatedAt": "2026-01-15T12:30:00Z"
}
```

---

#### Delete Saved Config
```http
DELETE /api/playground/configs/:agentName/:id
```

**Response:**
```json
{
  "success": true
}
```

---

#### Export as .crew.js File
```http
POST /api/playground/export
Content-Type: application/json

{
  "agentName": "Freeda",
  "crewName": "SymptomTracker",
  "config": { /* PlaygroundConfig */ }
}
```

**Response:**
```json
{
  "success": true,
  "filename": "symptom-tracker.crew.js",
  "content": "const CrewMember = require('../../crew/base/CrewMember');\n\nclass SymptomTracker extends CrewMember {\n  ..."
}
```

---

## File Locations

### Server

| File | Purpose |
|------|---------|
| `services/playground.service.js` | Core playground service: register sessions, save/load/delete configs (GCS), export to `.crew.js` |
| `crew/base/DynamicCrewMember.js` | Config-driven crew class that handles both dashboard crews and playground crews, with thinker support |
| `crew/micro-agents/ThinkingAdvisorAgent.js` | Reasoning micro-agent for thinker mode: runs strategy brain, returns structured JSON advice |
| `services/crew-editor.service.js` | AI design chat service: `playgroundChat` method handles discuss/generate modes with Claude |
| `server.js` | API endpoint definitions (8 playground routes) |

### Client

| File | Purpose |
|------|---------|
| `src/types/playground.ts` | TypeScript interfaces: `PlaygroundConfig`, `PlaygroundSession`, `PlaygroundTool`, etc. |
| `src/services/playgroundService.ts` | API client functions: `registerPlayground`, `designChat`, `saveConfig`, `loadConfigs`, `exportCrew`, etc. |
| `src/components/dashboard/CrewPlayground/CrewPlayground.tsx` | Main Playground UI component: config panels, design chat, test chat, save/load/export controls |
| `src/components/dashboard/CrewPlayground/CrewPlayground.module.css` | Styles for the Playground UI |

---

## Known Limitations / Future Work

### Current Limitations

| Limitation | Details |
|------------|---------|
| **Conversations persist in DB** | Test chats are stored as real conversations in the database. Future improvement: use `inlineHistory` for ephemeral, no-persist mode. |
| **Server restart loses in-memory registration** | The `DynamicCrewMember` lives only in server memory. If the server restarts, the crew is gone. The client retains the config in React state, so the user must click "Activate" again. |
| **Page refresh loses unsaved config** | If you refresh the browser without saving, your current config is lost. Save to GCS to persist across sessions. |
| **Mock tools only** | Playground tools return pre-configured test responses. There is no way to connect to real backend services from the Playground. |
| **Single crew at a time** | The Playground works with one crew member per session. Multi-crew workflows (transitions between crew members) are not supported in the Playground. |

### Future Work

1. **Ephemeral conversations** — Use inline history to avoid storing test messages in the database
2. **Auto-save** — Periodically save config to prevent data loss on page refresh
3. **Version history** — Track changes to saved configs over time
4. **Multi-crew workflows** — Test transitions between multiple playground crews
5. **Real tool connectors** — Allow connecting playground tools to actual API endpoints for more realistic testing
6. **Config diff view** — Visual comparison between the activated config and current edits
7. **Collaborative editing** — Multiple users editing the same config simultaneously

---

## Troubleshooting

### Chat says "Crew not found" or returns errors

**Cause:** The playground crew is not activated, or the server has restarted since activation.

**Solution:**
1. Click **"Activate"** to register the crew on the server
2. If the server was restarted, activate again — in-memory registrations do not survive restarts
3. Check the browser console for network errors

### Design AI does not produce a config

**Cause:** Claude is in "discuss" mode or the response did not contain a ```json block.

**Solution:**
1. Click **"Generate"** to switch Claude to generate mode
2. Be explicit: "Please generate the full config now"
3. If the response includes a JSON block but it was not auto-extracted, copy it manually into the Manual Config panels

### Config Changed badge won't go away

**Cause:** The current config differs from the last activated config.

**Solution:**
- Click **"Activate"** to push the updated config to the server
- The badge disappears once the live config matches your current config

### Saved configs are not loading

**Cause:** Google Cloud Storage connectivity issue or the config was saved under a different agent.

**Solution:**
1. Verify you are on the correct agent's Playground
2. Check server logs for GCS errors
3. Ensure the server has proper GCS credentials configured

### Thinker mode shows no thinking indicator

**Cause:** The thinking prompt may not be set, or the mode is set to "simple."

**Solution:**
1. Verify the mode is set to **"Thinker"** in the Mode & Model section
2. Ensure the **Thinking Prompt** field is not empty
3. Re-activate after making changes

### Tools are not being called by the LLM

**Cause:** The tool description does not clearly tell the LLM when to use it, or the guidance does not mention the tool.

**Solution:**
1. Write the tool **description** as a clear instruction: "Call this when the user asks about X"
2. Reference the tool in the **guidance**: "When the user describes Y, use the `tool_name` tool"
3. Ensure the tool's **input parameters** match what the guidance describes
4. Re-activate after making changes

---

## Best Practices

### Guidance Writing

1. **Be specific, not vague.** "Help users" is too broad. "Help users troubleshoot Wi-Fi connectivity by diagnosing the issue category first, then providing step-by-step solutions" is actionable.
2. **Structure with headers.** Use `##` sections in the guidance to organize rules, tool usage, boundaries, and formatting preferences.
3. **Define boundaries.** Explicitly state what the crew should NOT do.
4. **Reference tools by name.** If the crew has tools, the guidance should say when and why to use each one.
5. **Iterate rapidly.** Change one thing at a time, re-activate, and test. Do not try to get everything perfect in one pass.

### Tool Design

1. **Descriptive names.** `check_firmware_status` is better than `check`.
2. **Clear trigger descriptions.** The description tells the LLM *when* to call the tool. Be explicit about the trigger condition.
3. **Realistic test responses.** Make the mock data representative of what the real tool would return. This helps you validate that the LLM interprets the data correctly.
4. **Minimal parameters.** Only include parameters the LLM can realistically extract from conversation. Avoid requiring data the user would not naturally provide.

### Thinker Mode

1. **Keep the thinking prompt focused.** The thinker should analyze and classify, not write the response.
2. **Always include `_thinkingDescription`.** This keeps the UI informative. If you forget, it is auto-injected, but writing your own gives better descriptions.
3. **Use structured output.** The thinker's JSON should have clear, named fields the talker can act on.
4. **Test with and without.** Compare Thinker mode to Simple mode for your use case. The extra latency is only worth it if the reasoning meaningfully improves responses.

### Save and Export Workflow

1. **Save frequently.** Page refresh loses unsaved work. Save to GCS after meaningful changes.
2. **Use descriptive config names.** "Symptom Tracker v3 - with escalation logic" is better than "test2".
3. **Test thoroughly before exporting.** Run multiple conversation scenarios in the test chat before generating a `.crew.js` file.
4. **Review the exported file.** The generated code is a starting point. Review it, add real tool implementations, and adjust before deploying to production.

---

**Last Updated:** March 9, 2026
**Version:** 1.0
