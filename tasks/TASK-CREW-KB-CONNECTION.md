# Task: DB-Driven Crew-to-KB Connection with Model-Aware Resolution

> **Status:** Pending
> **Priority:** High
> **Estimated Complexity:** 2-3 focused sessions

## Overview

Decouple crew members from provider-specific KB IDs (like OpenAI's `vs_xxx`). Instead, crew members reference knowledge bases by **our DB ID or name**, and at runtime the system resolves to the correct provider-specific ID based on the model being used.

**Current State:** Crew members hardcode OpenAI vector store IDs (`storeId: 'vs_695e750fc75481918e3d76851ce30cae'`)
**Target State:** Crew members reference KBs by DB name/ID → dispatcher resolves to `vectorStoreId` or `googleCorpusId` based on model provider at call time

---

## Why This Change

```
BEFORE (hardcoded, single-provider):
┌─────────────────────┐
│ general.crew.js     │
│ knowledgeBase: {    │
│   storeId: 'vs_xxx' │  ← OpenAI-specific, brittle
│ }                   │
└─────────────────────┘

AFTER (DB-driven, provider-agnostic):
┌─────────────────────┐      ┌──────────────┐      ┌─────────────────┐
│ general.crew.js     │      │ knowledge_   │      │ At runtime:     │
│ knowledgeBase: {    │ ──→  │ bases table  │ ──→  │ GPT → storeId   │
│   sources: [        │      │ id: 3        │      │ Gemini → corpus │
│     'Freeda Medical'│      │ vectorStore… │      │ Claude → skip   │
│   ]                 │      │ googleCorpus…│      └─────────────────┘
│ }                   │      └──────────────┘
└─────────────────────┘
```

---

## Detailed Requirements

### R1: DB-Driven KB References

Crew members declare KB by **name** (matching `knowledge_bases.name` in our DB), not by provider-specific IDs.

```javascript
// BEFORE (in general.crew.js)
knowledgeBase: {
  enabled: true,
  storeId: 'vs_695e750fc75481918e3d76851ce30cae'
}

// AFTER
knowledgeBase: {
  enabled: true,
  sources: ['Freeda Medical KB']  // References our DB by name
}
```

Multiple KBs are supported:
```javascript
knowledgeBase: {
  enabled: true,
  sources: ['Freeda Medical KB', 'Supplement Database']
}
```

### R2: Model-Aware Resolution at Runtime

The dispatcher resolves KB references to provider-specific IDs **based on the model being used**:

| Model Provider | Resolution | What Gets Passed to LLM |
|----------------|------------|------------------------|
| OpenAI (gpt-*) | Look up `vectorStoreId` from DB | `vector_store_ids: ['vs_xxx']` |
| Google (gemini-*) | Look up `googleCorpusId` from DB | `fileSearch: { corpusResource: '...' }` |
| Anthropic (claude-*) | Skip KB entirely | No KB tool added |

If a KB entry doesn't have the needed provider ID (e.g., KB was only synced to OpenAI, not Google), log a warning and skip that source.

### R3: Support Multiple KB Sources Per Crew

A crew member can reference multiple KB sources. At runtime, all matching provider-specific IDs are collected:

```javascript
// Crew config
sources: ['Freeda Medical KB', 'Supplement Database']

// OpenAI model → resolve both to vector store IDs
vector_store_ids: ['vs_aaa', 'vs_bbb']

// Gemini model → resolve both to corpus IDs
// (check Gemini API if multiple corpora are supported in one call)
```

### R4: Anthropic Exclusion

When model is `claude-*`, KB is not available. The dispatcher should:
1. Not pass any KB config to Claude LLM service
2. Log an info message: `"KB skipped for Anthropic model (not supported)"`
3. NOT fail or error - just gracefully skip

### R5: Thinking Process + File Search Results

The thinking indicator in the UI currently shows KB access and which files were referenced during the response. This must continue working for both providers.

**Current flow (OpenAI — must keep working):**
1. `server.js` calls `thinkingService.addKnowledgeBaseStep()` when KB is active
2. `llm.openai.js` yields `{ type: 'file_search_results', files: [...] }` chunks during streaming
3. `server.js` catches those chunks, adds a thinking step with the file names
4. Client renders the files in the thinking indicator (expandable list)

**Google Gemini — must work the same way:**
1. Same `thinkingService.addKnowledgeBaseStep()` call (already provider-agnostic)
2. `llm.google.js` must yield `{ type: 'file_search_results', files: [...] }` from grounding metadata
3. `server.js` handles it identically — same SSE event, same thinking step
4. Client renders it the same — no client changes needed for this

**Key point:** The `file_search_results` chunk format must be the same from both providers so `server.js` and the client handle them uniformly. Both should yield `{ type: 'file_search_results', files: [{ name, ... }] }`.

### R6: Update Crew Member File

Update all existing `.crew.js` files that use KB to the new format:

**File:** `agents/freeda/crew/general.crew.js`
```javascript
// BEFORE
knowledgeBase: {
  enabled: true,
  storeId: 'vs_695e750fc75481918e3d76851ce30cae'
}

// AFTER
knowledgeBase: {
  enabled: true,
  sources: ['Freeda Medical KB']  // Must match knowledge_bases.name in DB
}
```

All other crew files that have `knowledgeBase: null` or `{ enabled: false }` remain unchanged.

### R7: Debug Panel - Show KB Info

In the Prompt Editor Panel (Ctrl+Shift+D), add a read-only KB info section per crew member:

```
┌─────────────────────────────────────────────┐
│ Crew: general (Freeda - Guide)              │
│                                             │
│ Model: [gpt-5-chat-latest ▾]               │
│ Provider: [openai ▾]                        │
│                                             │
│ Knowledge Bases:                            │
│ ┌─────────────────────────────────────────┐ │
│ │ ✅ Freeda Medical KB                    │ │
│ │    Provider: openai (vs_695e750f...)     │ │
│ │    Files: 12 • 4.2 MB                   │ │
│ ├─────────────────────────────────────────┤ │
│ │ ⚠️ Supplement Database                  │ │
│ │    Provider: openai only (no Google)    │ │
│ │    Files: 3 • 800 KB                    │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ [Override KB Sources ▾]                     │
│                                             │
│ Prompt:                                     │
│ ┌─────────────────────────────────────────┐ │
│ │ You are Freeda's main conversation...   │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Show:
- Which KBs are attached to this crew member (by name)
- Resolution status: checkmark if provider ID exists for current model, warning if not
- File count and size from DB

### R8: Debug Panel - Override KB

Allow overriding KB assignment from the debug panel (session-only, not persisted to file):

```
[Override KB Sources ▾]
  ☑ Freeda Medical KB
  ☐ Supplement Database
  ☐ General Wellness KB
  ☐ Product Catalog
```

This override is sent with the chat request (similar to how model/prompt overrides work) and applied for the current session only.

### R9: DB Column for KB Override

Add a column to `crew_members` table for persistent KB override (used by dashboard-created crews):

```sql
ALTER TABLE crew_members
ADD COLUMN knowledge_base_sources JSONB;
-- Stores: ["Freeda Medical KB", "Supplement Database"]
-- Null means use file-based defaults
```

This column is used when:
- Dashboard-created crews need KB assignment
- Admin wants to persistently override a file-based crew's KB

**Precedence:** Debug session override > DB column override > File-based config

---

## Implementation

### Phase 1: Server - KB Resolution Service

#### 1.1 Create `services/kb.resolver.js`

A new service that resolves KB names to provider-specific IDs.

```javascript
class KBResolverService {
  /**
   * Resolve KB source names to provider-specific IDs
   * @param {string[]} sourceNames - KB names from crew config (e.g., ['Freeda Medical KB'])
   * @param {string} modelProvider - 'openai' | 'google' | 'anthropic'
   * @param {number} agentId - Agent ID to scope KB lookup
   * @returns {Object} Resolved KB config for the LLM service
   *
   * Example return for OpenAI:
   * {
   *   enabled: true,
   *   provider: 'openai',
   *   storeIds: ['vs_xxx', 'vs_yyy'],
   *   resolvedSources: [
   *     { name: 'Freeda Medical KB', resolved: true, id: 'vs_xxx' },
   *     { name: 'Supplement DB', resolved: false, reason: 'no vectorStoreId' }
   *   ]
   * }
   */
  async resolve(sourceNames, modelProvider, agentId) {
    // 1. Query knowledge_bases table for matching names under this agent
    // 2. For each match, extract the provider-specific ID
    // 3. Skip/warn for missing provider IDs
    // 4. Return resolved config
  }

  /**
   * Get all available KBs for an agent (for debug panel dropdown)
   * @param {number} agentId
   * @returns {Array} List of { id, name, provider, fileCount, totalSize, hasOpenAI, hasGoogle }
   */
  async getAvailableKBs(agentId) {
    // Query all knowledge_bases for this agent
    // Return with provider availability flags
  }
}
```

#### 1.2 Update `crew/services/dispatcher.service.js`

Replace the current direct KB passthrough with resolution:

```javascript
// BEFORE (current - lines 465-477):
const crewKBEnabled = crew.knowledgeBase?.enabled !== false;
const resolvedKB = (useKnowledgeBase && crewKBEnabled) ? {
  enabled: true,
  storeId: crew.knowledgeBase?.storeId || null,
  googleCorpusId: crew.knowledgeBase?.googleCorpusId || null,
} : null;

// AFTER:
const crewKBEnabled = crew.knowledgeBase?.enabled !== false;
let resolvedKB = null;

if (useKnowledgeBase && crewKBEnabled && crew.knowledgeBase?.sources?.length > 0) {
  const modelProvider = this._getModelProvider(resolvedModel);
  // e.g., 'gpt-5' → 'openai', 'gemini-2.0-flash' → 'google', 'claude-*' → 'anthropic'

  if (modelProvider === 'anthropic') {
    console.log(`ℹ️ [${crew.name}] KB skipped for Anthropic model (not supported)`);
  } else {
    // Use override sources if provided (debug panel), else crew config
    const kbSources = params.overrideKBSources || crew.knowledgeBase.sources;
    resolvedKB = await kbResolverService.resolve(kbSources, modelProvider, agentId);

    if (resolvedKB.resolvedSources.some(s => !s.resolved)) {
      console.warn(`⚠️ [${crew.name}] Some KB sources could not be resolved:`,
        resolvedKB.resolvedSources.filter(s => !s.resolved)
      );
    }
  }
}
```

#### 1.3 Update `services/llm.openai.js`

Support multiple vector store IDs:

```javascript
// BEFORE:
if (knowledgeBase?.enabled && knowledgeBase.storeId) {
  tools.push({
    type: 'file_search',
    vector_store_ids: [knowledgeBase.storeId]
  });
}

// AFTER:
if (knowledgeBase?.enabled && knowledgeBase.storeIds?.length > 0) {
  tools.push({
    type: 'file_search',
    vector_store_ids: knowledgeBase.storeIds  // Array of IDs
  });
}
```

#### 1.4 Update `services/llm.google.js`

Support resolved Google KB:

```javascript
// Use resolved corpus IDs from KB resolver
if (knowledgeBase?.enabled && knowledgeBase.corpusIds?.length > 0) {
  // Add file_search tool with corpus references
  // (check Google API docs for multi-corpus support)
  for (const corpusId of knowledgeBase.corpusIds) {
    geminiTools.push({
      fileSearch: { corpusResource: corpusId }
    });
  }
}
```

---

### Phase 2: Server - Crew Member Updates

#### 2.1 Update `crew/base/CrewMember.js`

```javascript
// Knowledge base configuration
// Format: { enabled: boolean, sources: string[] }
//   sources: array of KB names from our knowledge_bases DB table
this.knowledgeBase = options.knowledgeBase || null;
```

#### 2.2 Update Crew Member Files

Only one file to change:

**`agents/freeda/crew/general.crew.js`:**
```javascript
// CHANGE FROM:
knowledgeBase: {
  enabled: true,
  storeId: 'vs_695e750fc75481918e3d76851ce30cae'
}

// TO:
knowledgeBase: {
  enabled: true,
  sources: ['Freeda Medical KB']
}
```

All other crew files with `knowledgeBase: null` or `{ enabled: false }` → no change needed.

#### 2.3 Update DB Schema

```sql
-- Add KB sources override column to crew_members
ALTER TABLE crew_members
ADD COLUMN knowledge_base_sources JSONB;
-- Stores: ["KB Name 1", "KB Name 2"] or null (use file defaults)
```

Update `db/schema/index.js`:
```javascript
// In crewMembers table definition, add:
knowledgeBaseSources: jsonb('knowledge_base_sources'),
// Stores: string[] of KB names, null means use file-based config
```

#### 2.4 Update Crew Loading in `crew.service.js`

When loading DB crews, use the new `knowledgeBaseSources` column:

```javascript
// In DynamicCrewMember construction from DB:
const instance = new DynamicCrewMember({
  ...config,
  knowledgeBase: config.knowledgeBaseSources
    ? { enabled: true, sources: config.knowledgeBaseSources }
    : config.knowledgeBase  // fallback to legacy JSONB field
});
```

---

### Phase 3: API Endpoints

#### 3.1 New Endpoint: Get Available KBs for Agent

```javascript
// GET /api/agents/:agentName/knowledge-bases
// Used by debug panel to show available KBs for override
app.get('/api/agents/:agentName/knowledge-bases', async (req, res) => {
  const agent = await agentService.getByName(req.params.agentName);
  const kbs = await kbResolverService.getAvailableKBs(agent.id);

  res.json({
    knowledgeBases: kbs.map(kb => ({
      id: kb.id,
      name: kb.name,
      provider: kb.provider,
      fileCount: kb.fileCount,
      totalSize: kb.totalSize,
      hasOpenAI: !!kb.vectorStoreId,
      hasGoogle: !!kb.googleCorpusId,
    }))
  });
});
```

#### 3.2 Update Streaming Endpoint

Accept KB override from debug panel:

```javascript
// POST /api/finance-assistant/stream
// Add to request body:
const {
  message, conversationId, agentName,
  overrideKBSources,  // NEW: string[] from debug panel
  // ... existing params
} = req.body;

// Pass to dispatcher
dispatcherService.dispatch({
  ...params,
  overrideKBSources,  // Forwarded to dispatcher
});
```

#### 3.3 Update Debug Data in Dispatcher

Include resolution details in debug output:

```javascript
// In dispatcher debug yield
yield {
  type: 'debug_prompt',
  data: {
    crewName: crew.name,
    model: resolvedModel,
    knowledgeBase: resolvedKB ? {
      sources: resolvedKB.resolvedSources,  // Shows resolution status per source
      provider: resolvedKB.provider,
      activeIds: resolvedKB.storeIds || resolvedKB.corpusIds || [],
    } : null,
  }
};
```

---

### Phase 4: Client UI Updates

#### 4.1 New Types (`src/types/kb.ts`)

```typescript
export interface KBSource {
  name: string;
  resolved: boolean;
  id?: string;       // Provider-specific ID (if resolved)
  reason?: string;   // Why not resolved (if failed)
}

export interface ResolvedKB {
  enabled: boolean;
  provider: 'openai' | 'google';
  resolvedSources: KBSource[];
}

export interface AvailableKB {
  id: number;
  name: string;
  provider: string;
  fileCount: number;
  totalSize: number;
  hasOpenAI: boolean;
  hasGoogle: boolean;
}
```

#### 4.2 New Service Function (`src/services/kbService.ts`)

```typescript
export async function getAgentKnowledgeBases(
  agentName: string,
  baseURL: string
): Promise<AvailableKB[]> {
  const res = await fetch(`${baseURL}/api/agents/${agentName}/knowledge-bases`);
  const data = await res.json();
  return data.knowledgeBases;
}
```

#### 4.3 Update `PromptEditorPanel.tsx`

Add KB section between model selector and prompt editor:

**Fetch available KBs on mount:**
```typescript
const [availableKBs, setAvailableKBs] = useState<AvailableKB[]>([]);
const [kbOverrides, setKbOverrides] = useState<Map<string, string[]>>(new Map());
// Key: crew name, Value: selected KB source names

useEffect(() => {
  getAgentKnowledgeBases(agentName, baseURL).then(setAvailableKBs);
}, [agentName, baseURL]);
```

**KB section in the panel (per crew member):**
```tsx
{/* Knowledge Base Section */}
<div className={styles.kbSection}>
  <h4>Knowledge Bases</h4>

  {/* Show current crew's KB sources */}
  {crewKBSources.length > 0 ? (
    <ul className={styles.kbList}>
      {crewKBSources.map(source => (
        <li key={source} className={styles.kbItem}>
          <span className={styles.kbName}>{source}</span>
          {/* Show resolution status based on selected model provider */}
          <ProviderBadge
            name={source}
            availableKBs={availableKBs}
            currentProvider={selectedProvider}
          />
        </li>
      ))}
    </ul>
  ) : (
    <span className={styles.kbNone}>No knowledge bases</span>
  )}

  {/* Override toggle */}
  <details className={styles.kbOverride}>
    <summary>Override KB Sources</summary>
    <div className={styles.kbCheckboxes}>
      {availableKBs.map(kb => (
        <label key={kb.id}>
          <input
            type="checkbox"
            checked={overrideSources.includes(kb.name)}
            onChange={() => toggleKBOverride(crewName, kb.name)}
          />
          {kb.name}
          <span className={styles.kbMeta}>
            {kb.fileCount} files
            {!kb.hasOpenAI && ' (no OpenAI)'}
            {!kb.hasGoogle && ' (no Google)'}
          </span>
        </label>
      ))}
    </div>
  </details>
</div>
```

**ProviderBadge helper component:**
```tsx
function ProviderBadge({ name, availableKBs, currentProvider }) {
  const kb = availableKBs.find(k => k.name === name);
  if (!kb) return <span className={styles.kbMissing}>Not found in DB</span>;

  if (currentProvider === 'anthropic') {
    return <span className={styles.kbWarning}>KB not supported with Claude</span>;
  }

  const hasProvider = currentProvider === 'openai' ? kb.hasOpenAI : kb.hasGoogle;
  return hasProvider
    ? <span className={styles.kbOk}>✓ {currentProvider}</span>
    : <span className={styles.kbWarning}>⚠ No {currentProvider} ID</span>;
}
```

**Pass override to chat request:**
```typescript
// In sendMessage or wherever the stream request is built:
const overrideSources = kbOverrides.get(currentCrewName);
if (overrideSources?.length > 0) {
  requestBody.overrideKBSources = overrideSources;
}
```

---

## File Summary

### Server - Create

| File | Purpose |
|------|---------|
| `services/kb.resolver.js` | Resolve KB names → provider IDs |
| `db/migrations/add-crew-kb-sources.sql` | Add `knowledge_base_sources` column |

### Server - Modify

| File | Change |
|------|--------|
| `crew/base/CrewMember.js` | Update KB config to `sources` format |
| `crew/services/dispatcher.service.js` | Use KB resolver, accept overrides |
| `crew/services/crew.service.js` | Read `knowledgeBaseSources` from DB |
| `services/llm.openai.js` | Accept `storeIds` array |
| `services/llm.google.js` | Accept `corpusIds` array |
| `services/kb.service.js` | Add query-by-name method |
| `db/schema/index.js` | Add `knowledgeBaseSources` to crew schema |
| `server.js` | New endpoint + stream override param |
| `agents/freeda/crew/general.crew.js` | Migrate to `sources: ['Freeda Medical KB']` |

### Client - Modify

| File | Change |
|------|--------|
| `src/types/kb.ts` | Add `KBSource`, `AvailableKB` types |
| `src/services/kbService.ts` | Add `getAgentKnowledgeBases()` |
| `src/components/chat/PromptEditorPanel/PromptEditorPanel.tsx` | KB info section + override UI |
| `src/services/chatService.ts` | Pass `overrideKBSources` in stream request |

---

## Resolution Precedence

```
                    HIGHEST PRIORITY
                         │
    ┌────────────────────┴────────────────────┐
    │  Debug Session Override (Ctrl+Shift+D)  │
    │  overrideKBSources in request body      │
    │  Temporary: current session only        │
    └────────────────────┬────────────────────┘
                         │
    ┌────────────────────┴────────────────────┐
    │  DB Column Override                     │
    │  crew_members.knowledge_base_sources    │
    │  Persistent: set via dashboard          │
    └────────────────────┬────────────────────┘
                         │
    ┌────────────────────┴────────────────────┐
    │  File-Based Config                      │
    │  .crew.js → knowledgeBase.sources       │
    │  Code-level: updated via deployment     │
    └────────────────────┬────────────────────┘
                         │
                    LOWEST PRIORITY
```

---

## Pre-Deployment Requirement

Ensure KB name in `general.crew.js` matches `knowledge_bases.name` in the DB:
- Verify `'Freeda Medical KB'` (or whatever name is used) exists in `knowledge_bases` table for Freeda's agent
- Verify it has `vectorStoreId` (OpenAI) and `googleCorpusId` (if synced to Google)

---

## Testing Checklist

### Resolution Logic
- [ ] Crew with `sources: ['KB Name']` → OpenAI model → resolves to `vectorStoreId`
- [ ] Crew with `sources: ['KB Name']` → Gemini model → resolves to `googleCorpusId`
- [ ] Crew with `sources: ['KB Name']` → Claude model → KB skipped gracefully
- [ ] Crew with multiple sources → all resolved correctly
- [ ] KB name not found in DB → warning logged, source skipped
- [ ] KB found but missing provider ID → warning logged, source skipped

### Override Precedence
- [ ] No override → uses file-based sources
- [ ] DB column set → overrides file-based
- [ ] Debug panel override → overrides both DB and file
- [ ] Debug override cleared → falls back to DB/file

### Debug Panel
- [ ] Shows KB list per crew member
- [ ] Shows resolution status (checkmark/warning) based on selected model
- [ ] Claude model selected → shows "KB not supported" message
- [ ] Override checkbox list shows all agent KBs
- [ ] Override sent with stream request
- [ ] Override applies to chat response

### Thinking Process + File Search Results
- [ ] OpenAI model + KB → thinking indicator shows "Searching knowledge base" step
- [ ] OpenAI model + KB → file search results appear (file names, expandable)
- [ ] Gemini model + KB → same thinking step shows
- [ ] Gemini model + KB → file search results appear in same format as OpenAI
- [ ] Both providers yield `{ type: 'file_search_results', files }` in same structure

### Chat Integration
- [ ] Chat with OpenAI model + KB → file_search tool used, results shown
- [ ] Chat with Gemini model + KB → Google file search used, results shown
- [ ] Chat with Claude model + KB → no error, KB silently skipped
- [ ] Multiple KBs → all vector store IDs passed in single tool config
