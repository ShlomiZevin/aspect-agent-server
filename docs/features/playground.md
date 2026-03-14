# Playground - Design & Test Crew Members On-The-Fly

## What It Does

The Playground is a sandbox environment that lets you design and test AI crew members without writing code. It has two modes:

1. **Design Mode** — Chat with Claude to define a new crew member through natural conversation
2. **Test Mode** — Chat with the generated crew member using the full production streaming infrastructure

You can iterate between design and testing, save configs to GCS for later, and export as `.crew.js` files for production deployment.

**Route:** `/:agent/dashboard/playground`

---

## How It Works

```
Design Chat (Claude)          Test Chat (Production infra)
        ↓                              ↓
 /api/playground/design         /api/finance-assistant/stream
        ↓                              ↓
 Claude generates config        Dispatcher routes to crew
        ↓                              ↓
 /api/playground/register       DynamicCrewMember handles
        ↓                         response with real SSE
 In-memory crew created              streaming
```

The key architectural decision: playground crews are registered as `DynamicCrewMember` instances in the in-memory crew service. The dispatcher treats them identically to production crews — no special playground logic needed.

---

## User Journey

### 1. Design Phase

User opens the playground and describes what they want:

```
User: "I need an assistant that helps customers find flowers for occasions"
Claude: Asks about tone, catalog structure, tools needed...
User: "Friendly, should search our product DB, suggest arrangements"
Claude: Guides through tools, context, transitions...
```

Design chat uses:
- **Discuss mode** — Claude Sonnet 4.6, conversational, 2048 tokens
- **Generate mode** — Claude Opus 4.6, outputs full PlaygroundConfig JSON, 16384 tokens

### 2. Generate

User clicks **Generate**. Claude outputs a complete `PlaygroundConfig` JSON. The client extracts it (three-strategy parser: non-greedy regex → greedy regex → brace matching) and displays it in the Config tab.

The crew auto-registers via `POST /api/playground/register`, creating a `DynamicCrewMember` in memory.

### 3. Test Phase

The right panel activates. User chats with the crew using the production streaming endpoint (`/api/finance-assistant/stream`) with `overrideCrewMember: playground-{sessionId}`.

Everything works: streaming, thinking steps, tool calls (with mock responses), KB file search, field extraction, and transitions.

### 4. Iterate

- Edit config directly in the Config tab → click **Activate** to re-register
- Or return to Design tab to refine with Claude
- Each re-registration updates the in-memory crew

### 5. Save / Export

- **Save** — stores config to GCS at `playground-configs/{agentName}/{timestamp}.json`
- **Export** — downloads a `.crew.js` file ready for production (with TODO handler placeholders for tools)

---

## Configurable Parameters

| Category | Parameter | Description |
|----------|-----------|-------------|
| **Basics** | `displayName` | Crew display name |
| | `description` | What the crew does |
| | `mode` | `"simple"` or `"thinker"` (dual-brain) |
| | `model` | gpt-4o, gpt-5, claude-opus-4-6, gemini-2.5-flash, etc. |
| | `maxTokens` | Response token limit (1024-8000) |
| **Personality** | `guidance` | Full system prompt defining behavior |
| | `persona` | Voice and personality style description |
| **Thinking** | `thinkingPrompt` | Strategy brain prompt (thinker mode only, should return JSON) |
| | `thinkingModel` | Model for thinker brain (default: claude-sonnet-4-20250514) |
| **Knowledge** | `kbSources` | Array of `{ vectorStoreId, name }` — connects real vector stores |
| **Tools** | `tools[]` | Each tool has: `name`, `description`, `parameters` (JSON schema), `mockResponse` |
| **Context** | `context` | Pre-loaded knowledge as key-value pairs — injected into guidance as "## Context" |
| **Transitions** | `fieldsToCollect` | Array of `{ name, description }` for field-based auto-transitions |
| | `transitionTo` | Target crew name (fires when all fields collected) |

---

## What Gets Tested (Full Production Parity)

| Feature | Tested? | Notes |
|---------|---------|-------|
| SSE streaming | Yes | Real streaming via production endpoint |
| Thinking (thinker mode) | Yes | Full thinker brain + talker brain |
| Tool calls | Yes | Real execution, returns mock responses |
| Knowledge base search | Yes | Real vector store file search |
| Field extraction | Yes | Parallel extraction if fields defined |
| Field-based transitions | Yes | Fires when all fields collected |
| Persona application | Yes | Applied to all responses |
| Model selection | Yes | Test with any available model |
| Token limits | Yes | Respects maxTokens setting |
| Tool-based transitions | No | Requires custom `postMessageTransfer()` code |
| Thinker-based transitions | No | Requires custom `postThinkingTransfer()` code |
| Multi-crew workflows | No | Single crew per playground session |
| Real tool APIs | No | Tools use mock responses only |
| DB persistence of test chats | No | Intentionally ephemeral |

