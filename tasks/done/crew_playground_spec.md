# Crew Playground — Full Specification

## What Is It

A sandbox tool where domain experts (non-technical users) **design crew members through AI conversation** and **test them live** — all without touching code or existing agents. The same users who use the Crew Editor will use this tool.

The playground has **two modes**:
- **Design Mode** — Chat with Claude to define what the crew does. Claude asks questions, understands the need, and generates the crew configuration. Same discuss/generate flow as the Crew Editor.
- **Test Mode** — Chat WITH the generated crew member using the real framework (dispatcher, streaming, thinking indicator, KB, tool calls — everything).

---

## Architecture: Reuse Everything

**No new streaming endpoint.** The playground creates an in-memory `DynamicCrewMember` and registers it with the crew service. Then uses the existing `/api/finance-assistant/stream` with `overrideCrewMember`. All existing features work for free:
- SSE streaming with thinking indicators
- Thinker/Talker two-brain pattern
- Knowledge base file search
- Tool call loop with handlers
- Prompt/model/KB overrides per request

### How It Works

```
┌─────────────────────────┐    ┌──────────────────────────────┐
│  DESIGN MODE            │    │  TEST MODE                    │
│  (Chat with Claude)     │    │  (Chat with the crew)         │
│                         │    │                               │
│  Uses crew-editor       │───>│  Uses /api/finance-assistant/ │
│  service chatWithClaude │    │  stream with overrideCrew     │
│  (discuss + generate)   │    │                               │
│                         │    │  DynamicCrewMember registered  │
│  Outputs: crew config   │    │  in memory via crew service   │
└─────────────────────────┘    └──────────────────────────────┘
```

---

## Part 1: Server — Playground Service

### New file: `aspect-agent-server/services/playground.service.js`

Manages ephemeral playground crew members in memory.

```js
class PlaygroundService {
  constructor() {
    // Map of sessionId -> { crewMember, config, mockTools }
    this.sessions = new Map();
  }

  /**
   * Register a playground crew from config.
   * Creates a DynamicCrewMember and adds it to crew service's in-memory map.
   *
   * @param {string} sessionId - Unique playground session ID
   * @param {string} agentName - Agent context (for KB scoping)
   * @param {object} config - Crew configuration
   * @returns {{ crewName: string, agentName: string }}
   */
  register(sessionId, agentName, config) {
    const crewName = `playground-${sessionId}`;
    const playgroundAgentName = `playground-${agentName}-${sessionId}`;

    const DynamicCrewMember = require('../crew/base/DynamicCrewMember');
    const crew = new DynamicCrewMember({
      name: crewName,
      displayName: config.displayName || 'Playground Crew',
      description: config.description || 'Playground test crew',
      guidance: config.guidance,
      model: config.model || 'gpt-5',
      maxTokens: config.maxTokens || 2048,
      isDefault: true,
      knowledgeBase: config.kbSources ? {
        enabled: true,
        sources: config.kbSources
      } : null,
      fieldsToCollect: config.fieldsToCollect || [],
    });

    // Set thinker properties directly on instance
    if (config.mode === 'thinker' && config.thinkingPrompt) {
      crew.usesThinker = true;
      crew.thinkingPrompt = config.thinkingPrompt;
      crew.thinkingModel = config.thinkingModel || 'claude-sonnet-4-20250514';
    }

    // Set persona
    if (config.persona) {
      crew.persona = config.persona;
    }

    // Set mock tools with handlers that return mock responses
    if (config.tools && config.tools.length > 0) {
      crew.tools = config.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {} },
        handler: async (params) => {
          // Return the user-defined mock response
          console.log(`🎭 [Playground] Mock tool called: ${tool.name}`, params);
          return typeof tool.mockResponse === 'function'
            ? tool.mockResponse
            : tool.mockResponse || { mock: true, tool: tool.name };
        }
      }));
    }

    // Inject pre-loaded context into guidance
    if (config.context && Object.keys(config.context).length > 0) {
      let contextSection = '\n\n## Context (information from previous conversations)\n';
      for (const [key, value] of Object.entries(config.context)) {
        contextSection += `- ${key}: ${JSON.stringify(value)}\n`;
      }
      crew.guidance += contextSection;
    }

    // Register with crew service
    const crewService = require('../crew/services/crew.service');
    if (!crewService.crews.has(playgroundAgentName)) {
      crewService.crews.set(playgroundAgentName, new Map());
    }
    crewService.crews.get(playgroundAgentName).set(crewName, crew);

    // Store session
    this.sessions.set(sessionId, {
      crewMember: crew,
      config,
      agentName: playgroundAgentName,
      crewName,
      createdAt: new Date()
    });

    return { crewName, agentName: playgroundAgentName };
  }

  /**
   * Update an existing playground crew's config.
   * Re-registers with updated properties.
   */
  update(sessionId, config) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Playground session not found');
    return this.register(sessionId, session.agentName.replace(`playground-`, '').replace(`-${sessionId}`, ''), config);
  }

  /**
   * Remove a playground session and clean up.
   */
  remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      const crewService = require('../crew/services/crew.service');
      crewService.crews.delete(session.agentName);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Clean up stale sessions (older than 2 hours).
   */
  cleanup() {
    const maxAge = 2 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt.getTime() > maxAge) {
        this.remove(id);
      }
    }
  }
}

module.exports = new PlaygroundService();
```

