# Crew Architecture Guide

This document describes the architecture for building crew members in the Aspect multi-agent platform.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Crew Member Structure](#crew-member-structure)
3. [Context System](#context-system)
4. [Field Collection & Transitions](#field-collection--transitions)
5. [Database Schema](#database-schema)
6. [Creating a New Crew](#creating-a-new-crew)
7. [API Endpoints](#api-endpoints)
8. [Best Practices](#best-practices)

---

## Core Concepts

### What is a Crew Member?

A crew member is a specialized role within an agent. Each crew member has:
- **Guidance**: The prompt that defines behavior
- **Model**: Which LLM model to use
- **Tools**: Available function tools
- **Knowledge Base**: Vector store for RAG
- **Fields to Collect**: Data to extract from conversation
- **Transition Logic**: When to hand off to another crew

### Two-Tier System

| Tier | Storage | Use Case |
|------|---------|----------|
| **File-based** | `.crew.js` files | Custom logic, production crews |
| **DB-based** | `crew_prompts` table | Quick iteration, prompt versioning |

File crews take precedence over DB crews with the same name.

---

## Crew Member Structure

### Base Class

All crews inherit from `CrewMember`:

```javascript
const CrewMember = require('../../../crew/base/CrewMember');

class MyAgentCrew extends CrewMember {
  constructor() {
    super({
      // Identity
      name: 'my_crew',
      displayName: 'My Crew',
      description: 'What this crew does',
      isDefault: false,

      // LLM Configuration
      guidance: `Your prompt here...`,
      model: 'gpt-4o',
      maxTokens: 2048,

      // Tools (optional)
      tools: [
        {
          name: 'my_tool',
          description: 'Tool description',
          parameters: { type: 'object', properties: {} },
          handler: async (params) => { /* ... */ }
        }
      ],

      // Knowledge Base (optional)
      knowledgeBase: {
        enabled: true,
        storeId: 'vs_xxx'
      },

      // Field Collection (optional)
      fieldsToCollect: [
        { name: 'user_name', description: 'The user\'s name' },
        { name: 'age', description: 'User age as number' }
      ],
      extractionMode: 'conversational', // or 'form'

      // Transitions (optional)
      transitionTo: 'next_crew',
      transitionSystemPrompt: 'System message on transition'
    });
  }
}
```

### Key Methods to Override

```javascript
class MyAgentCrew extends CrewMember {
  // Called to build context for LLM
  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const { collectedFields } = params;

    // Load persisted context
    const journeyData = await this.getContext('journey');

    return {
      ...baseContext,
      userProfile: { name: collectedFields.name },
      journeyData
    };
  }

  // Called BEFORE response is sent - can trigger transition
  async preMessageTransfer(collectedFields) {
    if (collectedFields.name && collectedFields.age) {
      // Save context before transitioning
      await this.writeContext('profile', {
        name: collectedFields.name,
        age: collectedFields.age
      });
      return true; // Trigger transition to this.transitionTo
    }
    return false;
  }

  // Called AFTER response is sent - can trigger transition
  async postMessageTransfer(collectedFields) {
    return false;
  }

  // Pre-process user message
  async preProcess(message, context) {
    return message;
  }

  // Post-process LLM response
  async postProcess(response, context) {
    return response;
  }
}
```

---

## Context System

The context system allows crews to persist and share data across conversations.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    context_data table                    │
├──────────┬────────────────┬────────────┬────────────────┤
│ user_id  │ conversation_id │ namespace  │ data (JSONB)   │
├──────────┼────────────────┼────────────┼────────────────┤
│ 123      │ NULL           │ journey    │ {menstrual...} │  ← User-level
│ 123      │ 456            │ session    │ {topic:...}    │  ← Conversation-level
└──────────┴────────────────┴────────────┴────────────────┘
```

### Context Methods

Available on all crew members (set by dispatcher):

```javascript
// Read context
const data = await this.getContext('namespace');
const convData = await this.getContext('namespace', true); // conversation-level

// Write context (replaces)
await this.writeContext('namespace', { key: 'value' });
await this.writeContext('namespace', data, true); // conversation-level

// Merge context (shallow merge)
await this.mergeContext('namespace', { newKey: 'value' });
```

### Context Service

Located at `services/context.service.js`:

```javascript
const contextService = require('./services/context.service');

// Direct usage (outside crews)
await contextService.getContext(userId, 'namespace', conversationId);
await contextService.saveContext(userId, 'namespace', data, conversationId);
await contextService.mergeContext(userId, 'namespace', data, conversationId);
await contextService.deleteContext(userId, 'namespace', conversationId);
await contextService.listNamespaces(userId, conversationId);
```

### Example: Profiler Crew

```javascript
class FreedaProfilerCrew extends CrewMember {
  async buildContext(params) {
    const baseContext = await super.buildContext(params);

    // Load existing journey context (returning user)
    const existingJourney = await this.getContext('journey');

    return {
      ...baseContext,
      existingJourneyProfile: existingJourney,
      // ... other context
    };
  }

  async preMessageTransfer(collectedFields) {
    // Check if ready to transition
    if (!collectedFields.menstrual_status || !collectedFields.treatment_history) {
      return false;
    }

    // Analyze and persist before transition
    const analysis = this._analyzeJourneyPosition(collectedFields);

    await this.writeContext('journey', {
      menstrualStatus: collectedFields.menstrual_status,
      treatmentHistory: collectedFields.treatment_history,
      analysis: analysis,
      profiledAt: new Date().toISOString()
    });

    return true; // Transition to this.transitionTo
  }
}
```

### Example: Reading Context in Downstream Crew

```javascript
class FreedaGeneralCrew extends CrewMember {
  async buildContext(params) {
    const baseContext = await super.buildContext(params);

    // Load journey profile from profiler crew
    const journeyProfile = await this.getContext('journey');

    // Adapt approach based on analysis
    const guidance = this._buildJourneyGuidance(journeyProfile);

    return {
      ...baseContext,
      userProfile: {
        journeyPosition: journeyProfile?.analysis?.estimatedPosition
      },
      journeyGuidance: guidance
    };
  }
}
```

---

## Field Collection & Transitions

### Field Extraction

When a crew has `fieldsToCollect`, the dispatcher runs a `FieldsExtractorAgent` in parallel:

```javascript
fieldsToCollect: [
  {
    name: 'user_name',
    description: "The user's first name or preferred nickname"
  },
  {
    name: 'age',
    description: "User's age as a number (e.g., 45, 52)"
  }
]
```

**Extraction Modes:**
- `conversational` (default): Extracts from recent message history
- `form`: Strict mode, only extracts from last user message

### Transition Flow

```
Message arrives
       │
       ▼
┌──────────────────┐
│ Get current crew │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ Has fieldsToCollect?                      │
│                                          │
│  NO ──────► Stream crew response directly │
│                                          │
│  YES ─────► Run in parallel:             │
│             • FieldsExtractorAgent       │
│             • Crew response (buffered)   │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│ Extractor completes                       │
│                                          │
│ Call crew.preMessageTransfer(fields)     │
│                                          │
│  FALSE ───► Flush buffer, send response  │
│                                          │
│  TRUE ────► Discard buffer               │
│             Update conversation crew     │
│             Stream target crew response  │
└──────────────────────────────────────────┘
```

### Transition Example

```javascript
// Introduction crew → Profiler crew → General crew

class FreedaIntroductionCrew extends CrewMember {
  constructor() {
    super({
      name: 'introduction',
      isDefault: true,
      transitionTo: 'profiler', // Default target
      fieldsToCollect: [
        { name: 'name', description: '...' },
        { name: 'age', description: '...' },
        { name: 'tos_acknowledged', description: '...' }
      ]
    });
  }

  async preMessageTransfer(collectedFields) {
    const age = parseInt(collectedFields.age);

    // Ineligible user
    if (collectedFields.gender === 'male' || age < 38) {
      this.transitionTo = 'ineligible'; // Dynamic target
      return true;
    }

    // Eligible user with all fields
    if (collectedFields.name && age >= 38 && collectedFields.tos_acknowledged) {
      this.transitionTo = 'profiler';
      return true;
    }

    return false; // Keep collecting
  }
}
```

---

## Database Schema

### Core Tables

```sql
-- Context data (generic, user/conversation level)
CREATE TABLE context_data (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  namespace VARCHAR(100) NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, conversation_id, namespace)
);

-- User symptoms (domain-specific for Freeda)
CREATE TABLE user_symptoms (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symptom_name VARCHAR(100) NOT NULL,
  severity INTEGER CHECK (severity BETWEEN 1 AND 10),
  frequency VARCHAR(50),
  status VARCHAR(20) DEFAULT 'active',
  notes TEXT,
  reported_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Crew prompts (versioned prompts for crews)
CREATE TABLE crew_prompts (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  crew_member_name VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL,
  name VARCHAR(255),
  prompt TEXT NOT NULL,
  transition_system_prompt TEXT,
  is_active BOOLEAN DEFAULT FALSE NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### Prompt Resolution Priority

1. **Session override** (from chat debug panel)
2. **DB active prompt** (`crew_prompts` where `is_active = true`)
3. **Code default** (guidance in `.crew.js` file)

---

## Creating a New Crew

### Step 1: Create the Crew File

```javascript
// agents/myagent/crew/my-crew.crew.js
const CrewMember = require('../../../crew/base/CrewMember');

class MyAgentMyCrew extends CrewMember {
  constructor() {
    super({
      name: 'my_crew',
      displayName: 'My Crew',
      description: 'What this crew does',
      isDefault: false,

      fieldsToCollect: [
        { name: 'field1', description: '...' }
      ],

      transitionTo: 'next_crew',

      guidance: `Your prompt here...`,

      model: 'gpt-4o',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    if (collectedFields.field1) {
      await this.writeContext('my_namespace', { field1: collectedFields.field1 });
      return true;
    }
    return false;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const existingData = await this.getContext('my_namespace');

    return {
      ...baseContext,
      existingData
    };
  }
}

module.exports = MyAgentMyCrew;
```

### Step 2: Export in index.js

```javascript
// agents/myagent/crew/index.js
const MyAgentMyCrew = require('./my-crew.crew');
const MyAgentOtherCrew = require('./other.crew');

module.exports = {
  MyAgentMyCrew,
  MyAgentOtherCrew
};
```

### Step 3: Update Transitions

Update the upstream crew's `transitionTo` to point to your new crew.

### Step 4: Run Migration (if needed)

```bash
psql -d your_database -f db/migrations/your_migration.sql
```

---

## API Endpoints

### Crew Management

```
GET    /api/agents/:agentName/crew           -- List all crews
GET    /api/agents/:agentName/crew/:name     -- Get crew details
```

### Prompt Management

```
GET    /api/agents/:agentName/prompts                    -- List all prompts
GET    /api/agents/:agentName/crew/:crewName/prompts     -- Get crew prompts
POST   /api/agents/:agentName/crew/:crewName/prompts     -- Create version
PUT    /api/agents/:agentName/crew/:crewName/prompts/:id -- Update prompt
POST   /api/agents/:agentName/crew/:crewName/prompts/:id/activate -- Set active
```

### Chat (uses crews)

```
POST   /api/finance-assistant/stream    -- Stream chat (dispatcher routes to crew)
```

---

## Best Practices

### 1. Context Namespaces

Use clear, descriptive namespace names:
- `journey` - User's journey profile
- `preferences` - User preferences
- `session_notes` - Conversation-level notes
- `symptoms` - Use `user_symptoms` table instead

### 2. Field Collection

- Keep field descriptions clear and specific
- Use enum-like values: `"One of: 'option1', 'option2', 'option3'"`
- Don't overload with too many fields (3-7 is ideal)

### 3. Transitions

- Always set `transitionTo` if using `preMessageTransfer`
- Can dynamically change `this.transitionTo` in the method
- Save context BEFORE returning `true`

### 4. Prompts

- Keep prompts focused on the crew's specific role
- Use sections: PURPOSE, DO's, DON'Ts, RULES
- Include context placeholders that `buildContext` will fill

### 5. Testing

- Test with override: `POST /stream { overrideCrewMember: 'my_crew' }`
- Check context persistence in DB
- Verify transitions work correctly

---

## File Structure

```
aspect-agent-server/
├── crew/
│   ├── base/
│   │   └── CrewMember.js           # Base class
│   ├── services/
│   │   ├── crew.service.js         # Loads crews
│   │   └── dispatcher.service.js   # Routes messages
│   └── micro-agents/
│       └── FieldsExtractorAgent.js # Parallel extraction
│
├── services/
│   ├── context.service.js          # Context CRUD
│   ├── conversation.service.js     # Conversation management
│   └── prompt.service.js           # Prompt versioning
│
├── agents/
│   └── freeda/
│       └── crew/
│           ├── index.js            # Exports all crews
│           ├── introduction.crew.js
│           ├── profiler.crew.js
│           └── general.crew.js
│
└── db/
    ├── schema/
    │   └── index.js                # Drizzle schema
    └── migrations/
        └── *.sql                   # SQL migrations
```

---

## Freeda Crew Flow Example

```
┌─────────────────┐
│  Introduction   │ (isDefault: true)
│                 │
│ Collects:       │
│ - name          │
│ - age           │
│ - tos_ack       │
└────────┬────────┘
         │
         │ age >= 38, tos_ack
         ▼
┌─────────────────┐
│    Profiler     │
│                 │
│ Collects:       │
│ - menstrual     │
│ - treatment     │
│ - perceived     │
│                 │
│ Writes:         │
│ context:journey │
└────────┬────────┘
         │
         │ required fields collected
         ▼
┌─────────────────┐
│    General      │
│                 │
│ Reads:          │
│ context:journey │
│                 │
│ Adapts:         │
│ tone, depth     │
│ based on        │
│ journey profile │
└─────────────────┘
```
