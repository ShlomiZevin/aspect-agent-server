# Dynamic Crew Architecture

This document describes the architecture for creating crew members via a dashboard UI, allowing users to define crews through natural language that Claude translates into working crew configurations.

---

## The Core Tension

The current system is powerful precisely because crew members are **code files**:
- Custom `buildContext()` methods
- Custom transition logic (`preMessageTransfer`, `postMessageTransfer`)
- Custom tools with handlers
- Full JavaScript flexibility

But a dashboard-created crew is **configuration data** - it can't easily express code.

---

## Recommended Approach: Hybrid (DB + Files)

The sweet spot is a **two-tier system**:

### Tier 1: "Simple Crews" (DB-stored, instantly available)
Most crews are actually declarative - they just need:
- `name`, `displayName`, `description`
- `guidance` (the prompt)
- `model`, `maxTokens`
- `knowledgeBase` config (storeId reference)
- `fieldsToCollect` (array of {name, description})
- `transitionTo` (string reference)
- `tools` (by reference name, e.g., `["report_symptom"]`)

Store these as JSON in a `crew_members` table. Load them at runtime alongside file-based crews.

### Tier 2: "Advanced Crews" (File-based, deployed via git)
When a crew needs custom code:
- Custom `buildContext()` logic
- Custom transition conditions
- Inline tool handlers
- Complex preprocessing

Then you **export** from DB to a `.crew.js` file and deploy.

---

## The Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         DASHBOARD                               │
│  ┌──────────────────┐    ┌────────────────────────────────────┐ │
│  │ Natural Language │───▶│ Claude generates crew config JSON  │ │
│  │ "Create a crew   │    │                                    │ │
│  │  that handles    │    │ {                                  │ │
│  │  billing..."     │    │   name: "billing",                 │ │
│  └──────────────────┘    │   guidance: "...",                 │ │
│                          │   fieldsToCollect: [...],          │ │
│                          │   tools: ["lookup_invoice"],       │ │
│                          │   ...                              │ │
│                          │ }                                  │ │
│                          └───────────────┬────────────────────┘ │
│                                          │                      │
│                          ┌───────────────▼────────────────────┐ │
│                          │ Preview & Edit Panel               │ │
│                          │ • Edit guidance                    │ │
│                          │ • Toggle tools                     │ │
│                          │ • Set KB / model                   │ │
│                          └───────────────┬────────────────────┘ │
│                                          │                      │
│           ┌──────────────────────────────┴────────────────┐     │
│           ▼                                               ▼     │
│  ┌─────────────────┐                          ┌─────────────────┐│
│  │ Save to DB      │                          │ Export to File  ││
│  │ (Instant Live)  │                          │ (For Advanced)  ││
│  └────────┬────────┘                          └────────┬────────┘│
└───────────┼────────────────────────────────────────────┼────────┘
            │                                            │
            ▼                                            ▼
     ┌──────────────┐                          ┌──────────────────┐
     │ PostgreSQL   │                          │ Generated File   │
     │ crew_members │                          │ billing.crew.js  │
     │ table        │                          │ (Download/Copy)  │
     └──────┬───────┘                          └────────┬─────────┘
            │                                           │
            │                                  Developer commits
            │                                  to git & deploys
            │                                           │
            ▼                                           ▼
     ┌────────────────────────────────────────────────────────────┐
     │                    CrewService (Modified)                  │
     │                                                            │
     │  loadCrewForAgent(agentName) {                             │
     │    // 1. Load file-based crews (existing logic)            │
     │    const fileCrews = loadFromFilesystem(agentName);        │
     │                                                            │
     │    // 2. Load DB-based crews (NEW)                         │
     │    const dbCrews = await loadFromDatabase(agentName);      │
     │                                                            │
     │    // 3. Merge (files take precedence for same name)       │
     │    return new Map([...dbCrews, ...fileCrews]);             │
     │  }                                                         │
     └────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. DB crews are "configuration-only"
They use a generic `DynamicCrewMember` class that reads all behavior from the JSON config. No custom code paths.

