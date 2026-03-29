# Task: KB Service Refactor — Generic Provider Routing

**Domain:** `aspect` (server-side)
**Type:** Task (refactor)
**Priority:** Medium
**Assignee:** Claude

---

## Background

The KB system currently leaks provider-specific logic into `server.js` and `dynamic-kb.service.js`. Every KB operation (upload, delete, sync, list) has `if openai → X, if google → Y, if anthropic → Z` blocks repeated across multiple files. Adding a new provider means touching 5+ files.

Additionally, `llm.openai.js` contains KB methods (`createVectorStore`, `addFileToVectorStore`, `deleteVectorStoreFile`, `listVectorStoreFiles`) that have nothing to do with chat/completions — they're there because OpenAI bundles both under the same SDK.

### Current architecture (messy):
```
server.js → knows about OpenAI, Google, Anthropic specifics
dynamic-kb.service.js → same provider if/else blocks
llm.openai.js → has KB methods mixed with chat methods
kb.service.js → only DB operations, no provider routing
```

### Target architecture (clean):
```
server.js → calls kb.service.js generic methods only
dynamic-kb.service.js → calls kb.service.js generic methods only
kb.service.js → DB + provider routing (the orchestrator)
  ├── kb.openai.service.js → OpenAI-specific (vector stores, file upload)
  ├── kb.google.service.js → Google-specific (File Search stores)
  └── kb.anthropic.service.js → Anthropic-specific (Files API)
llm.service.js → chat/completions only (no KB methods)
  ├── llm.openai.js → OpenAI chat only
  ├── llm.claude.js → Claude chat only
  └── llm.google.js → Gemini chat only
```

---

## What Changes

### 1. New file: `kb.openai.service.js`

Move these methods **out of `llm.openai.js`** into a new `kb.openai.service.js`:

```js
createStore(name, description)     // currently: llmService.createVectorStore()
uploadFile(storeId, buffer, name)  // currently: llmService.addFileToVectorStore()
deleteFile(storeId, fileId)        // currently: llmService.deleteVectorStoreFile()
listFiles(storeId)                 // currently: llmService.listVectorStoreFiles()
deleteStore(storeId)               // currently: openaiService.client.vectorStores.del()
getFileContent(fileId)             // currently: openaiService.client.files.content()
```

Uses the same OpenAI client instance. `llm.openai.js` keeps only chat/streaming methods.

### 2. Expand `kb.service.js` with generic provider-routing methods

Add these methods that handle the provider if/else logic **once**, in one place:

```js
// Store management
async createProviderStores(name, description, providers)
  // For each provider in array: create store, return { vectorStoreId, googleCorpusId }
  // Calls: kb.openai.service.createStore(), kb.google.service.createStore()
  // Anthropic has no store concept — skip

// File upload to all providers
async uploadFileToProviders(kbId, buffer, fileName, mimetype)
  // 1. Get KB from DB (has providers array)
  // 2. For each provider: upload file
  //    openai → kb.openai.service.uploadFile()
  //    google → kb.google.service.uploadFile()
  //    anthropic → kb.anthropic.service.uploadFile()
  // 3. Return { openaiFileId, googleDocumentId, anthropicFileId }

// File delete from all providers
async deleteFileFromProviders(kbFile, kb)
  // For each provider ID on the file: delete
  //    openaiFileId → kb.openai.service.deleteFile()
  //    googleDocumentId → kb.google.service.deleteDocument()
  //    anthropicFileId → kb.anthropic.service.deleteFile()

// List files on each provider
async listProviderFiles(kbId)
  // Get KB, for each provider: list files
  // Return { openai: [...], google: [...], anthropic: [...] }

// Sync all files to a new provider
async syncToProvider(kbId, targetProvider)
  // 1. Create store if needed
  // 2. For each file in KB: download from GCS → upload to target provider
  // 3. Update KB providers array
  // 4. Return sync result

// Detach a provider
async detachProvider(kbId, providerToDetach)
  // 1. Delete store
  // 2. Clear file provider IDs
  // 3. Remove from providers array
```

Each method uses the helpers from `kb.helpers.js` (`hasProvider`, `getProviders`, `getMissingProviders`).

### 3. Simplify `server.js` KB endpoints

Every KB endpoint becomes a thin wrapper. Examples:

**Before (current):**
```js
app.post('/api/kb/:kbId/upload', async (req, res) => {
  const kb = await kbService.getKnowledgeBaseById(kbId);
  if (hasProvider(kb, 'openai')) {
    const result = await llmService.addFileToVectorStore(buffer, name, kb.vectorStoreId);
    openaiFileId = result.fileId;
  }
  if (hasProvider(kb, 'google')) {
    const result = await googleKBService.uploadFile(kb.googleCorpusId, buffer, name, mime);
    googleDocumentId = result.documentId;
  }
  if (hasProvider(kb, 'anthropic')) {
    const result = await anthropicKBService.uploadFile(buffer, name, mime);
    anthropicFileId = result.fileId;
  }
  // ... save to GCS, save to DB
});
```

**After (clean):**
```js
app.post('/api/kb/:kbId/upload', async (req, res) => {
  const result = await kbService.uploadFile(kbId, buffer, originalname, mimetype, tags);
  res.json({ success: true, file: result });
});
```

All provider routing is inside `kbService.uploadFile()`.

**Endpoints to simplify:**
- `POST /api/kb/create` → `kbService.createKnowledgeBase()` (already handles store creation internally)
- `POST /api/kb/:kbId/upload` → `kbService.uploadFile()`
- `DELETE /api/kb/:kbId/files/:fileId` → `kbService.deleteFileWithProviders()`
- `DELETE /api/kb/:kbId` → `kbService.deleteKnowledgeBaseWithProviders()`
- `POST /api/kb/:kbId/sync` → `kbService.syncToProvider()`
- `POST /api/kb/:kbId/detach` → `kbService.detachProvider()`
- `GET /api/kb/:kbId/provider-files` → `kbService.listProviderFiles()`
- `DELETE /api/kb/:kbId/provider-files/:provider` → `kbService.deleteProviderFile()`

### 4. Simplify `dynamic-kb.service.js`

Replace all provider if/else blocks with calls to `kbService`:

```js
// Before (in attachToKB):
if (hasProvider(kb, 'openai')) { ... }
if (hasProvider(kb, 'google')) { ... }
if (hasProvider(kb, 'anthropic')) { ... }
const kbFile = await kbService.addFile(kbId, fileName, ...);

// After:
const kbFile = await kbService.uploadFile(kbId, buffer, fileName, mimetype, ['dynamic-kb']);
```

Same for `syncAttachedKBs` — replace the delete-old + upload-new per-provider blocks with:
```js
await kbService.deleteFileFromProviders(oldFile, kb);
const providerIds = await kbService.uploadFileToProviders(kbId, buffer, fileName, mimetype);
```

### 5. Remove KB methods from `llm.openai.js`

After moving to `kb.openai.service.js`, remove:
- `createVectorStore()`
- `addFileToVectorStore()`
- `deleteVectorStoreFile()`
- `listVectorStoreFiles()`

And remove any references to these from `llm.js` (the generic wrapper) if they're exposed there.

---

## Out of Scope

- No DB schema changes
- No UI changes
- No new features — purely internal refactor
- `kb.resolver.js` stays as-is (it already only reads from DB, doesn't touch providers)
- `storage.service.js` (GCS) stays as-is

---

## Files Touched

| File | Change |
|------|--------|
| `services/kb.openai.service.js` | **New** — OpenAI KB operations extracted from llm.openai.js |
| `services/kb.service.js` | Add generic provider-routing methods |
| `services/llm.openai.js` | Remove KB methods (createVectorStore, etc.) |
| `services/llm.js` | Remove KB method pass-throughs if any |
| `services/dynamic-kb.service.js` | Replace provider if/else with kbService calls |
| `server.js` | Simplify all KB endpoints to thin wrappers |

---

## Acceptance Criteria

- [ ] `server.js` has zero imports of `kb.google.service`, `kb.anthropic.service`, or `kb.openai.service` — only imports `kbService`
- [ ] `server.js` KB endpoints have no `if (hasProvider(...))` blocks
- [ ] `dynamic-kb.service.js` has no `if (hasProvider(...))` blocks for upload/delete
- [ ] `llm.openai.js` has no vector store or file management methods
- [ ] All existing KB functionality works exactly as before (upload, delete, sync, detach, provider view, dynamic KB attach/sync)
- [ ] Creating a KB with any provider combination works
- [ ] Uploading a file to a multi-provider KB uploads to all providers
- [ ] Syncing to a new provider works
- [ ] Deleting a file removes from all providers