### Key details:
- Each playground session gets a unique agent name (`playground-{agent}-{sessionId}`) so sessions don't clash
- The crew is registered as `isDefault: true` so the dispatcher picks it up automatically
- Mock tools are real tool objects with handlers — the dispatcher's existing tool call loop works as-is
- Pre-loaded context is injected into guidance text (same as how crews use `buildContext()`)
- 2-hour auto-cleanup for stale sessions

---

## Part 2: Server — Design Mode (AI Chat)

### Reuse crew-editor.service.js `chatWithClaude`

The playground's design chat reuses the same `chatWithClaude` method but with a **different prompt** — one that generates crew CONFIG (JSON) instead of a `.crew.js` file.

### New method in `crew-editor.service.js`

```js
/**
 * Chat with Claude about designing a NEW crew member in the playground.
 * Two modes:
 * - 'discuss': Understand what the user wants (no code)
 * - 'generate': Output a complete crew config as JSON
 */
async playgroundChat(messages, currentConfig, mode = 'discuss') {
  const prompt = mode === 'discuss'
    ? this._buildPlaygroundDiscussPrompt(currentConfig)
    : this._buildPlaygroundGeneratePrompt(currentConfig);

  const response = await llmService.sendOneShot(
    prompt,
    messages.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n'),
    { model: 'claude-sonnet-4-20250514', maxTokens: mode === 'generate' ? 4096 : 1024 }
  );

  let updatedConfig = null;
  if (mode === 'generate') {
    updatedConfig = this._extractPlaygroundConfig(response);
  }

  return { response, updatedConfig };
}
```

### `_buildPlaygroundDiscussPrompt(currentConfig)`

```
You are helping a product expert design a NEW AI assistant crew member from scratch.
The user is NOT a developer. They are a domain expert who knows the product well.

YOUR COMMUNICATION STYLE:
- Use plain, everyday language — no technical jargon
- Talk about the assistant's "behavior", "personality", "conversation style"
- Be conversational and warm

WHAT YOU'RE HELPING THEM DEFINE:
- What the assistant does and how it talks (its guidance/prompt)
- Whether it needs a "strategy brain" (thinker mode) that analyzes before responding
- Its personality/voice (persona)
- What knowledge bases it should access
- What tools/actions it can take (e.g., search products, book appointments)
- What it already knows about the user from previous steps (context)

ASK ABOUT EACH AREA NATURALLY:
Don't dump all questions at once. Start by understanding the purpose,
then dig into specifics one area at a time.

CURRENT CONFIG (what we have so far):
${currentConfig ? JSON.stringify(currentConfig, null, 2) : '(nothing yet — starting fresh)'}

When you feel you've understood enough, wrap up by saying something like:
"I think we have a clear picture — whenever you're ready, click **Generate** and I'll create the crew configuration."
Do this naturally each time the discussion reaches a conclusion.
```

### `_buildPlaygroundGeneratePrompt(currentConfig)`

```
You are generating a crew member configuration based on the conversation.
Output a COMPLETE JSON configuration inside a ```json code block.

THE JSON SCHEMA:
{
  "displayName": "Human-readable name",
  "description": "One-line description",
  "mode": "simple" or "thinker",
  "model": "gpt-5" (or other model),
  "guidance": "The full prompt that defines the assistant's behavior...",
  "thinkingPrompt": "(only for thinker mode) The strategy brain prompt that returns JSON...",
  "thinkingModel": "claude-sonnet-4-20250514",
  "persona": "Voice and personality description...",
  "kbSources": [{"vectorStoreId": "vs_xxx", "name": "Product KB"}],
  "tools": [
    {
      "name": "tool_name",
      "description": "What this tool does",
      "parameters": { "type": "object", "properties": { ... }, "required": [...] },
      "mockResponse": { ... example response data ... }
    }
  ],
  "context": {
    "namespace_name": { ...data the crew already knows... }
  },
  "maxTokens": 2048
}

