# Agent Building Guide

This guide explains how to add new agents and crew members to the Aspect platform. It is intended to be read by an AI assistant (e.g., Claude Code) so it can build the actual code files from a description.

---

## Architecture Overview

Each **agent** is a self-contained AI assistant (e.g., Freeda for menopause, Aspect for business intelligence). Agents can optionally have **crew members** — specialized sub-agents that handle different phases or topics in a conversation. A **dispatcher** routes messages to the correct crew member and handles transitions between them.

**Key flow:** `Client → Server endpoint → Dispatcher → Crew Member → LLM → Streaming response back to client`

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
| `model` | `string` | No | LLM model (default: `"gpt-4o"`). Options: `"gpt-4o"`, `"gpt-4o-mini"`, etc. |
| `maxTokens` | `number` | No | Max response tokens (default: `2048`) |
| `tools` | `array` | No | Tool definitions. Each: `{ name, description, parameters, handler }` |
| `knowledgeBase` | `object\|null` | No | `{ enabled: true, storeId: "vs_..." }` or `null` |
| `fieldsToCollect` | `array` | No | Fields to extract from conversation: `[{ name: "age", description: "User's age" }]` |
| `transitionTo` | `string` | No | Target crew name for automatic transition after all fields are collected |
| `transitionSystemPrompt` | `string` | No | System prompt injected once when transitioning TO this crew (see 3.7) |

### 3.2 Overridable Methods

These methods can be overridden in subclasses to customize behavior:

#### `async buildContext(params)`
Builds additional context that gets appended to the prompt as a `## Current Context` JSON section.

**params:** `{ conversation, user, collectedData, collectedFields, metadata }`

```js
async buildContext(params) {
  const baseContext = await super.buildContext(params);
  const collectedFields = params.collectedFields || {};

  return {
    ...baseContext,
    role: 'Your role description',
    userProfile: {
      userName: collectedFields.name || null,
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

#### `async preMessageTransfer(collectedFields)`
Called BEFORE the crew's response is sent. Return `true` to discard the response and transition to `transitionTo`. Used when you want to transfer as soon as certain fields are collected, without showing the current crew's response.

```js
async preMessageTransfer(collectedFields) {
  return !!collectedFields.name && !!collectedFields.age;
}
```

#### `async postMessageTransfer(collectedFields)`
Called AFTER the crew's response is sent. Return `true` to transition on the next message. The current response is still delivered.

#### `async checkTransition(params)`
General-purpose transition check. Can return a transition object `{ to: 'crewName', reason: 'why' }` or `null`.

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

### 3.6 Complete Example: Two-Crew Agent

```js
// aspect-agent-server/agents/banking/crew/onboarding.crew.js
const CrewMember = require('../../../crew/base/CrewMember');

