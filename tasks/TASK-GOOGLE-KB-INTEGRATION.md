# Task: Google Gemini Knowledge Base Integration

## Overview

Add Google Gemini File Search (built-in RAG) support alongside existing OpenAI knowledge base infrastructure. Enable seamless management of both KB providers through the admin dashboard with sync capabilities.

**Current State:** OpenAI vector stores only
**Target State:** OpenAI + Google Gemini File Search with unified management

---

## Background

### OpenAI (Current Implementation)
- Vector stores created via `client.vectorStores.create()`
- Files uploaded with `client.files.create()` + `client.vectorStores.files.create()`
- Used in LLM via `file_search` tool with `vector_store_ids`
- DB tracks: `vectorStoreId`, `openaiFileId`

### Google Gemini (To Add)
- File Search Tool with managed vector store (launched Nov 2025)
- Files uploaded via `files.upload()` API
- Corpus (KB) created via File Search API
- Used in LLM via `file_search` tool in `generateContent`
- Pricing: Free storage, $0.15/million tokens for initial indexing

---

## Scope

### Server Changes
1. New Google KB service (`kb.google.service.js`)
2. Database schema updates for dual-provider support
3. API endpoint updates for provider-aware operations
4. LLM integration for Google file_search

### Client Changes
1. KB Manager UI updates for provider selection
2. Sync functionality between providers
3. Provider indicator on KBs and files

---

## Detailed Tasks

### Phase 1: Server - Google KB Service

#### 1.1 Create `services/kb.google.service.js`

```javascript
// Core operations needed:

class GoogleKBService {
  // Initialize client (dynamic import for ESM)
  async getClient()

  // Corpus (KB) Management
  async createCorpus(name, description)
  // Returns: { corpusId, name, displayName, createTime }

  async listCorpora()
  async deleteCorpus(corpusId)

  // File Management
  async uploadFile(corpusId, fileBuffer, fileName, mimeType)
  // Process: Upload file → Create document in corpus
  // Returns: { documentId, name, mimeType, sizeBytes, state }

  async listDocuments(corpusId)
  async deleteDocument(corpusId, documentId)

  // Query (for testing)
  async queryCorpus(corpusId, query, options)
}
```

**Reference:** Google Generative AI File Search API
- SDK: `@google/genai` (already installed)
- Endpoint: `models.generateContent` with `file_search` tool

#### 1.2 Update `services/llm.google.js`

Add file_search tool support in `sendMessageStreamWithPrompt`:

```javascript
// In config destructuring, add:
knowledgeBase = null,

// Before creating chat, if KB enabled:
if (knowledgeBase?.enabled && knowledgeBase.corpusId) {
  // Add file_search tool with corpus reference
  geminiTools.push({
    fileSearch: {
      corpusResource: knowledgeBase.corpusId
    }
  });
}

// Handle file_search results in stream (similar to function_call events)
if (chunk.groundingMetadata?.groundingChunks) {
  yield {
    type: 'file_search_results',
    files: chunk.groundingMetadata.groundingChunks.map(c => ({
      name: c.retrievedContext?.title,
      uri: c.retrievedContext?.uri,
      relevance: c.retrievedContext?.relevanceScore
    }))
  };
}
```

---

### Phase 2: Database Schema Updates

#### 2.1 Update `db/schema/index.js`

**Modify `knowledgeBases` table:**