RULES:
- guidance should be detailed and complete — this IS the crew's prompt
- For thinker mode: thinkingPrompt should instruct the strategy brain to return JSON
  with analysis and recommendations. The talking brain will use this to respond.
- tools.mockResponse should contain realistic example data
- context should simulate what previous crews would have collected
- Only include fields that were discussed. Don't invent features.

CURRENT CONFIG (update/replace as needed):
${currentConfig ? JSON.stringify(currentConfig, null, 2) : '(none)'}

After the JSON block, add a plain-language summary of what was created,
grouped by area: Behavior, Personality, Knowledge, Tools, Context.
```

### `_extractPlaygroundConfig(response)`

Extracts JSON from ` ```json ... ``` ` code block and validates it:

```js
_extractPlaygroundConfig(response) {
  const match = response.match(/```json\s*\n([\s\S]*?)```/);
  if (!match) return null;
  try {
    const config = JSON.parse(match[1].trim());
    // Basic validation
    if (!config.guidance) return null;
    return config;
  } catch {
    return null;
  }
}
```

---

## Part 3: Server — Endpoints

### Add to `server.js`:

```js
// ── Playground Endpoints ──

// Register/update a playground crew
POST /api/playground/register
  Body: { sessionId, agentName, config }
  → playgroundService.register(sessionId, agentName, config)
  → Returns: { crewName, agentName: playgroundAgentName }

// Design mode chat (talk with Claude about what to build)
POST /api/playground/design
  Body: { messages, currentConfig, mode: 'discuss'|'generate' }
  → crewEditorService.playgroundChat(messages, currentConfig, mode)
  → Returns: { response, updatedConfig }

// Remove playground session
DELETE /api/playground/:sessionId
  → playgroundService.remove(sessionId)
  → Returns: { success: true }
```

**Test mode chat** — uses the EXISTING `/api/finance-assistant/stream` endpoint:
```js
{
  message: "Hello!",
  conversationId: "playground-session-xxx",
  agentName: "playground-{agent}-{sessionId}",  // from register response
  overrideCrewMember: "playground-{sessionId}",
  useKnowledgeBase: true
}
```

No new streaming code needed.

---

## Part 4: Client — Types

### New file: `types/playground.ts`

```ts
export type PlaygroundMode = 'simple' | 'thinker';

export interface MockTool {
  name: string;
  description: string;
  parameters: object;
  mockResponse: unknown;
}

export interface PlaygroundConfig {
  displayName: string;
  description: string;
  mode: PlaygroundMode;
  model: string;
  guidance: string;
  thinkingPrompt: string;
  thinkingModel: string;
  persona: string;
  kbSources: Array<{ vectorStoreId: string; name: string }>;
  tools: MockTool[];
  context: Record<string, unknown>;
  maxTokens: number;
}

export interface DesignMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlaygroundSession {
  sessionId: string;
  crewName: string;
  agentName: string;  // playground agent name for stream requests
  config: PlaygroundConfig;
  registered: boolean;
}
```

---

## Part 5: Client — Service

### New file: `services/playgroundService.ts`

```ts
// Design mode — chat with Claude about what to build
export async function designChat(
  messages: DesignMessage[],
  currentConfig: PlaygroundConfig | null,
  mode: 'discuss' | 'generate',
  baseURL: string
): Promise<{ response: string; updatedConfig: PlaygroundConfig | null }>

// Register crew config with server (creates in-memory DynamicCrewMember)
export async function registerPlayground(
  sessionId: string,
  agentName: string,
  config: PlaygroundConfig,
  baseURL: string
): Promise<{ crewName: string; agentName: string }>

// Remove playground session
export async function removePlayground(
  sessionId: string,
  baseURL: string
): Promise<void>