```js
// DynamicCrewMember.js - A generic crew that runs from config
class DynamicCrewMember extends CrewMember {
  constructor(config) {
    super(config);  // Pass config directly
  }
  // Uses base class methods only - no custom overrides
}
```

### 2. File crews take precedence
If a crew exists as both file and DB, the **file wins**. This lets you:
- Prototype in DB quickly
- Export to file when you need custom code
- The file version "shadows" the DB version

### 3. Tools are registered globally, referenced by name
DB crews can only use pre-registered tools, not inline handlers:
```js
// In DB: { "tools": ["report_symptom", "lookup_invoice"] }
// CrewService resolves these to actual tool definitions at runtime
```

### 4. Export generates real code
"Export to File" generates a proper `.crew.js` file with all the boilerplate, ready to paste/download:
```js
// Generated: billing.crew.js
const CrewMember = require('../../../crew/base/CrewMember');

class BillingCrew extends CrewMember {
  constructor() {
    super({
      name: 'billing',
      guidance: `Your guidance here...`,
      // ... rest of config
    });
  }

  // TODO: Add custom methods here
  // async buildContext(params) { ... }
}

module.exports = BillingCrew;
```

---

## Benefits of This Approach

| Capability | DB Crews | File Crews |
|------------|----------|------------|
| Instant creation via dashboard | ✅ | ❌ (needs deploy) |
| Custom `buildContext()` | ❌ | ✅ |
| Custom transition logic | ❌ | ✅ |
| Inline tool handlers | ❌ | ✅ |
| Git version control | ❌ | ✅ |
| Production-ready | ⚠️ (good for prototyping) | ✅ |

---

## Implementation Plan

### Phase 1: Backend Foundation
1. DB schema for `crew_members` table
2. `DynamicCrewMember` class that loads from config
3. Modified `CrewService` to load from both sources
4. API endpoints for CRUD on DB crews

### Phase 2: Dashboard UI
1. Crew list view (shows both file and DB crews)
2. Crew editor panel (edit config fields)
3. Claude integration for natural language → config generation
4. Preview panel showing the full crew definition

### Phase 3: Export & Advanced Features
1. "Export to File" generates `.crew.js` code
2. Tool registry for referencing tools by name
3. Validation and testing interface

---

## Database Schema

```sql
CREATE TABLE crew_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,

  -- Core identity
  name VARCHAR(100) NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,

  -- LLM config
  guidance TEXT NOT NULL,
  model VARCHAR(50) DEFAULT 'gpt-4o',
  max_tokens INTEGER DEFAULT 2048,

  -- Knowledge base
  knowledge_base JSONB, -- { enabled: true, storeId: "vs_..." }

  -- Fields & transitions
  fields_to_collect JSONB, -- [{ name, description }]
  transition_to VARCHAR(100),
  transition_system_prompt TEXT,

  -- Tools (by reference name)
  tools JSONB, -- ["report_symptom", "lookup_invoice"]

  -- Metadata
  is_active BOOLEAN DEFAULT TRUE,
  source VARCHAR(20) DEFAULT 'database', -- 'database' or 'file' (for display)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id),

  UNIQUE(agent_id, name)
);
```

---

## API Endpoints

```
GET    /api/agents/:agentName/crew-members          -- List all (file + DB)
GET    /api/agents/:agentName/crew-members/:name    -- Get one
POST   /api/agents/:agentName/crew-members          -- Create (DB only)
PUT    /api/agents/:agentName/crew-members/:name    -- Update (DB only)
DELETE /api/agents/:agentName/crew-members/:name    -- Delete (DB only)
POST   /api/agents/:agentName/crew-members/:name/export  -- Generate .crew.js file
POST   /api/agents/:agentName/crew-members/generate      -- Claude generates from text
```

---

## Notes

- File-based crews are read-only in the dashboard (edit via code)
- DB crews are fully editable
- The "source" field indicates where the crew came from
- When a DB crew is exported to file and the file is deployed, the file takes over