---

## API Endpoints

### Design & Registration

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/playground/design` | Design chat with Claude |
| `POST` | `/api/playground/register` | Register crew in memory |
| `DELETE` | `/api/playground/:sessionId` | Remove playground session |

### Config Management (GCS)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/playground/save` | Save config to GCS |
| `GET` | `/api/playground/configs/:agentName` | List saved configs |
| `GET` | `/api/playground/configs/:agentName/:id` | Load a saved config |
| `DELETE` | `/api/playground/configs/:agentName/:id` | Delete a saved config |

### Export

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/playground/export` | Generate `.crew.js` file content |

### Testing (Reused)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/finance-assistant/stream` | Test chat (with `overrideCrewMember: playground-{sessionId}`) |

---

## Session Management

- Each session gets a unique 8-character random ID
- Crew name format: `playground-{sessionId}`
- Sessions auto-expire after **2 hours** (server-side cleanup)
- Client calls `DELETE /api/playground/:sessionId` on component unmount
- Draft auto-saved to localStorage with 24-hour expiry
- Browser close/refresh triggers unsaved work warning

---

## Mock Tools

Tools in the playground use **mock responses** instead of real API calls. When the LLM calls a tool, the handler returns the configured `mockResponse` directly.

```
Example tool config:
  name: "search_products"
  description: "Search the product catalog"
  parameters: { type: "object", properties: { query: { type: "string" } } }
  mockResponse: { results: [{ name: "Red Roses Bouquet", price: 89 }] }

Flow:
  LLM decides to call search_products({ query: "roses" })
  → Handler returns the mockResponse JSON
  → LLM incorporates results into its response
```

This lets you test the full tool-call UX and response flow without needing real integrations.

---

## Context Injection

The `context` parameter provides pre-loaded knowledge to the crew. It's appended to the guidance as:

```
## Context (information already known)

<key>: <value>
...
```

Use cases:
- Business rules the crew should know
- User profile data
- Product catalogs or reference data
- Any structured knowledge the crew needs without a KB vector store

---

## Design Chat Internals

The design chat guides users through building a crew config conversationally.

**Discuss mode prompt** covers:
- Behavior and personality definition
- Tool design (name, params, mock data)
- Knowledge base attachment
- Context injection
- Three transition approaches explained:
  1. Field-based (`preMessageTransfer`) — auto-transition when fields collected
  2. Thinker-based (`postThinkingTransfer`) — strategy brain decides
  3. Tool-based (`postMessageTransfer`) — tools track state

**Generate mode prompt** instructs Claude to output a complete `PlaygroundConfig` JSON with all fields, followed by a plain-language summary.

**Config extraction** uses three strategies in order:
1. Non-greedy ` ```json...``` ` regex (smallest block)
2. Greedy match (handles nested backticks)
3. Brace matching (finds outermost JSON object containing `"guidance"`)

---

## Integration with Dispatcher

The dispatcher requires **zero special handling** for playground crews:

```
Dispatcher.getCurrentCrew(agentName, conversationId, overrideCrewMember)
  ↓
crewService.getCrewMember(agentName, "playground-abc12345")
  ↓
Returns DynamicCrewMember (registered by playground service)
  ↓
Dispatcher streams response using crew's:
  - guidance, model, maxTokens
  - tools (with mock handlers)
  - thinkingPrompt (if thinker mode)
  - knowledgeBase (if KB attached)
  - fieldsToCollect (if fields defined)
```

All existing dispatcher logic — streaming, tool loops, thinking, KB search, field extraction, transitions — works transparently.

---

## File Structure

**Server:**
```
aspect-agent-server/
├── services/
│   ├── playground.service.js      # Session management, GCS persistence, export
│   └── crew-editor.service.js     # Design chat (playgroundChat method)
├── crew/base/
│   └── DynamicCrewMember.js       # Base class for playground crews
└── server.js                      # API endpoints (playground section)
```

**Client:**
```
aspect-react-client/src/
├── types/playground.ts                          # PlaygroundConfig, MockTool types
├── services/playgroundService.ts                # API service functions
├── components/dashboard/CrewPlayground/
│   └── CrewPlayground.tsx                       # Main component (1,379 lines)
└── pages/DashboardPage.tsx                      # Route integration
```