// Save/load configs to localStorage
export function saveConfig(name: string, config: PlaygroundConfig): void
export function loadConfigs(): Array<{ id: string; name: string; config: PlaygroundConfig }>
export function deleteConfig(id: string): void
```

**Test mode chat** — reuses the existing `chatService.streamChat()` with playground agent/crew names. No new streaming code.

---

## Part 6: Client — UI Component

### New file: `components/dashboard/CrewPlayground/CrewPlayground.tsx`

**Layout — three panels:**

```
┌────────────────────────────────────────────────────────────────────┐
│ TOP BAR: "Crew Playground" + [Design|Test] mode toggle + actions   │
├──────────────────────┬──────────────────────┬──────────────────────┤
│ DESIGN CHAT (left)   │ TEST CHAT (center)   │ MOCKUP PANEL (right) │
│                      │                      │                      │
│ Chat with Claude     │ Chat with the crew   │ Tool call log:       │
│ about what to build  │ to test it           │                      │
│                      │                      │ 🔧 search_products   │
│ "I want an assistant │ "Hi! I'm your new    │   params: {query}    │
│  that helps with..." │  assistant..."       │   response: [{...}]  │
│                      │                      │                      │
│ [Claude]: "What kind │ [You]: "Find shoes"  │ 🔧 book_appointment  │
│  of questions..."    │                      │   params: {date}     │
│                      │ [Crew]: "I found     │   response: {ok}     │
│                      │  these options..."   │                      │
│                      │  🔧 search_products  │ ── Editable ──       │
│                      │                      │ Mock data for each   │
│                      │                      │ tool is editable     │
├──────────────────────┤                      │ as JSON              │
│ CONFIG SUMMARY       │                      │                      │
│ (collapsible)        │                      │                      │
│                      │                      │                      │
│ Mode: Thinker        │                      │                      │
│ Model: gpt-5         │                      │                      │
│ KB: Product Catalog  │                      │                      │
│ Tools: 2 defined     │                      │                      │
│ Context: 1 namespace │                      │                      │
├──────────────────────┼──────────────────────┼──────────────────────┤
│ [input]    [Send]    │ [input]     [Send]   │                      │
└──────────────────────┴──────────────────────┴──────────────────────┘
```

### Mode Toggle Behavior

**Design Mode** (active by default on first open):
- Left panel: Design chat with Claude (visible, full width if test not started)
- Center panel: Grayed out / placeholder ("Generate a crew first to start testing")
- Right panel: Hidden until test mode

**Test Mode** (activated after first Generate):
- Left panel: Collapses to config summary (expandable back to full design chat)
- Center panel: Active test chat with the crew
- Right panel: Mockup panel shows tool calls

User can switch freely between modes. Design changes → re-register crew → test with updated config.

### Design Chat Flow

1. User opens playground → sees design chat
2. Types what they want: "I need an assistant that helps customers find products"
3. Claude asks about behavior, persona, tools, context
4. User answers naturally
5. Claude says "Ready to generate — click Generate"
6. User clicks **Generate** button
7. Claude produces crew config JSON → extracted → shown in config summary
8. **Auto-registers** with server → test mode becomes available
9. User clicks **Test** → center panel activates, can chat with the crew

### Config Summary Panel

Below the design chat, a collapsible read-only summary:

```
┌─ Configuration ──────────────────────┐
│ Mode: 🧠 Thinker                     │
│ Model: gpt-5                         │
│ Guidance: "You are a product expert  │
│   who helps customers find..."       │
│ Persona: "Friendly, knowledgeable"   │
│ KB: Product Catalog (vs_abc123)      │
│ Tools:                               │
│   • search_products — Search catalog │
│   • check_inventory — Check stock    │
│ Context:                             │
│   • user_profile: {name: "Sarah"}    │
│                                      │
│ [Edit Mock Data] [Re-Generate]       │
└──────────────────────────────────────┘
```

"Edit Mock Data" opens the mockup panel for editing.
"Re-Generate" goes back to design chat for refinement.

### Mockup Panel (Right)

Shows tool calls as they happen during test chat:

```
┌─ Tool Calls ─────────────────────────┐
│                                       │
│ 🔧 search_products                    │
│ Called with: {"query": "red shoes"}   │
│ ┌─ Mock Response (editable) ────────┐│
│ │ [                                 ││
│ │   {"name": "Nike Air", "price":99}││
│ │   {"name": "Adidas Run", ...}     ││
│ │ ]                                 ││
│ └───────────────────────────────────┘│
│                                       │
│ 🔧 check_inventory                    │
│ Called with: {"sku": "NIKE-001"}      │
│ ┌─ Mock Response (editable) ────────┐│
│ │ {"inStock": true, "quantity": 42} ││
│ └───────────────────────────────────┘│
│                                       │
│ [Save Mock Data] — persists edits     │
│ back to playground config             │
└───────────────────────────────────────┘
```

When user edits a mock response and clicks Save:
1. Updates the config's `tools[].mockResponse`
2. Re-registers the crew with server
3. Next test message uses updated mock data

### Test Chat

Reuses the existing `useChat` hook and `chatService.streamChat()`:

```ts
const { messages, isLoading, isThinking, sendMessage, ... } = useChat({
  agentName: session.agentName,     // playground-{agent}-{sessionId}
  conversationId: `playground-${sessionId}`,
  overrideCrewMember: session.crewName,
  // Standard callbacks:
  onCrewInfo: (crew) => { ... },
  onThinkingStep: (step) => { ... },
  // Tool call visibility:
  onFunctionCall: (name, params) => { addToMockupPanel(name, params); },
});
```

Everything works — thinking indicator, streaming, KB file search results — because it's the real framework.

---

## Part 7: Client — CSS

### New file: `components/dashboard/CrewPlayground/CrewPlayground.module.css`

Follows existing design system from `variables.css` and `CrewEditorAI.module.css`.

**Layout classes:**
- `.container` — full-height flex column (same as CrewEditorAI)
- `.topBar` — header with mode toggle
- `.panels` — flex row, three panels
- `.designPanel` — left panel (~30%), flex column, scrollable
- `.testPanel` — center panel (~40%), flex column
- `.mockupPanel` — right panel (~30%), flex column, scrollable
- `.panelCollapsed` — width 0, transition

**Mode toggle:**
- `.modeToggle` — pill toggle (reuse `.versionPill` pattern from CrewEditorAI)

**Design chat:** Reuse chat styles from CrewEditorAI:
- `.chatMessages`, `.message`, `.messageBubble`, `.messageBubbleUser`, `.messageBubbleAssistant`
- `.chatInputArea`, `.chatInput`, `.sendButton`
- `.generatingBanner` (for generate mode)

**Config summary:**
- `.configSummary` — collapsible section
- `.configRow` — label + value pair
- `.configLabel` — muted text
- `.configValue` — truncated, monospace for JSON

**Mockup panel:**
- `.mockupPanel` — border-left, background
- `.toolCallCard` — card per tool call
- `.toolCallHeader` — tool name + icon
- `.toolCallParams` — params display (monospace, small)
- `.mockResponseEditor` — dark bg textarea, monospace, editable
- `.saveMockButton` — save edits button

**Test chat:** Same chat styles as design chat.

---

## Part 8: Dashboard Integration

### `DashboardPage.tsx`

```tsx
import { CrewPlayground } from '../components/dashboard/CrewPlayground';