```javascript
const knowledgeBases = pgTable('knowledge_bases', {
  id: serial('id').primaryKey(),
  agentId: integer('agent_id').references(() => agents.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Provider field (NEW)
  provider: varchar('provider', { length: 50 }).default('openai').notNull(),
  // Values: 'openai' | 'google'

  // OpenAI-specific (existing)
  vectorStoreId: varchar('vector_store_id', { length: 255 }),

  // Google-specific (NEW)
  googleCorpusId: varchar('google_corpus_id', { length: 255 }),

  // Sync tracking (NEW)
  syncedFromId: integer('synced_from_id').references(() => knowledgeBases.id),
  lastSyncedAt: timestamp('last_synced_at'),

  fileCount: integer('file_count').default(0),
  totalSize: integer('total_size').default(0),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

**Modify `knowledgeBaseFiles` table:**

```javascript
const knowledgeBaseFiles = pgTable('knowledge_base_files', {
  id: serial('id').primaryKey(),
  knowledgeBaseId: integer('knowledge_base_id').references(() => knowledgeBases.id).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  fileSize: integer('file_size'),
  fileType: varchar('file_type', { length: 100 }),

  // OpenAI-specific (existing)
  openaiFileId: varchar('openai_file_id', { length: 255 }),

  // Google-specific (NEW)
  googleDocumentId: varchar('google_document_id', { length: 255 }),

  // Original file storage for sync (NEW)
  originalFileUrl: varchar('original_file_url', { length: 1024 }),
  // OR store in GCS/S3 and track URL here for re-upload to other provider

  status: varchar('status', { length: 50 }).default('processing'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

#### 2.2 Migration Script

Create `db/migrations/add-google-kb-support.sql`:

```sql
-- Add provider column
ALTER TABLE knowledge_bases
ADD COLUMN provider VARCHAR(50) DEFAULT 'openai' NOT NULL;

-- Add Google-specific columns
ALTER TABLE knowledge_bases
ADD COLUMN google_corpus_id VARCHAR(255);

-- Add sync tracking
ALTER TABLE knowledge_bases
ADD COLUMN synced_from_id INTEGER REFERENCES knowledge_bases(id);

ALTER TABLE knowledge_bases
ADD COLUMN last_synced_at TIMESTAMP;

-- Add Google file ID to files table
ALTER TABLE knowledge_base_files
ADD COLUMN google_document_id VARCHAR(255);

-- Add original file URL for sync capability
ALTER TABLE knowledge_base_files
ADD COLUMN original_file_url VARCHAR(1024);
```

---

### Phase 3: API Endpoint Updates

#### 3.1 Update `server.js` KB Endpoints

**Create KB - Add provider support:**

```javascript
// POST /api/kb/create
app.post('/api/kb/create', async (req, res) => {
  const { agentName, name, description, provider = 'openai' } = req.body;

  let providerKBId;

  if (provider === 'openai') {
    const vectorStore = await llmService.createVectorStore(name, description);
    providerKBId = { vectorStoreId: vectorStore.id };
  } else if (provider === 'google') {
    const corpus = await googleKBService.createCorpus(name, description);
    providerKBId = { googleCorpusId: corpus.corpusId };
  }

  const kb = await kbService.createKnowledgeBase(
    agentId, name, description,
    providerKBId.vectorStoreId || null,
    providerKBId.googleCorpusId || null,
    provider
  );

  res.json({ knowledgeBase: kb });
});
```

**Upload File - Route to correct provider:**

```javascript
// POST /api/kb/:kbId/upload
app.post('/api/kb/:kbId/upload', upload.single('file'), async (req, res) => {
  const kb = await kbService.getKnowledgeBaseById(kbId);

  let fileResult;

  if (kb.provider === 'openai') {
    fileResult = await llmService.addFileToVectorStore(
      req.file.buffer, req.file.originalname, kb.vectorStoreId
    );
    // Save with openaiFileId
  } else if (kb.provider === 'google') {
    fileResult = await googleKBService.uploadFile(
      kb.googleCorpusId, req.file.buffer,
      req.file.originalname, req.file.mimetype
    );
    // Save with googleDocumentId
  }

  // Optionally store original file for sync (see Phase 4)

  res.json({ file: fileResult });
});
```

**New Endpoint - Sync KB:**

```javascript
// POST /api/kb/:sourceKbId/sync
// Syncs all files from source KB to a target KB (different provider)
app.post('/api/kb/:sourceKbId/sync', async (req, res) => {
  const { targetKbId } = req.body;
  // OR { targetProvider } to create new KB

  const sourceKb = await kbService.getKnowledgeBaseById(sourceKbId);
  const sourceFiles = await kbService.getFilesByKnowledgeBase(sourceKbId);

  // For each file, retrieve from source provider and upload to target
  // Track sync status and handle failures

  res.json({ synced: true, fileCount: sourceFiles.length });
});
```

---

### Phase 4: File Storage for Sync

**Option A: Store in Cloud Storage (Recommended)**

Store uploaded files in GCS or S3 for re-upload capability:

```javascript
// On file upload, also save to GCS
const gcsUrl = await storageService.uploadFile(
  req.file.buffer,
  `kb-files/${kbId}/${req.file.originalname}`
);

// Save URL in database
await kbService.addFile(kbId, fileName, ..., { originalFileUrl: gcsUrl });
```

**Option B: Re-download from Provider**

For OpenAI, files can be downloaded via `client.files.content(fileId)`.
Google documents may not be directly downloadable.

**Recommendation:** Option A (Cloud Storage) for reliable sync.

---

### Phase 5: Client UI Updates

#### 5.1 Update Types (`src/types/kb.ts`)

```typescript
type KBProvider = 'openai' | 'google';

interface KnowledgeBase {
  id: number;
  name: string;
  description: string;
  agentName: string;
  provider: KBProvider;           // NEW
  vectorStoreId?: string;         // OpenAI
  googleCorpusId?: string;        // Google
  syncedFromId?: number;          // NEW
  lastSyncedAt?: Date;            // NEW
  fileCount: number;
  totalSize: number;
  createdAt: Date;
  updatedAt: Date;
}

interface KBFile {
  id: string;
  name: string;
  size: number;
  type: string;
  tags: string[];
  openaiFileId?: string;          // OpenAI
  googleDocumentId?: string;      // Google
  uploadedAt: Date;
}
```

#### 5.2 Update `KBManager.tsx`

**Add provider selector in Create KB modal:**

```tsx
// In CreateKBModal
<div className={styles.formGroup}>
  <label>Provider</label>
  <select
    value={provider}
    onChange={(e) => setProvider(e.target.value as KBProvider)}
  >
    <option value="openai">OpenAI</option>
    <option value="google">Google Gemini</option>
  </select>
  <span className={styles.hint}>
    {provider === 'openai'
      ? 'Uses OpenAI vector stores'
      : 'Uses Google File Search (free storage)'}
  </span>
</div>
```

**Add provider indicator on KB cards:**

```tsx
// In KB card component
<div className={styles.kbCard}>
  <div className={styles.kbHeader}>
    <span className={styles.kbName}>{kb.name}</span>
    <span className={styles.providerBadge} data-provider={kb.provider}>
      {kb.provider === 'openai' ? 'OpenAI' : 'Gemini'}
    </span>
  </div>
  <div className={styles.kbMeta}>
    {kb.fileCount} files • {formatSize(kb.totalSize)}
  </div>
</div>
```

**Add sync button:**

```tsx
// In KB detail view header
{selectedKB && (
  <button
    className={styles.syncButton}
    onClick={() => setShowSyncModal(true)}
    title="Sync to another provider"
  >
    🔄 Sync
  </button>
)}

// Sync modal
<SyncKBModal
  sourceKB={selectedKB}
  knowledgeBases={knowledgeBases}
  onSync={handleSync}
  onClose={() => setShowSyncModal(false)}
/>
```

#### 5.3 Create `SyncKBModal` Component

```tsx
// New component: src/components/kb/SyncKBModal/SyncKBModal.tsx

interface SyncKBModalProps {
  sourceKB: KnowledgeBase;
  knowledgeBases: KnowledgeBase[];
  onSync: (sourceId: number, targetId: number | 'new', provider?: KBProvider) => Promise<void>;
  onClose: () => void;
}

// UI:
// - Radio: "Sync to existing KB" or "Create new KB"
// - If existing: dropdown of KBs (filtered to different provider)
// - If new: name input + provider selector (opposite of source)
// - Progress indicator during sync
// - Success/error feedback
```

#### 5.4 Update `kbService.ts`

```typescript
// Add provider parameter to createKnowledgeBase
export async function createKnowledgeBase(
  name: string,
  description: string,
  agentName: string,
  provider: KBProvider,
  baseURL: string
): Promise<KnowledgeBase>

// Add sync function
export async function syncKnowledgeBase(
  sourceKbId: number,
  targetKbId: number | null,  // null = create new
  targetProvider: KBProvider | null,
  targetName: string | null,
  baseURL: string
): Promise<{ synced: boolean; fileCount: number; targetKbId: number }>
```

---

### Phase 6: Crew Member KB Resolution

#### 6.1 Update Crew Member Config

Crew members can specify provider preference:

```javascript
// In crew member definition
knowledgeBase: {
  enabled: true,
  storeId: 'vs_xxx',           // OpenAI vector store ID
  googleCorpusId: 'corp_xxx',  // Google corpus ID (optional)
  preferredProvider: 'openai'  // Which to use if both available
}
```

#### 6.2 Update Dispatcher

```javascript
// In dispatcher.service.js
const resolvedKB = this._resolveKnowledgeBase(crew.knowledgeBase, modelProvider);

_resolveKnowledgeBase(kbConfig, modelProvider) {
  if (!kbConfig?.enabled) return null;

  // If model is Gemini and Google KB available, prefer Google
  if (modelProvider === 'google' && kbConfig.googleCorpusId) {
    return {
      enabled: true,
      corpusId: kbConfig.googleCorpusId,
      provider: 'google'
    };
  }

  // Default to OpenAI
  if (kbConfig.storeId) {
    return {
      enabled: true,
      storeId: kbConfig.storeId,
      provider: 'openai'
    };
  }

  return null;
}
```

---

## File Summary

### Server Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `services/kb.google.service.js` | CREATE | Google File Search API integration |
| `services/llm.google.js` | MODIFY | Add file_search tool support |
| `services/kb.service.js` | MODIFY | Add provider-aware operations |
| `db/schema/index.js` | MODIFY | Add provider columns |
| `db/migrations/add-google-kb.sql` | CREATE | Migration script |
| `server.js` | MODIFY | Update KB endpoints, add sync |

### Client Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/types/kb.ts` | MODIFY | Add provider types |
| `src/services/kbService.ts` | MODIFY | Add provider param, sync function |
| `src/hooks/useKnowledgeBase.ts` | MODIFY | Handle provider state |
| `src/components/kb/KBManager/KBManager.tsx` | MODIFY | Provider UI, sync button |
| `src/components/kb/SyncKBModal/` | CREATE | Sync modal component |

---

## Testing Checklist

### Server Tests
- [ ] Create OpenAI KB - verify vector store created
- [ ] Create Google KB - verify corpus created
- [ ] Upload file to OpenAI KB - verify in vector store
- [ ] Upload file to Google KB - verify in corpus
- [ ] List KBs - shows both providers correctly
- [ ] Delete file from each provider
- [ ] Sync from OpenAI to Google
- [ ] Sync from Google to OpenAI

### Client Tests
- [ ] Create KB modal shows provider selector
- [ ] KB cards show provider badge
- [ ] File upload works for both providers
- [ ] Sync modal opens and lists valid targets
- [ ] Sync completes with progress feedback
- [ ] Error states handled gracefully

### Integration Tests
- [ ] Chat with OpenAI model uses OpenAI KB
- [ ] Chat with Gemini model uses Google KB
- [ ] File search results appear in thinking indicator
- [ ] KB citations shown in response

---

## Dependencies

- `@google/genai` - Already installed (used for LLM)
- Google Cloud Storage (optional) - For file sync storage

---

## Environment Variables

```bash
# Already configured
GEMINI_API_KEY=AIza...

# May need for file storage (if using GCS for sync)
GCS_BUCKET_NAME=aspect-kb-files
```

---

## Notes

1. **Google File Search** is part of the Gemini API, not a separate product
2. **Free tier** may have rate limits - monitor during testing
3. **File formats** - Google supports 150+ types, OpenAI has specific list
4. **Sync direction** - Consider which provider is "source of truth"
5. **Crew members** can have both IDs and auto-select based on model
