# Agent Building Guide v2.1

This guide explains how to add new agents and crew members to the Aspect platform. It is intended to be read by an AI assistant (e.g., Claude Code) so it can build the actual code files from a description.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Part 1: Adding a New Agent (Full End-to-End)](#part-1-adding-a-new-agent-full-end-to-end)
3. [Part 2: Adding a Crew Member to an Existing Agent](#part-2-adding-a-crew-member-to-an-existing-agent)
4. [Part 3: CrewMember Class Reference](#part-3-crewmember-class-reference)
5. [Part 4: Transfer Methods (preMessageTransfer vs postMessageTransfer)](#part-4-transfer-methods-premessagetransfer-vs-postmessagetransfer)
6. [Part 5: Tool-Based State Management](#part-5-tool-based-state-management)
7. [Part 6: Context System](#part-6-context-system)
8. [Part 7: Client-Side SSE Callbacks](#part-7-client-side-sse-callbacks)
9. [Part 8: Tool Design Patterns](#part-8-tool-design-patterns)
10. [Part 9: Thinker+Talker Crews (ThinkingAdvisorAgent)](#part-9-thinkertalker-crews-thinkingadvisoragent)
11. [Quick Reference: File Locations](#quick-reference-file-locations)

---

## Architecture Overview

Each **agent** is a self-contained AI assistant (e.g., Freeda for menopause, Aspect for business intelligence). Agents can optionally have **crew members** — specialized sub-agents that handle different phases or topics in a conversation. A **dispatcher** routes messages to the correct crew member and handles transitions between them.

**Key flow:** `Client → Server endpoint → Dispatcher → Crew Member → LLM → Streaming response back to client`

### Three Approaches to Crew Transitions

| Approach | Use Case | Transfer Method | When it runs |
|----------|----------|-----------------|--------------|
| **Field-based** | Collect data, transition when complete | `preMessageTransfer` | Before LLM call |
| **Thinker-driven** | Thinker decides transition | `postThinkingTransfer` | After buildContext, before talker |
| **Tool-based** | Interactive state via tool calls | `postMessageTransfer` | After LLM response |

---

## Part 1: Adding a New Agent (Full End-to-End)

Adding a new agent requires changes in both server and client. Below is the complete checklist.

### 1.1 Server: Create the Crew Folder

Create the folder structure under `aspect-agent-server/agents/`:

```
aspect-agent-server/agents/<agent-name>/crew/
├── index.js            # Exports all crew member classes
├── default.crew.js     # The default (entry-point) crew member
└── <other>.crew.js     # Additional crew members (optional)
```

The folder name must match one of the normalization patterns the crew service uses to find it. The service tries these transformations on the agent's DB name:
- Exact name: `"Banking Pro"`
- Lowercase: `"banking pro"`
- Dashed: `"banking-pro"`
- Alpha-only: `"bankingpro"`
- First word: `"banking"`

**Recommendation:** Use the lowercase first word of the agent name as the folder name (e.g., agent name `"Banking Pro"` → folder `banking`).

### 1.2 Server: Create the index.js

The `index.js` file exports all crew member classes. The crew service `require()`s this file and instantiates every exported class.

```js
// aspect-agent-server/agents/<agent-name>/crew/index.js
const MyDefaultCrew = require('./default.crew');
const MySpecialistCrew = require('./specialist.crew');

module.exports = {
  MyDefaultCrew,
  MySpecialistCrew
};
```

### 1.3 Server: Build Crew Member Classes

Each crew member extends the `CrewMember` base class. See **Part 3** for the full reference.

### 1.4 Server: Seed the Agent in the Database

Add the agent to `aspect-agent-server/db/seed.js`. The agent record needs:

```js
const newAgent = {
  name: 'Banking Pro',           // MUST match what client sends as agentName
  domain: 'banking',             // Category/domain
  description: 'AI banking assistant for personal finance guidance.',
  config: {
    model: process.env.OPENAI_MODEL || 'gpt-4-turbo',
    vectorStoreId: null,         // Set if agent has a global knowledge base
    features: ['budgeting', 'investment_advice'],
    supportedLanguages: ['en']
  },
  isActive: true
};
```

Run the seed: `cd aspect-agent-server && node db/seed.js`

### 1.5 Client: Create Agent Config

Create `aspect-react-client/src/agents/<agent-name>.config.ts`.

Reference the `AgentConfig` interface in `aspect-react-client/src/types/agent.ts` for all available fields. Here's the structure:

```ts
import type { AgentConfig } from '../types';

export const bankingConfig: AgentConfig = {
  // Identity - agentName MUST match the DB agent name exactly
  agentName: 'Banking Pro',
  displayName: 'Banking Pro',
  storagePrefix: 'banking_',

  // Server
  baseURL: 'https://your-server-url.run.app',  // or 'http://localhost:3001' for dev

  // Page meta
  pageTitle: 'Banking Pro - AI Finance Assistant',
  favicon: '/banking-favicon.svg',
  metaDescription: 'AI-powered personal finance assistant',

  // UI
  logo: { src: '/banking-logo.svg', alt: 'Banking Pro' },
  headerTitle: 'Banking Pro',
  headerSubtitle: 'Your personal finance assistant',
  welcomeIcon: '/banking-welcome.svg',
  welcomeTitle: 'Welcome to Banking Pro',
  welcomeMessage: 'I can help you with budgeting, investments, and financial planning.',
  inputPlaceholder: 'Ask about your finances...',

  quickQuestions: [
    { text: 'How should I budget?', icon: '💰' },
    { text: 'Investment basics', icon: '📈' },
  ],

  thinkingSteps: [
    ['Analyzing your question...', 'Checking financial data...', 'Preparing advice...'],
    ['Processing request...', 'Reviewing information...', 'Generating response...'],
  ],

  // Features
  features: {
    hasKnowledgeBase: false,     // true if agent has KB files
    kbToggleable: false,         // true if user can toggle KB on/off
    hasLogoUpload: false,        // true if agent supports logo upload
    hasFileUpload: false,        // true if agent supports file upload
    hasChatHistory: true,        // true to show chat history sidebar
  },

  // Theming - must match a CSS class in styles/themes/
  themeClass: 'theme-banking',
};
```

### 1.6 Client: Create the Agent Page

Create `aspect-react-client/src/pages/BankingPage.tsx`:

```tsx
import { bankingConfig } from '../agents/banking.config';
import { useDocumentMeta } from '../hooks';
import { ThemeProvider } from '../context/ThemeContext';
import { UserProvider } from '../context/UserContext';
import { AgentProvider } from '../context/AgentContext';
import { ChatProvider } from '../context/ChatContext';
import { AppLayout } from '../components/layout/AppLayout';
import { ChatContainer } from '../components/chat/ChatContainer';

export function BankingPage() {
  useDocumentMeta({
    title: bankingConfig.pageTitle,
    favicon: bankingConfig.favicon,
    description: bankingConfig.metaDescription,
  });

  return (
    <ThemeProvider storagePrefix={bankingConfig.storagePrefix}>
      <UserProvider storagePrefix={bankingConfig.storagePrefix} baseURL={bankingConfig.baseURL}>
        <AgentProvider config={bankingConfig}>
          <ChatProvider>
            <AppLayout>
              {/* Pass showCrewSelector={true} if agent has crew members */}
              <ChatContainer showCrewSelector={true} />
            </AppLayout>
          </ChatProvider>
        </AgentProvider>
      </UserProvider>
    </ThemeProvider>
  );
}
```

### 1.7 Client: Add Route

In `aspect-react-client/src/App.tsx`, add the route:

```tsx
import { BankingPage } from './pages/BankingPage';

// Inside <Routes>:
<Route path="/banking" element={<BankingPage />} />
```

### 1.8 Client: Create Theme (Optional)

Create `aspect-react-client/src/styles/themes/<agent-name>-theme.css`:

```css
.theme-banking {
  --primary: #2563eb;
  --primary-hover: #1d4ed8;
  --accent: #10b981;
  /* ... override any CSS variables from variables.css */
}

.theme-banking[data-theme="dark"] {
  --primary: #3b82f6;
  --primary-hover: #60a5fa;
  /* ... dark mode overrides */
}
```

Import it in `aspect-react-client/src/styles/global.css`:
```css
@import './themes/banking-theme.css';
```

---

## Part 2: Adding a Crew Member to an Existing Agent

### 2.1 Create the Crew File

Create `aspect-agent-server/agents/<agent-name>/crew/<crew-name>.crew.js` extending `CrewMember`. See Part 3 for the full class reference.

### 2.2 Register in index.js

Add the export to `aspect-agent-server/agents/<agent-name>/crew/index.js`:

```js
const NewCrew = require('./new-crew.crew');
module.exports = {
  // ... existing exports
  NewCrew
};
```

That's it. The crew service dynamically loads all exports from `index.js`. No other server files need to change. The client auto-discovers crew members via the `/api/agents/:agentName/crew` API.

---

## Part 3: CrewMember Class Reference

Every crew member extends the base class at `aspect-agent-server/crew/base/CrewMember.js`. Read that file for the full implementation. Below is the complete reference.

### 3.1 Constructor Properties

Pass these to `super({...})` in the constructor:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Unique identifier within the agent (e.g., `"welcome"`, `"general"`) |
| `displayName` | `string` | Yes | Human-readable name shown in UI (e.g., `"Freeda - Guide"`) |
| `description` | `string` | Yes | Brief role description |
| `isDefault` | `boolean` | Yes | `true` for the entry-point crew member. Exactly one per agent must be default. |
| `guidance` | `string` | Yes | **The system prompt.** This is the main instruction text sent to the LLM. |
| `model` | `string` | No | LLM model (default: `"gpt-4o"`). Options: `"gpt-4o"`, `"gpt-4o-mini"`, `"gpt-5-chat-latest"`, etc. |
| `maxTokens` | `number` | No | Max response tokens (default: `2048`) |
| `tools` | `array` | No | Tool definitions. Each: `{ name, description, parameters, handler }` |
| `knowledgeBase` | `object\|null` | No | `{ enabled: true, storeId: "vs_..." }` or `null` |
| `fieldsToCollect` | `array` | No | Fields to extract from conversation: `[{ name: "age", description: "User's age" }]` |
| `transitionTo` | `string` | No | Target crew name for automatic transition |
| `transitionSystemPrompt` | `string` | No | System prompt injected once when transitioning TO this crew (see 3.6) |
| `oneShot` | `boolean` | No | If `true`, crew delivers one response then auto-transitions on next user message (see 3.7) |
| `persona` | `string` | No | Shared character/voice text for the agent. Auto-injected into context as `characterGuidance` by `buildContext()`. See [Part 3.8: Persona](#38-persona-shared-character-across-crews). |

### 3.2 Overridable Methods

These methods can be overridden in subclasses to customize behavior:

#### `async buildContext(params)`
Builds additional context that gets appended to the prompt as a `## Current Context` JSON section.

**params:** `{ conversation, user, collectedData, collectedFields, metadata }`

```js
async buildContext(params) {
  const baseContext = await super.buildContext(params);
  const collectedFields = params.collectedFields || {};

  // Load persisted context from previous crews
  const journeyProfile = await this.getContext('journey');

  return {
    ...baseContext,
    role: 'Your role description',
    userProfile: {
      userName: collectedFields.name || null,
      journeyData: journeyProfile,
    },
    customData: 'anything useful for the LLM',
  };
}
```

**Important:** The returned object is JSON-stringified and appended to the guidance string as:
```
<guidance text>

## Current Context
{ ...your context object }
```

#### `async preProcess(message, context)`
Pre-processes the user's message before sending to the LLM. Default returns the message unchanged.

```js
async preProcess(message, context) {
  // Example: add metadata to message
  return `[User: ${context.userProfile?.userName || 'Unknown'}] ${message}`;
}
```

### 3.3 Tools

Tools allow the LLM to call functions during a conversation. Define them in the constructor:

```js
tools: [
  {
    name: 'calculate_budget',
    description: 'Calculate a monthly budget based on income and expenses',
    parameters: {
      type: 'object',
      properties: {
        income: { type: 'number', description: 'Monthly income' },
        expenses: { type: 'array', items: { type: 'object' }, description: 'List of expenses' }
      },
      required: ['income']
    },
    handler: async (params, context) => {
      // Process and return result
      return { budget: params.income - totalExpenses, savings: savingsAmount };
    }
  }
]
```

For reusable tools, create them in `aspect-agent-server/functions/` following the pattern in `aspect-agent-server/functions/symptom-tracker/index.js` which exports `{ schema, handler }`.

### 3.4 Fields Collection & Automatic Transitions

The fields extractor is a built-in micro-agent (GPT-4o-mini) that automatically extracts field values from conversation messages. When a crew member defines `fieldsToCollect`, the dispatcher runs the extractor in parallel with the LLM response.

```js
fieldsToCollect: [
  { name: 'name', description: "The user's first name or preferred name" },
  { name: 'age', description: "The user's age, age range, or life stage" }
],
transitionTo: 'general',  // Transition target when all fields are collected
```

**Flow:**
1. User sends a message
2. Dispatcher starts extractor (GPT-4o-mini) + crew LLM stream in parallel
3. Extractor analyzes recent messages and extracts field values
4. `preMessageTransfer(allCollectedFields)` is called:
   - Returns `true` → discard crew response, transition to `transitionTo` crew
   - Returns `false` → flush crew response to client

**Note:** Because extraction runs in parallel, the LLM's context may be one message behind for collected fields. The dispatcher auto-injects a note about this. The `buildContext()` method should include `fieldsAlreadyCollected` and `fieldsStillNeeded` so the LLM knows what to ask for.

#### `getFieldsForExtraction(collectedFields)`

Override this method to control which fields the extractor sees at any given point. By default it returns all `fieldsToCollect`. Useful when a crew presents fields **sequentially** (e.g., consents one at a time) and you need to prevent the extractor from confusing similarly-described fields.

```js
// Example: consent crew - only expose the currently active consent
getFieldsForExtraction(collectedFields) {
  if (!collectedFields.first_consent || collectedFields.first_consent === 'rejected') {
    return this.fieldsToCollect.filter(f => f.name === 'first_consent');
  }
  if (collectedFields.first_consent === 'approved' && !collectedFields.second_consent) {
    return this.fieldsToCollect.filter(f => f.name === 'second_consent');
  }
  return this.fieldsToCollect;
}
```

**When to use:** When a crew has multiple fields with similar descriptions (e.g., multiple yes/no consents) and presents them one at a time. Without this override, the extractor may assign the user's response to the wrong field.

#### Extraction Modes

Set `extractionMode` in the constructor to control extraction behavior:

- **`'conversational'`** (default): Uses recent messages, GPT-4o-mini. Skips already-collected fields. Good for natural conversation flow.
- **`'form'`**: Strict mode, only last user message, GPT-4o. Supports **corrections** (user changing a previous answer). Good for structured data collection where values may change (e.g., consent rejected → approved).

```js
extractionMode: 'form',  // Enable correction support
```

### 3.5 Knowledge Base

When a crew member has a knowledge base, the LLM uses OpenAI's file_search tool to query a vector store.

```js
knowledgeBase: {
  enabled: true,
  storeId: 'vs_your_vector_store_id'  // OpenAI vector store ID
}
```

The dispatcher auto-injects a `knowledgeBaseNote` into the context telling the LLM not to mention "uploaded files" to the user — the KB files are internal reference material.

The client must also have `features.hasKnowledgeBase: true` in the agent config for the KB toggle to appear.

### 3.6 Transition System Prompt

When transitioning between crew members mid-conversation, historical messages can establish patterns so strong that the new crew's prompt gets partially ignored. The **transition system prompt** solves this by injecting a one-time `developer` role message into the conversation history at the moment of transition.

**Why `developer` role?** OpenAI's message hierarchy gives `developer` messages highest authority over `system` and `user` messages. This ensures the transition instruction overrides conflicting patterns from history.

**How it works:**
1. Define `transitionSystemPrompt` on the target crew member (in code or via prompt editor DB)
2. When a user transitions TO that crew, the dispatcher checks if this crew was the last one that had a transition prompt injected
3. If not (new transition), the `transitionSystemPrompt` is injected as a `developer` message just before the current user message
4. The crew's name is stored in `conversation.metadata.lastCrewWithTransitionPrompt` to prevent re-injection
5. On subsequent messages with the same crew, the prompt is NOT re-injected

### 3.7 One-Shot Crews

For crews that deliver a single message then transition (e.g., closures, announcements, greetings), use the `oneShot` property. This avoids complex field extraction or tool-based transition logic.

```js
{
  name: 'assessment_closure',
  transitionTo: 'general',
  oneShot: true,  // Delivers once, then auto-transitions
  guidance: `Deliver a closure summary...`
}
```

**How it works:**
1. First message to a oneShot crew → delivers its response normally
2. Dispatcher marks the crew as "delivered" in `conversation.metadata.oneShotDelivered`
3. On next user message → dispatcher sees oneShot + already delivered → skips to `transitionTo`
4. User's message is handled by the target crew

**When to use:**
- Transition announcements (e.g., "We've completed X, now let's move to Y")
- Closure summaries (e.g., assessment wrap-up)
- Welcome messages before main conversation
- Any "deliver once and move on" pattern

**Benefits over field-based:**
- No field extraction complexity
- No "stuck" states if extraction fails
- Cleaner, simpler code
- User response is handled by the right crew (not the transitional one)

### 3.8 Persona (Shared Character Across Crews)

The `persona` property lets you define a shared character/voice that applies to all crew members of an agent. It is automatically injected into the context (as `characterGuidance`) by the base `buildContext()`, so every crew gets it without any extra code.

**Why use persona?**
- Agents often have a distinct personality (tone, communication rules, domain philosophy) that should be consistent across all crew members
- Without persona, you'd either duplicate this content in every crew's `guidance` (fragile, hard to maintain) or add an agent-level system prompt (requires infrastructure changes)
- Persona is injected as **context** (not as the prompt itself), so it doesn't interfere with crew-specific guidance and **survives prompt overrides** in debug mode

**How it works:**
1. Create a persona module in your agent folder (e.g., `agents/freeda/freeda-persona.js`)
2. Each crew passes `persona: getPersona()` in its constructor
3. The base `buildContext()` adds it as `characterGuidance` to the context object
4. The LLM sees it in the `## Current Context` section alongside other context data

**What goes in persona vs crew guidance:**

| Persona (shared) | Crew Guidance (specific) |
|---|---|
| Character identity & personality | Process steps for this stage |
| Communication style & rules | Fields to collect |
| Domain philosophy & values | Transition-specific rules |
| Emotional handling patterns | Tools usage instructions |
| Language & tone rules | Stage-specific do's and don'ts |

**Example: Creating a persona module**

```js
// agents/my-agent/my-agent-persona.js
const MY_AGENT_PERSONA = `# MyAgent - Character & Voice

## Who You Are
You are MyAgent, a friendly financial advisor...

## Communication Style
- Keep responses under 3 sentences
- Always end with a question
...`;

function getPersona() {
  return MY_AGENT_PERSONA;
}

module.exports = { getPersona };
```

**Example: Using persona in a crew member**

```js
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../my-agent-persona');

class MyWelcomeCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'welcome',
      guidance: `## Your Role in This Stage
You are the welcome crew. Collect the user's name and preferred language.`,
      // ... other properties
    });
  }
}
```

The crew's `guidance` stays focused on what to do NOW. The persona provides the WHO - personality, tone, and values that apply across all stages.

**Relationship between persona and guidance:** The crew's `guidance` is the system prompt (the `instructions` field sent to the LLM). The persona is appended as context. If there's a conflict (e.g., persona says "2-3 sentences" but a closure crew needs a longer message), the crew's guidance naturally takes precedence because the LLM prioritizes direct instructions over context.

---

## Part 4: Transfer Methods (preMessageTransfer vs postMessageTransfer)

This is one of the most critical concepts for building crews with complex transition logic.

### 4.1 The Timing Difference

| Method | When It Runs | Use Case |
|--------|--------------|----------|
| `preMessageTransfer` | **BEFORE** the LLM response is sent to the client | Field-based collection (data extracted in parallel) |
| `postMessageTransfer` | **AFTER** the full LLM response (including tool calls) completes | Tool-based state management |

### 4.2 preMessageTransfer (Field-Based)

Use when you're collecting data via `fieldsToCollect` and want to transition **before** showing the current crew's response.

```js
class OnboardingCrew extends CrewMember {
  constructor() {
    super({
      name: 'onboarding',
      isDefault: true,
      fieldsToCollect: [
        { name: 'name', description: "User's name" },
        { name: 'goal', description: "User's goal" }
      ],
      transitionTo: 'main',
      // ...
    });
  }

  // Called BEFORE the response is sent to client
  async preMessageTransfer(collectedFields) {
    if (collectedFields.name && collectedFields.goal) {
      // Save context before transitioning
      await this.writeContext('profile', {
        name: collectedFields.name,
        goal: collectedFields.goal
      });
      return true;  // Transition NOW, discard current response
    }
    return false;  // Keep showing this crew's response
  }
}
```

**Flow:**
```
User message → Extractor runs in parallel → preMessageTransfer() →
  if true:  discard response, transition
  if false: send response to client
```

### 4.3 postMessageTransfer (Tool-Based)

Use when the LLM's **tool calls** update state that determines whether to transition. The tools run as part of the LLM response, so you must check state AFTER they complete.

```js
class SymptomAssessmentCrew extends CrewMember {
  constructor() {
    super({
      name: 'symptom_assessment',
      transitionTo: 'general',
      tools: [
        // Tools that update state during the response
        { name: 'complete_symptom_group', /* ... */ },
        { name: 'skip_symptom_group', /* ... */ }
      ],
      // NO fieldsToCollect - state managed by tools
    });
  }

  // Called AFTER the LLM response (including tool calls) completes
  async postMessageTransfer(collectedFields) {
    const state = await this.getContext('symptom_assessment', true);

    if (state?.groupsCompleted?.length >= 3) {
      console.log('✅ All groups complete, transitioning');

      // Save summary for the next crew
      await this.writeContext('symptom_summary', {
        outcomes: state.groupOutcomes,
        completedAt: new Date().toISOString()
      });

      return true;  // Trigger transition to 'general'
    }
    return false;
  }
}
```

**Flow:**
```
User message → LLM streams response → Tool calls run (update state) →
  Response sent → postMessageTransfer() →
  if true:  transition to next crew, stream their response too
  if false: done
```

### 4.4 Key Insight: Why postMessageTransfer Exists

The dispatcher originally only supported `preMessageTransfer`, which works well for field extraction because the extractor runs in parallel before the LLM response.

But for **tool-based crews**, the state is updated by tool calls **during** the LLM response. If you check state before the response (preMessageTransfer), the tools haven't run yet—the state is stale.

**Solution:** The dispatcher now also checks `postMessageTransfer` after streaming completes, for crews that have `transitionTo` and a `postMessageTransfer` method:

```js
// In dispatcher.service.js, at the end of _streamCrew():
if (crew.transitionTo && typeof crew.postMessageTransfer === 'function') {
  const shouldTransfer = await crew.postMessageTransfer(collectedFields);
  if (shouldTransfer) {
    yield { type: 'crew_transition', transition: { from, to, reason } };
    await conversationService.updateCurrentCrewMember(conversationId, crew.transitionTo);
    const targetCrew = await crewService.getCrewMember(agentName, crew.transitionTo);
    if (targetCrew) {
      yield* this._streamCrew(targetCrew, params);  // Stream target crew's response too
    }
  }
}
```

### 4.5 Decision Guide

| Scenario | Use This |
|----------|----------|
| Collecting structured data (name, age, preferences) | `fieldsToCollect` + `preMessageTransfer` |
| Tool calls update state that determines transition | `postMessageTransfer` (no fieldsToCollect) |
| Need to transition based on conversation content | Either, depending on extraction timing |
| Multi-phase assessment with explicit "done" signals | `postMessageTransfer` with state-updating tools |

### 4.6 Transition Rules (Debug Visualization)

Crew transition logic is code-based (JavaScript if-statements), which gives full flexibility. To help debug **why a transition didn't happen**, you can optionally define `transitionRules` — structured metadata that the debug panel evaluates and displays as pass/fail.

**Without `transitionRules`**: Debug panel shows the raw function code of `preMessageTransfer` / `postMessageTransfer`.

**With `transitionRules`**: Debug panel shows structured evaluation with checkmarks for each condition.

```javascript
// In your crew constructor:
super({
  name: 'introduction',
  transitionTo: 'profiler',
  fieldsToCollect: [...],

  // Optional: structured rules for debug visualization
  transitionRules: [
    {
      id: 'ineligible_male',
      type: 'pre',  // 'pre' = preMessageTransfer, 'post' = postMessageTransfer
      condition: {
        description: 'User is male',
        fields: ['gender'],
        evaluate: (fields) => {
          const gender = fields.gender?.toLowerCase();
          return gender === 'male' || gender === 'man';
        }
      },
      result: { action: 'transition', target: 'ineligible' },
      priority: 1  // Lower numbers evaluated first
    },
    {
      id: 'eligible_complete',
      type: 'pre',
      condition: {
        description: 'Name, age, and ToS collected; age >= 38',
        fields: ['name', 'age', 'tos_acknowledged'],
        evaluate: (fields) => {
          const hasAll = !!fields.name && !!fields.age && !!fields.tos_acknowledged;
          const age = parseInt(String(fields.age).match(/\d+/)?.[0] || '0', 10);
          return hasAll && age >= 38;
        }
      },
      result: { action: 'transition', target: 'profiler' },
      priority: 10
    }
  ]
});
```

**Rule structure:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier for the rule |
| `type` | `'pre'` \| `'post'` | Which transfer method this rule mirrors |
| `condition.description` | `string` | Human-readable description shown in debug panel |
| `condition.fields` | `string[]` | Which collected fields this rule depends on |
| `condition.evaluate` | `(fields, context) => boolean` | Evaluation function — should mirror the real logic |
| `result` | `{ action, target? }` | What happens when the rule passes |
| `priority` | `number` | Evaluation order (lower = first) |

> **Important:** `transitionRules` are for **debug visualization only**. The actual transition logic still lives in your `preMessageTransfer` / `postMessageTransfer` methods. Keep the rule `evaluate` functions in sync with your real code.

---

## Part 5: Tool-Based State Management

When a crew uses tools to manage state (instead of `fieldsToCollect`), follow this pattern.

### 5.1 State in Context

Store crew-specific state in the context system:

```js
// Initialize state in buildContext()
async buildContext(params) {
  let state = await this.getContext('assessment_state', true);  // conversation-level

  if (!state) {
    state = {
      currentPhase: 'phase1',
      phasesCompleted: [],
      startedAt: new Date().toISOString()
    };
    await this.writeContext('assessment_state', state, true);
  }

  return {
    ...baseContext,
    currentPhase: state.currentPhase,
    phasesCompleted: state.phasesCompleted
  };
}
```

### 5.2 Tools Update State

Tools should update the context and return useful information for the LLM:

```js
{
  name: 'complete_phase',
  description: 'Call when the current phase is complete',
  parameters: {
    type: 'object',
    properties: {
      phase: { type: 'string', enum: ['phase1', 'phase2', 'phase3'] }
    },
    required: ['phase']
  },
  handler: async (params) => {
    const state = await this.getContext('assessment_state', true);

    if (!state.phasesCompleted.includes(params.phase)) {
      state.phasesCompleted.push(params.phase);
    }

    // Determine next phase
    const allPhases = ['phase1', 'phase2', 'phase3'];
    const nextPhase = allPhases.find(p => !state.phasesCompleted.includes(p));
    state.currentPhase = nextPhase || null;

    await this.writeContext('assessment_state', state, true);

    return {
      recorded: true,
      completedPhase: params.phase,
      nextPhase,
      allComplete: state.phasesCompleted.length >= 3,
      message: nextPhase
        ? `Phase ${params.phase} complete. Moving to ${nextPhase}.`
        : 'All phases complete!'
    };
  }
}
```

### 5.3 postMessageTransfer Checks State

After the LLM's tool calls run, check if it's time to transition:

```js
async postMessageTransfer(collectedFields) {
  const state = await this.getContext('assessment_state', true);

  if (state?.phasesCompleted?.length >= 3) {
    // Save summary for next crew
    await this.writeContext('assessment_summary', {
      phasesCompleted: state.phasesCompleted,
      completedAt: new Date().toISOString()
    });
    return true;  // Transition
  }
  return false;
}
```

---

## Part 6: Context System

The context system allows crews to persist and share data across conversations.

### 6.1 Two Levels

| Level | Storage Key | Use Case |
|-------|-------------|----------|
| **User-level** | `(userId, namespace)` | Persists across all conversations (journey profile, preferences) |
| **Conversation-level** | `(userId, conversationId, namespace)` | Specific to one conversation (session state, assessment progress) |

### 6.2 Context Methods

Available on all crew members (injected by dispatcher):

```js
// Read context (default: user-level)
const data = await this.getContext('namespace');

// Read conversation-level context
const convData = await this.getContext('namespace', true);

// Write context (replaces entire namespace)
await this.writeContext('namespace', { key: 'value' });
await this.writeContext('namespace', data, true);  // conversation-level

// Merge context (shallow merge into existing)
await this.mergeContext('namespace', { newKey: 'value' });
```

### 6.3 Pattern: Profiler Saves, General Reads

```js
// Profiler crew saves journey data
class ProfilerCrew extends CrewMember {
  async preMessageTransfer(collectedFields) {
    if (collectedFields.menstrual_status) {
      const analysis = this._analyzeJourney(collectedFields);

      await this.writeContext('journey', {
        menstrualStatus: collectedFields.menstrual_status,
        analysis,
        profiledAt: new Date().toISOString()
      });

      return true;  // Transition to next crew
    }
    return false;
  }
}

// General crew reads journey data
class GeneralCrew extends CrewMember {
  async buildContext(params) {
    const journeyProfile = await this.getContext('journey');

    return {
      ...baseContext,
      journeyPosition: journeyProfile?.analysis?.estimatedPosition,
      toneAdjustment: journeyProfile?.analysis?.toneAdjustment
    };
  }
}
```

---

## Part 7: Client-Side SSE Callbacks

The client's `useChat` hook accepts callbacks for events streamed from the server.

### 7.1 Available Callbacks

```tsx
const chat = useChat({
  config,
  conversationId,
  userId,

  // Called when crew transitions
  onCrewTransition: (transition) => {
    console.log(`Transition: ${transition.from} → ${transition.to}`);
    // Update UI, record visited crews, etc.
  },

  // Called when a field is extracted
  onFieldExtracted: () => {
    // Trigger refresh of fields panel
    setFieldsRefreshKey(prev => prev + 1);
  },
});
```

### 7.2 ChatContext Integration

The `ChatProvider` connects these callbacks to state updates:

```tsx
// In ChatContext.tsx
const [fieldsRefreshKey, setFieldsRefreshKey] = useState(0);

const chat = useChat({
  // ...
  onCrewTransition: (transition) => {
    crew.addVisitedCrew(transition.from);
    const newCrew = crew.crewMembers.find(c => c.name === transition.to);
    if (newCrew) {
      crew.setCurrentCrew(newCrew);
    }
  },
  onFieldExtracted: () => {
    setFieldsRefreshKey(prev => prev + 1);
  },
});
```

### 7.3 Using refreshKey for Panel Reload

Components can use `refreshKey` to trigger data reload:

```tsx
function FieldsEditorPanel({ refreshKey }) {
  const [fields, setFields] = useState({});

  useEffect(() => {
    loadFields();  // Reload when refreshKey changes
  }, [loadFields, refreshKey]);
}
```

---

## Part 8: Tool Design Patterns

### 8.1 Split Tools for Different Outcomes

Instead of one tool with multiple outcomes, create separate tools with explicit descriptions. This helps the LLM understand exactly when to call each.

**Bad: Single confusing tool**
```js
{
  name: 'complete_group',
  description: 'Complete a symptom group',
  parameters: {
    outcome: { enum: ['symptoms_found', 'no_symptoms', 'skipped'] }
  }
}
```

**Good: Separate tools with clear triggers**
```js
// Tool 1: For when symptoms WERE found
{
  name: 'complete_symptom_group',
  description: `Call this AFTER you have recorded symptoms using report_symptom
    and finished exploring this group. Use when user says "that covers it", etc.`,
  parameters: { symptom_group: { enum: ['emotional', 'cognitive', 'physical'] } }
}

// Tool 2: For when NO symptoms
{
  name: 'skip_symptom_group',
  description: `Call this when user confirms they have NO symptoms in this group.
    IMPORTANT: Call immediately when user says:
    - "I don't have any of those"
    - "None apply to me"
    - "אין לי" / "לא"
    Do NOT wait - call this immediately!`,
  parameters: { symptom_group, user_statement }
}
```

### 8.2 Tool Descriptions Are Prompts

The tool `description` is essentially a prompt for when to use the tool. Be explicit:

```js
{
  name: 'report_symptom',
  description: `Record a symptom the user mentions during assessment.

    Call this tool for EACH symptom identified, not once for multiple.

    Examples of when to call:
    - User says "I've been having hot flashes" → call with symptom "hot flashes"
    - User says "my sleep has been terrible" → call with symptom "sleep disturbance"

    Do NOT call if:
    - User is just asking a question about symptoms
    - User denies having a symptom`,
  parameters: { /* ... */ }
}
```

### 8.3 Tools Should Return Guidance

Return information that helps the LLM continue appropriately:

```js
handler: async (params) => {
  // ... update state ...

  return {
    recorded: true,
    nextStep: nextPhase ? `explore ${nextPhase}` : 'transition',
    message: 'Symptom recorded. Ask about impact and timing.',
    suggestedFollowUp: 'How much does this affect your daily life?'
  };
}
```

---

## Part 9: Complete Example: Tool-Based Crew

Here's a full example of a crew that uses tools for state management and `postMessageTransfer` for transitions.

```js
// aspect-agent-server/agents/myagent/crew/assessment.crew.js
const CrewMember = require('../../../crew/base/CrewMember');

class MyAgentAssessmentCrew extends CrewMember {
  constructor() {
    super({
      name: 'assessment',
      displayName: 'Assessment',
      description: 'Multi-phase assessment with tool-based state',
      isDefault: false,
      transitionTo: 'main',

      guidance: `You are conducting a 3-phase assessment.

## CONTEXT VARIABLES
- currentPhase: Which phase to explore now
- phasesCompleted: Which phases are done

## YOUR TASK
1. Explore the current phase with the user
2. When the user indicates completion, call complete_phase
3. The system will tell you the next phase

## TOOLS
- complete_phase: Call when user confirms current phase is done`,

      model: 'gpt-4o',
      maxTokens: 1536,
      tools: [],  // Set below with context access
      knowledgeBase: null
    });

    // Set up tools with context wrappers
    this.tools = [
      {
        name: 'complete_phase',
        description: `Call when user confirms the current phase is complete.
          Triggers: "that's all", "I'm done with this", "nothing else"`,
        parameters: {
          type: 'object',
          properties: {
            phase: {
              type: 'string',
              enum: ['phase1', 'phase2', 'phase3'],
              description: 'The phase that was just completed'
            }
          },
          required: ['phase']
        },
        handler: async (params) => {
          let state = await this.getContext('assessment', true) || {
            currentPhase: 'phase1',
            phasesCompleted: []
          };

          if (!state.phasesCompleted.includes(params.phase)) {
            state.phasesCompleted.push(params.phase);
          }

          const allPhases = ['phase1', 'phase2', 'phase3'];
          const nextPhase = allPhases.find(p => !state.phasesCompleted.includes(p));
          state.currentPhase = nextPhase;

          await this.writeContext('assessment', state, true);

          return {
            recorded: true,
            nextPhase,
            allComplete: state.phasesCompleted.length >= 3,
            message: nextPhase
              ? `Moving to ${nextPhase}`
              : 'Assessment complete!'
          };
        }
      }
    ];
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);

    let state = await this.getContext('assessment', true);
    if (!state) {
      state = { currentPhase: 'phase1', phasesCompleted: [] };
      await this.writeContext('assessment', state, true);
    }

    return {
      ...baseContext,
      currentPhase: state.currentPhase,
      phasesCompleted: state.phasesCompleted,
      instruction: `Explore ${state.currentPhase}. ${state.phasesCompleted.length}/3 complete.`
    };
  }

  // MUST be postMessageTransfer because tools update state during response
  async postMessageTransfer(collectedFields) {
    const state = await this.getContext('assessment', true);

    if (state?.phasesCompleted?.length >= 3) {
      // Save summary for next crew
      await this.writeContext('assessment_summary', {
        phasesCompleted: state.phasesCompleted,
        completedAt: new Date().toISOString()
      });
      return true;  // Transition to 'main'
    }
    return false;
  }
}

module.exports = MyAgentAssessmentCrew;
```

---

## Part 9: Thinker+Talker Crews (ThinkingAdvisorAgent)

A **thinker+talker** crew uses two LLMs per message: a **thinker** (Claude) that analyzes the conversation and produces structured advice, and a **talker** (GPT-5) that speaks to the user naturally based on that advice. This pattern is useful for crews that need strategic reasoning (e.g., sales conversations, complex assessments) without exposing the reasoning to the user.

### 9.1 How It Works

```
User message → Dispatcher → buildContext() → Thinker (Claude) → advice JSON
                                            → Talker (GPT-5) sees advice in context → response
```

The thinker runs inside `buildContext()` — which is already async and executes before the LLM call. No dispatcher changes are needed.

### 9.2 ThinkingAdvisorAgent (Micro-Agent)

Located at `crew/micro-agents/ThinkingAdvisorAgent.js`. A general-purpose reusable micro-agent (like FieldsExtractorAgent). Any crew can use it.

The thinker receives **two inputs**:
- **`thinkingPrompt`** (system prompt) — defines the reasoning task, JSON schema, and strategy rules
- **`context`** (user message) — the data to reason about (conversation history, profile, domain data)

Nothing else is injected. The only addition is a `jsonOutput` instruction appended by the LLM service ("Respond with valid JSON only").

```js
const thinkingAdvisor = require('../../../crew/micro-agents/ThinkingAdvisorAgent');

// Inside buildContext():
const advice = await thinkingAdvisor.think({
  thinkingPrompt: THINKING_PROMPT,  // System prompt with JSON schema
  context: thinkerContext            // Domain data + conversation history
});
// advice is the parsed JSON object
```

Options (second argument):
- `model` — default: `'claude-sonnet-4-20250514'`
- `maxTokens` — default: `1024`
- `jsonOutput` — default: `true` (parses response as JSON)

### 9.3 Crew Setup

A thinker crew has three key differences from a standard crew:

**1. `this.usesThinker = true`** — Set this flag in the constructor (after `super()`). This tells the dispatcher to emit a `thinking_advisor_start` SSE event before `buildContext()` runs, so the client shows a thinking indicator ("מנתח את השיחה...") during the 1-2 second thinker wait. Without this flag, the UI appears stalled.

```js
class MyThinkerCrew extends CrewMember {
  constructor() {
    super({
      name: 'my-crew',
      model: 'gpt-5-chat-latest',
      fieldsToCollect: [],  // Thinker replaces the field extractor
      guidance: `You receive "thinkingAdvice" in context. Follow it...`,
      // ...
    });

    this.usesThinker = true;        // Must be set AFTER super()
    this.thinkingPrompt = THINKING_PROMPT;  // Store for debug override support
  }
}
```

> **Important:** `usesThinker` and `thinkingPrompt` must be set after the `super()` call, not inside the options object. The base `CrewMember` constructor only stores known properties — arbitrary options are silently ignored.

**2. `fieldsToCollect: []`** — The thinker replaces the field extractor. The dispatcher skips parallel extraction when `fieldsToCollect` is empty. All data collection happens through conversation analysis by the thinker.

**3. `this.thinkingPrompt`** — Store your thinking prompt constant on the instance. The dispatcher uses this for debug session overrides — it temporarily replaces `this.thinkingPrompt` before `buildContext()` runs, then restores the original after. In `buildContext()`, always use `this.thinkingPrompt` (not the constant directly) so overrides take effect:

```js
// ✅ Correct — supports debug overrides
thinkingAdvisor.think({ thinkingPrompt: this.thinkingPrompt, context: thinkerContext });

// ❌ Wrong — ignores debug overrides
thinkingAdvisor.think({ thinkingPrompt: THINKING_PROMPT, context: thinkerContext });
```

**4. `buildContext()` calls the thinker** — The thinker runs inside `buildContext`, returns structured advice, and the advice is included in the context for the talker.

### 9.4 buildContext Pattern

```js
async buildContext(params) {
  const baseContext = await super.buildContext(params);

  // Gather data for the thinker
  const profile = await this.getContext('my_profile', true) || {};
  const prevState = await this.getContext('advisor_state', true) || {};
  let historyText = '(no history)';
  if (this._externalConversationId) {
    const history = await conversationService.getConversationHistory(
      this._externalConversationId, 20
    );
    historyText = history.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');
  }

  // When thinking prompt is overridden (debug), send only conversation history.
  // Including previous state / domain data would bias the thinker toward the
  // original JSON schema, defeating the purpose of the override.
  const isThinkingOverridden = this.thinkingPrompt !== THINKING_PROMPT;

  const thinkerContext = isThinkingOverridden
    ? `## Conversation\n${historyText}`
    : `## Customer\n${JSON.stringify(profile)}\n\n## Previous State\n${JSON.stringify(prevState)}\n\n## Conversation\n${historyText}`;

  // Run the thinker — use this.thinkingPrompt (not the constant) for override support
  let thinkingAdvice = { fallback: true };
  try {
    thinkingAdvice = await thinkingAdvisor.think({
      thinkingPrompt: this.thinkingPrompt,
      context: thinkerContext
    });
  } catch (err) {
    console.error('Thinker error:', err.message);
  }

  // Fallback if thinker failed
  if (thinkingAdvice.fallback || thinkingAdvice.error) {
    thinkingAdvice = { nextQuestion: 'Ask a basic question.', /* ... */ };
  }

  // Persist state for postThinkingTransfer
  await this.writeContext('advisor_state', {
    recommendedOffer: thinkingAdvice.recommendedOffer || null,
    offerAccepted: thinkingAdvice.offerAccepted === true
  }, true);

  return {
    ...baseContext,
    thinkingAdvice,  // Talker sees this in context
  };
}
```

### 9.5 Writing a Thinking Prompt

The thinking prompt is the system prompt sent to the thinker LLM. It defines **what to analyze**, **how to reason**, and **what JSON schema to return**. A well-structured thinking prompt has three parts:

**1. Role & goal** — Tell the thinker what it is and what it's trying to achieve.

**2. JSON schema** — Define the exact fields you want back. Group them logically with comments.

**3. Strategy rules** — How the thinker should reason (when to recommend, what to prioritize, edge cases).

#### The `_thinkingDescription` Field

Every thinking prompt **must** include a `_thinkingDescription` field in its JSON schema. This field is displayed in the UI thinking indicator as a live summary of what the thinker decided. Without it, the thinking step shows raw JSON which is not user-friendly.

```js
const THINKING_PROMPT = `You are a strategic advisor. Analyze the conversation and return JSON:
{
  // ── Display (shown in UI thinking indicator) ──
  "_thinkingDescription": "short summary of what you decided — e.g. 'Asking about budget' or 'Ready to recommend Plan A'",

  // ── Your domain fields ──
  "nextQuestion": "...",
  "strategy": "...",
  // ...
}`;
```

**Guidelines for `_thinkingDescription`:**
- Keep it short (5-15 words) — it appears as a single line in the thinking step
- Describe the **decision**, not the data — "Profiling: asking about employment" not "employment is null"
- Use present tense — "Recommending Plus plan" not "Recommended Plus plan"
- Make it specific to this turn — "Layer 2: offering credit card" not "Processing request"

> **Tip:** The ThinkingAdvisor enforces a fallback — if the thinker response is missing `_thinkingDescription`, it defaults to `"Thinking..."`. But always include it in your prompt for meaningful display text.

### 9.6 Thinker-Driven Transitions (`postThinkingTransfer`)

Thinker crews use `postThinkingTransfer` — a transfer method that runs after `buildContext` completes but **before the talker responds**. This means the thinker can analyze the latest user message and trigger an immediate transition in the same turn, with no one-turn delay.

```
Flow: buildContext (thinker runs) → postThinkingTransfer → if true: skip talker, transition
                                                         → if false: talker responds normally
```

```js
async postThinkingTransfer(context) {
  const advice = context.thinkingAdvice;
  if (!advice?.readyToTransfer) return false;

  // Write transition data for the next crew
  await this.mergeContext('my_profile', {
    currentStep: 'review',
    acceptedOffer: advice.recommendedOffer
  }, true);

  return true;  // Triggers immediate transition to transitionTo crew
}
```

**Why not `preMessageTransfer`?** `preMessageTransfer` runs before `buildContext`, so it can only read state from the *previous* thinker run (one-turn delay). `postThinkingTransfer` reads the *current* thinker output directly from the context object — no delay, no stale state.

**Why not `postMessageTransfer`?** `postMessageTransfer` runs after the talker responds. For transitions, this means the talker would respond first (potentially saying something irrelevant) and the transition happens on the next turn.

### 9.7 Debug & Thinking Steps

The dispatcher automatically handles two SSE events for thinker crews:

| Event | When | What it shows |
|-------|------|---------------|
| `thinking_advisor_start` | Before `buildContext` (requires `usesThinker` flag) | Thinking step: "מנתח את השיחה..." with pulsing animation |
| `thinking_advisor` | After `buildContext`, if `context.thinkingAdvice` exists | Thinking step with thinker's strategy summary |

The `_thinkingDescription` field from the thinker's JSON response is displayed as the thinking step summary. The full `thinkingAdvice` JSON is also included in the debug panel (`debug_prompt` data) under "Thinking Advice".

**Debug override:** The thinking prompt can be temporarily overridden per session from the debug Prompt Editor panel. When overridden, the dispatcher replaces `crew.thinkingPrompt` before `buildContext()` runs and restores it after. The crew's `buildContext` should send only conversation history as context when overridden (no previous state or domain data) to avoid biasing the thinker toward the original schema.

### 9.8 Key Files

| File | Purpose |
|------|---------|
| `crew/micro-agents/ThinkingAdvisorAgent.js` | Reusable thinker micro-agent |
| `agents/banking-onboarder-v2/crew/main-conversation.crew.js` | Complete example of a thinker+talker crew |
| `agents/banking-onboarder-v2/offers-catalog.js` | Static data module passed to thinker |

---

## Quick Reference: File Locations

### Server
| File | Purpose |
|------|---------|
| `crew/base/CrewMember.js` | **Base class** - read this for all available properties and methods |
| `crew/services/crew.service.js` | Crew loading and discovery (auto-loads from agents folder) |
| `crew/services/dispatcher.service.js` | Message routing, field extraction, crew transitions |
| `services/context.service.js` | Context CRUD operations |
| `agents/<name>/crew/index.js` | Crew member exports for an agent |
| `agents/<name>/crew/*.crew.js` | Individual crew member files |
| `functions/` | Reusable tool implementations |
| `db/seed.js` | Database seed for agent records |
| `db/schema/index.js` | Database schema |
| `server.js` | API endpoints (streaming at `/api/finance-assistant/stream`) |

### Client
| File | Purpose |
|------|---------|
| `src/types/agent.ts` | **AgentConfig interface** - read this for all config fields |
| `src/agents/*.config.ts` | Agent configuration files |
| `src/pages/*Page.tsx` | Agent page components |
| `src/context/ChatContext.tsx` | Chat state management with SSE callbacks |
| `src/hooks/useChat.ts` | Chat hook with streaming |
| `src/services/chatService.ts` | SSE streaming service |
| `src/App.tsx` | Router - add new routes here |
| `src/styles/themes/` | Theme CSS files per agent |

### Key Examples
| Pattern | Example File |
|---------|--------------|
| Field-based crew | `agents/freeda/crew/introduction.crew.js` |
| Tool-based crew with postMessageTransfer | `agents/freeda/crew/symptom-assessment.crew.js` |
| One-shot transitional crew | `agents/freeda/crew/assessment-closure.crew.js` |
| Split tools for clarity | `functions/symptom-group-completion.js` |
| Context persistence | `agents/freeda/crew/profiler.crew.js` |
| Thinker+talker crew | `agents/banking-onboarder-v2/crew/main-conversation.crew.js` |

---

## Changelog

### v2.2 (2026-03)
- Added **Part 9: Thinker+Talker Crews** - ThinkingAdvisorAgent micro-agent, `usesThinker` flag, thinker-driven transitions, debug integration
- Added **`postThinkingTransfer`** - new transfer method for thinker crews (runs after buildContext, before talker). No one-turn delay.
- Added **Section 9.5: Writing a Thinking Prompt** - thinking prompt structure, `_thinkingDescription` convention for UI display
- Added **`this.thinkingPrompt`** convention - store prompt on instance for debug override support, use `this.thinkingPrompt` in buildContext (not constant)
- Updated **Section 9.4** - override-aware buildContext pattern (skip domain data when prompt is overridden)

### v2.1 (2025-02)
- Added **oneShot crews** - for transitional/announcement crews that deliver once then auto-transition
- Added section 3.7 documenting oneShot property and behavior

### v2.0 (2025-02)
- Added **Part 4: Transfer Methods** - detailed explanation of `preMessageTransfer` vs `postMessageTransfer`
- Added **Part 5: Tool-Based State Management** - pattern for crews without fieldsToCollect
- Added **Part 6: Context System** - getContext/writeContext for persisting state
- Added **Part 7: Client-Side SSE Callbacks** - onCrewTransition, onFieldExtracted
- Added **Part 8: Tool Design Patterns** - split tools, descriptive prompts
- Added complete example of tool-based crew with postMessageTransfer

### v1.0 (2024-12)
- Initial guide with basic agent and crew creation
- Field-based collection and preMessageTransfer
- Transition system prompts