// Add route:
<Route
  path="playground"
  element={<CrewPlayground agentName={config.agentName} baseURL={config.baseURL} />}
/>
```

### `DashboardLayout.tsx`

```ts
// Add to BASE_NAV_ITEMS:
{ path: 'playground', label: 'Playground', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' }
// (circuit board / chip icon — represents playground/sandbox)
```

---

## Files Summary

**New files (6):**

| File | Purpose |
|------|---------|
| `aspect-agent-server/services/playground.service.js` | In-memory crew registration + session management |
| `aspect-react-client/src/types/playground.ts` | TypeScript types |
| `aspect-react-client/src/services/playgroundService.ts` | API calls (design chat, register, save/load) |
| `aspect-react-client/src/components/dashboard/CrewPlayground/CrewPlayground.tsx` | Main UI component |
| `aspect-react-client/src/components/dashboard/CrewPlayground/CrewPlayground.module.css` | Styles |
| `aspect-react-client/src/components/dashboard/CrewPlayground/index.ts` | Barrel export |

**Modified files (4):**

| File | Change |
|------|--------|
| `aspect-agent-server/server.js` | 3 new endpoints: register, design, delete (~50 lines) |
| `aspect-agent-server/services/crew-editor.service.js` | 3 new methods: playgroundChat, _buildPlaygroundDiscussPrompt, _buildPlaygroundGeneratePrompt, _extractPlaygroundConfig (~120 lines) |
| `aspect-react-client/src/pages/DashboardPage.tsx` | Add playground route |
| `aspect-react-client/src/components/dashboard/DashboardLayout/DashboardLayout.tsx` | Add nav item |

---

## Implementation Order

1. **Server: `playground.service.js`** — in-memory crew registration
2. **Server: crew-editor.service.js** — playground discuss/generate prompts
3. **Server: server.js** — 3 new endpoints
4. **Client: types + service** — types, API calls
5. **Client: component + CSS** — the three-panel UI
6. **Dashboard integration** — route + nav

---

## Verification

1. Open Playground → design chat → describe a simple crew → Generate → config appears in summary
2. Click Test → chat with the crew → verify streaming response follows the guidance
3. Toggle to Thinker mode in design → re-generate → test → verify thinking indicator shows
4. Design a crew with a tool → test → verify tool call appears in mockup panel with mock response
5. Edit mock response in mockup panel → save → re-test → verify crew uses updated mock
6. Add KB in design → test with question about KB content → verify file search results
7. Add context in design → test → verify crew "knows" the context
8. Switch between Design/Test freely → verify state preserved