class BankingOnboardingCrew extends CrewMember {
  constructor() {
    super({
      name: 'onboarding',
      displayName: 'Banking - Onboarding',
      description: 'Collects user financial profile',
      isDefault: true,

      fieldsToCollect: [
        { name: 'name', description: "User's name" },
        { name: 'financial_goal', description: "Primary financial goal (saving, investing, debt)" }
      ],
      transitionTo: 'advisor',

      guidance: `You are a friendly banking onboarding assistant.

## YOUR PURPOSE
Collect the user's name and primary financial goal through natural conversation.

## RULES
- Keep responses to 2-3 sentences
- Be warm and professional
- Do not give financial advice yet - just collect info`,

      model: 'gpt-4o',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    return !!collectedFields.name && !!collectedFields.financial_goal;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};
    const missing = this.fieldsToCollect.filter(f => !collectedFields[f.name]);
    const collected = this.fieldsToCollect.filter(f => !!collectedFields[f.name]);

    return {
      ...baseContext,
      role: 'Onboarding and profile collection',
      fieldsAlreadyCollected: collected.map(f => `${f.name}: ${collectedFields[f.name]}`),
      fieldsStillNeeded: missing.map(f => `${f.name} - ${f.description}`),
      instruction: missing.length > 0
        ? `You still need to ask for: ${missing.map(f => f.name).join(', ')}.`
        : 'All fields collected. The system will transition automatically.',
      note: 'The fields above reflect state from previous messages. The user\'s current message may contain new field values - check it directly and do not re-ask for information already provided in this message.'
    };
  }
}

module.exports = BankingOnboardingCrew;
```

```js
// aspect-agent-server/agents/banking/crew/advisor.crew.js
const CrewMember = require('../../../crew/base/CrewMember');

class BankingAdvisorCrew extends CrewMember {
  constructor() {
    super({
      name: 'advisor',
      displayName: 'Banking - Advisor',
      description: 'Personal finance advisor',
      isDefault: false,

      guidance: `You are a professional personal finance advisor.

## PURPOSE
Provide personalized financial guidance based on the user's profile and goals.

## RULES
- Use the user's name from context
- Tailor advice to their stated financial goal
- Keep responses concise (3-4 sentences)
- Always end with a follow-up question`,

      model: 'gpt-4o',
      maxTokens: 2048,
      tools: [],
      knowledgeBase: null
    });
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    return {
      ...baseContext,
      role: 'Personal finance advisor',
      userProfile: {
        userName: collectedFields.name || null,
        financialGoal: collectedFields.financial_goal || null,
      }
    };
  }
}

module.exports = BankingAdvisorCrew;
```

```js
// aspect-agent-server/agents/banking/crew/index.js
const BankingOnboardingCrew = require('./onboarding.crew');
const BankingAdvisorCrew = require('./advisor.crew');

module.exports = {
  BankingOnboardingCrew,
  BankingAdvisorCrew
};
```

### 3.7 Transition System Prompt

When transitioning between crew members mid-conversation, historical messages can establish patterns so strong that the new crew's prompt gets partially ignored. The **transition system prompt** solves this by injecting a one-time `developer` role message into the conversation history at the moment of transition.

**Why `developer` role?** OpenAI's message hierarchy gives `developer` messages highest authority over `system` and `user` messages. This ensures the transition instruction overrides conflicting patterns from history.

**How it works:**
1. Define `transitionSystemPrompt` on the target crew member (in code or via prompt editor DB)
2. When a user transitions TO that crew, the dispatcher checks if this crew was the last one that had a transition prompt injected
3. If not (new transition), the `transitionSystemPrompt` is injected as a `developer` message just before the current user message
4. The crew's name is stored in `conversation.metadata.lastCrewWithTransitionPrompt` to prevent re-injection
5. On subsequent messages with the same crew, the prompt is NOT re-injected

**Example:**

```js
// aspect-agent-server/agents/finance/crew/advisor.crew.js
class FinanceAdvisorCrew extends CrewMember {
  constructor() {
    super({
      name: 'advisor',
      displayName: 'Finance Advisor',
      description: 'Personal finance advisor',
      isDefault: false,

      guidance: `You are a professional finance advisor...`,

      // Injected once when user transitions from another crew to this one
      transitionSystemPrompt: `CRITICAL ROLE CHANGE: You are now the Finance Advisor.
Your previous responses in this conversation were from a different assistant role.
From this point forward, respond ONLY as the Finance Advisor. Do not reference
your previous persona. The user is now speaking with you, the finance expert.
Introduce yourself briefly and ask how you can help with their finances.`,

      model: 'gpt-4o',
    });
  }
}
```

**Hierarchy:** Database value > code value. If a `transitionSystemPrompt` is saved in the prompt editor (DB), it takes precedence over the code-defined value.

**Testing:** In debug mode, the PromptEditorPanel shows a "Transition System Prompt" section. You can edit it there and use the "Fire Now" button to manually inject it into the current conversation for testing without requiring an actual crew transition.

---

## Quick Reference: File Locations

### Server
| File | Purpose |
|------|---------|
| `aspect-agent-server/crew/base/CrewMember.js` | **Base class** - read this for all available properties and methods |
| `aspect-agent-server/crew/services/crew.service.js` | Crew loading and discovery (auto-loads from agents folder) |
| `aspect-agent-server/crew/services/dispatcher.service.js` | Message routing, field extraction, crew transitions |
| `aspect-agent-server/agents/<name>/crew/index.js` | Crew member exports for an agent |
| `aspect-agent-server/agents/<name>/crew/*.crew.js` | Individual crew member files |
| `aspect-agent-server/db/seed.js` | Database seed for agent records |
| `aspect-agent-server/db/schema/index.js` | Database schema (agents, conversations, messages tables) |
| `aspect-agent-server/server.js` | API endpoints (streaming at `/api/finance-assistant/stream`) |
| `aspect-agent-server/functions/` | Reusable tool implementations |
| `aspect-agent-server/agents/freeda/crew/welcome.crew.js` | Example: fields collection crew with transitions |
| `aspect-agent-server/agents/freeda/crew/general.crew.js` | Example: main crew with tools and knowledge base |

### Client
| File | Purpose |
|------|---------|
| `aspect-react-client/src/types/agent.ts` | **AgentConfig interface** - read this for all config fields |
| `aspect-react-client/src/agents/*.config.ts` | Agent configuration files |
| `aspect-react-client/src/pages/*Page.tsx` | Agent page components |
| `aspect-react-client/src/App.tsx` | Router - add new routes here |
| `aspect-react-client/src/styles/themes/` | Theme CSS files per agent |
| `aspect-react-client/src/styles/global.css` | Import new theme files here |
| `aspect-react-client/src/agents/freeda.config.ts` | Example: full agent config with KB and crew |
| `aspect-react-client/src/agents/aspect.config.ts` | Example: simpler agent config without crew |
