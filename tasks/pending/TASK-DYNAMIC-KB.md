# Task: Dynamic KB — In-Platform File Editor with Auto-Sync to KB Providers

**Domain:** `aspect` (full-stack, all agents)
**Type:** Feature
**Priority:** High
**Assignee:** Kosta

---

## Background

Today, when a KB-backed agent's information changes (e.g. banking fees update), the admin must:
1. Prepare the updated file externally
2. Go to the KB Manager in the dashboard
3. Delete the old file
4. Upload the new file

This is slow, error-prone, and disconnected from the content creation workflow.

**Dynamic KB** solves this by letting admins create and edit files directly inside the dashboard. When a dynamic file is attached to a KB and later edited, the system **automatically re-syncs** it to all connected providers (OpenAI, Google, Anthropic). No manual delete-and-reupload cycle.

### What Already Exists
- **KB Manager** (`/dashboard/:agent/knowledge-base`) — create KBs, upload/delete files, sync between providers
- **KB Services** — `kb.service.js`, `kb.google.service.js`, `kb.anthropic.service.js`, `storage.service.js`
- **Google Cloud Storage** — used to store original files for cross-provider sync
- **Provider sync flow** — download original from GCS → upload to target provider → update DB
- **Dashboard layout** — sidebar nav with existing entries (Feedback, Users, Crew, KB, etc.)

### What's Missing
- No way to create/edit file content inside the platform
- No concept of a "dynamic file" that lives in the system and can be attached to KBs
- No auto-sync when a file's content changes

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Dashboard: Dynamic KB Page                             │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │ File List     │  │ Editor Area                      │ │
│  │               │  │                                  │ │
│  │ [+ New File]  │  │  [Text Editor]  or  [Table Grid] │ │
│  │               │  │                                  │ │
│  │ • fees.md     │  │  Import: [.doc] [.csv/.xls]      │ │
│  │ • rates.md    │  │                                  │ │
│  │ • menu.md     │  │  [Save]  [Save & Sync]           │ │
│  └──────────────┘  └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌─────────────────┐     ┌────────────────────────┐
│  DB: dynamic_    │     │  GCS: dynamic-files/   │
│  kb_files table  │     │  {agentId}/{fileId}.md  │
└────────┬────────┘     └────────────────────────┘
         │
         ▼  (if attached to KB)
┌─────────────────────────────────────────┐
│  Auto-sync to providers:                │
│  OpenAI (vector store) │ Google (corpus) │ Anthropic (files API)
└─────────────────────────────────────────┘
```

---

## File Format Decision

**Both text and table files are saved as `.md` (Markdown).** This is automatic — the user never chooses a format.

### Text Files → `.md` (Markdown)

The editor is a plain textarea where the user writes or pastes content. The UI should display a **persistent guidance note** above or beside the editor:

> **Tip — Markdown best practices for KB files:**
> - Use `## Headers` to separate topics — this helps the AI find information faster
> - Keep each section focused on one topic
> - Use bullet lists (`-`) for related items
> - Use `**bold**` for key terms the AI should anchor on
> - Avoid walls of unstructured text — break content into short, titled sections
>
> You can also import from a `.doc` / `.docx` file.

This guidance is important because structured markdown dramatically improves vector store chunking (OpenAI, Google) — headers create natural semantic boundaries that lead to better retrieval.

### Table Files → `.md` (One-Row-Per-Block Format)

The user sees and edits a **clean grid** (table UI). Under the hood, the system converts to a **one-row-per-block** markdown format optimized for KB retrieval accuracy.

**Why not CSV?** With CSV or markdown tables, if the vector store chunks mid-table, the header row gets separated from data rows. The LLM sees `$49.99, Electronics` with no idea what those columns mean.

**One-row-per-block** makes every entry self-contained. Even if the vector store grabs just one chunk, the LLM has full context:

```markdown
# Price List
> Last updated: 2026-03-18
> 4 items

---
## Widget X
- Product: Widget X
- Price: $49.99
- Category: Electronics
- Available: Yes
---
## Widget Y
- Product: Widget Y
- Price: $12.00
- Category: Home
- Available: No
---
```

**Conversion rules:**
1. File header: `# {file name}` + `> Last updated: {date}` + `> {row count} items`
2. Separator `---` between each entry
3. Each row becomes a block: `## {first column value}` as heading, then `- {header}: {value}` for every column
4. The first column value is repeated as both the heading and a list item (for redundancy in search)

**The user never sees this format.** The table editor shows a normal grid. The conversion to/from block format happens entirely in the server:
- **Save:** `TableData` (headers + rows JSON) → one-row-per-block `.md` → GCS
- **Load:** `.md` from GCS → parse back to `TableData` → send to client as JSON

The client always works with `{ headers: string[], rows: string[][] }`. The server handles the markdown conversion layer.

### GCS Storage

All dynamic files are stored as `.md`:

```
dynamic-files/{agentId}/{fileId}.md    (both text and table)
```

---

## What Changes

### 1. DB Schema — New `dynamic_kb_files` Table

Create a new migration adding the `dynamic_kb_files` table:

```sql
CREATE TABLE dynamic_kb_files (
  id            SERIAL PRIMARY KEY,
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  name          VARCHAR(255) NOT NULL,          -- display name (e.g. "Banking Fees")
  file_type     VARCHAR(20) NOT NULL,           -- 'text' | 'table'
  gcs_path      VARCHAR(1024),                  -- path in GCS where content is stored
  file_size     INTEGER DEFAULT 0,              -- size in bytes
  metadata      JSONB DEFAULT '{}',             -- future extensibility
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
```

Also add a **junction table** to track which dynamic files are attached to which KBs:

```sql
CREATE TABLE dynamic_kb_attachments (
  id                SERIAL PRIMARY KEY,
  dynamic_file_id   INTEGER NOT NULL REFERENCES dynamic_kb_files(id) ON DELETE CASCADE,
  knowledge_base_id INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  kb_file_id        INTEGER REFERENCES knowledge_base_files(id) ON DELETE SET NULL,
  -- kb_file_id links to the actual file record created in the KB when attached
  created_at        TIMESTAMP DEFAULT NOW(),
  UNIQUE(dynamic_file_id, knowledge_base_id)
);
```

Add the table definitions to `db/schema/index.js` following the existing pattern.

### 2. New Server Service — `dynamic-kb.service.js`

Location: `aspect-agent-server/services/dynamic-kb.service.js`

**CRUD operations:**
```js
createFile(agentId, name, fileType)           // → { id, name, fileType, ... }
getFilesByAgent(agentId)                      // → [{ id, name, fileType, updatedAt, attachmentCount }]
getFileById(fileId)                           // → { id, name, fileType, gcsPath, ... }
updateFile(fileId, { name })                  // → update metadata
deleteFile(fileId)                            // → delete from DB + GCS + detach from all KBs
```

**Content operations:**
```js
saveContent(fileId, content, fileType)
  // 1. If text: content is already markdown string → save as-is
  //    If table: content is JSON { headers, rows } → convert to one-row-per-block .md
  // 2. Upload .md to GCS at path: dynamic-files/{agentId}/{fileId}.md
  // 3. Update gcs_path and file_size in DB
  // 4. If file has attachments → trigger syncAttachedKBs(fileId)

loadContent(fileId)
  // 1. Download .md from GCS
  // 2. If text: return raw markdown string
  //    If table: parse one-row-per-block .md back to { headers, rows } JSON
  // 3. Return to client

// Table ↔ Markdown conversion helpers (server-side only):
tableToMarkdown(name, headers, rows)    // → one-row-per-block .md string
markdownToTable(mdString)               // → { headers, rows }
```

**Attachment operations:**
```js
attachToKB(dynamicFileId, knowledgeBaseId)
  // 1. Load .md content from GCS
  // 2. Create buffer with filename {name}.md
  // 3. Upload to KB's provider(s) using existing KB upload logic
  //    - OpenAI: llmService.addFileToVectorStore()
  //    - Google: googleKBService.uploadFile()
  //    - Anthropic: anthropicKBService.uploadFile()
  // 4. Save to knowledge_base_files table (get kb_file_id)
  // 5. Create dynamic_kb_attachments record with kb_file_id
  // 6. Update KB file stats

detachFromKB(dynamicFileId, knowledgeBaseId)
  // 1. Get attachment record (includes kb_file_id)
  // 2. Delete the file from KB providers (reuse existing delete logic)
  // 3. Delete knowledge_base_files record
  // 4. Delete dynamic_kb_attachments record
  // 5. Update KB file stats

getAttachments(dynamicFileId)
  // → [{ kbId, kbName, kbProvider }]

syncAttachedKBs(dynamicFileId)
  // THIS IS THE CORE VALUE OF THE FEATURE
  // Called after saveContent when file has attachments
  // For each attachment:
  //   1. Delete old file from provider(s) (using kb_file_id → get provider file IDs)
  //   2. Upload new content to provider(s)
  //   3. Update knowledge_base_files record with new provider IDs
  //   4. Update file stats
  // Use existing provider services — do NOT reinvent upload/delete logic
```

**Important:** `syncAttachedKBs` must reuse the existing provider upload/delete services. The flow is essentially: delete old → upload new → update DB. Look at how `server.js` handles the `/api/kb/:kbId/upload` and `/api/kb/:kbId/files/:fileId` (DELETE) endpoints for the exact provider-specific logic.

### 3. Server API Endpoints

Add to `server.js` (or a new router file if server.js is getting too large — use judgment):

```
GET    /api/dynamic-kb/:agentName/files              → list all dynamic files for agent
POST   /api/dynamic-kb/:agentName/files              → create new dynamic file
GET    /api/dynamic-kb/files/:fileId                  → get file metadata
GET    /api/dynamic-kb/files/:fileId/content          → load file content
PUT    /api/dynamic-kb/files/:fileId/content          → save file content (triggers auto-sync)
PUT    /api/dynamic-kb/files/:fileId                  → update file metadata (name)
DELETE /api/dynamic-kb/files/:fileId                  → delete file + detach from all KBs

GET    /api/dynamic-kb/files/:fileId/attachments      → list KB attachments
POST   /api/dynamic-kb/files/:fileId/attach/:kbId     → attach to KB
DELETE /api/dynamic-kb/files/:fileId/attach/:kbId     → detach from KB
```

**Import endpoints (file parsing happens server-side):**
```
POST   /api/dynamic-kb/import/doc                     → upload .doc/.docx → return extracted text
POST   /api/dynamic-kb/import/spreadsheet             → upload .csv/.xls/.xlsx → return parsed table JSON
```

For `.docx` parsing, use the existing `mammoth` dependency (already used in `kb.google.service.js`).
For `.xlsx` parsing, use the existing `xlsx` dependency (already used in `kb.google.service.js`).
For `.csv` parsing, use a simple `csv-parse` or split-by-delimiter approach.

### 4. Client Service — `dynamicKBService.ts`

Location: `aspect-react-client/src/services/dynamicKBService.ts`

API client mirroring the server endpoints. Follow the pattern in `kbService.ts`:

```typescript
// CRUD
getFiles(agentName: string): Promise<DynamicFile[]>
createFile(agentName: string, name: string, fileType: 'text' | 'table'): Promise<DynamicFile>
updateFile(fileId: number, data: { name: string }): Promise<void>
deleteFile(fileId: number): Promise<void>

// Content
loadContent(fileId: number): Promise<string>
saveContent(fileId: number, content: string): Promise<{ synced: boolean; syncedKBs?: string[] }>

// Attachments
getAttachments(fileId: number): Promise<DynamicFileAttachment[]>
attachToKB(fileId: number, kbId: number): Promise<void>
detachFromKB(fileId: number, kbId: number): Promise<void>

// Import
importDoc(file: File): Promise<{ text: string }>
importSpreadsheet(file: File): Promise<{ headers: string[]; rows: string[][] }>
```

### 5. Client Types — `dynamicKB.ts`

Location: `aspect-react-client/src/types/dynamicKB.ts`

```typescript
export interface DynamicFile {
  id: number;
  agentId: number;
  name: string;
  fileType: 'text' | 'table';
  fileSize: number;
  attachmentCount: number;       // how many KBs this is attached to
  createdAt: Date;
  updatedAt: Date;
}

export interface DynamicFileAttachment {
  kbId: number;
  kbName: string;
  kbProvider: string;
}

export interface TableData {
  headers: string[];
  rows: string[][];              // 2D array of cell values
}
```

### 6. Client Hook — `useDynamicKB.ts`

Location: `aspect-react-client/src/hooks/useDynamicKB.ts`

State management hook following the pattern of `useKnowledgeBase.ts`:

```typescript
const {
  files,                    // DynamicFile[]
  selectedFile,             // DynamicFile | null
  content,                  // string (text files) or TableData (table files)
  attachments,              // DynamicFileAttachment[]
  isLoading, isSaving,
  isDirty,                  // unsaved changes indicator
  error,

  loadFiles,
  selectFile,               // loads content + attachments
  createFile,
  updateFileName,
  deleteFile,
  saveContent,              // returns sync result
  importFromDoc,
  importFromSpreadsheet,
  attachToKB,
  detachFromKB,
} = useDynamicKB(agentName);
```

### 7. Client UI — Dynamic KB Page & Components

#### A. New Dashboard Nav Entry

In `DashboardLayout.tsx`, add a new nav item (place it right after "Knowledge Base"):

```typescript
{ path: 'dynamic-kb', label: 'Dynamic KB', icon: '...' }  // pencil-document style icon
```

#### B. DynamicKBPage Component

Location: `aspect-react-client/src/components/dashboard/DynamicKBPage/DynamicKBPage.tsx`

**Layout:** Two-panel (sidebar + editor), similar to the KB Manager pattern.

**Left sidebar:**
- List of dynamic files for the agent
- Each item shows: name, type icon (text/table), last updated, attachment count badge
- "New File" button → modal asking for name and type (text or table)
- Selected file is highlighted
- Delete button per file (with confirmation if attached to KBs)

**Right editor area (when a file is selected):**
- Header: file name (editable inline), file type badge, last saved timestamp
- **Dirty indicator**: show unsaved changes warning (dot or label)
- **Attachments bar**: shows which KBs this file is attached to (chips/badges)
- **Editor** (depends on file type):
  - **Text**: textarea or simple rich-text area. "Import from .doc" button.
  - **Table**: grid/spreadsheet component. "Import from .csv/.xls" button. Add row/column buttons. Delete row/column. Editable cells.
- **Action bar**: [Save] button. If file has attachments, show "Save & Sync to X KBs" with sync icon. [Preview MD] button (see section F below).
- **Import buttons**: positioned near the editor, clearly labeled. Import replaces current content (with confirmation if dirty).
- **Note on imports**: Users can still upload `.doc`/`.docx` into text files and `.csv`/`.xls`/`.xlsx` into table files. The import parses the file into the editor (text or grid). On save, the server converts everything to `.md`. The flow is: `upload .xls → parsed into grid → user edits → save → server converts to one-row-per-block .md`. Same for text: `upload .docx → extracted text into textarea → user edits → save → stored as .md`.

#### C. Text Editor Sub-Component

Location: `aspect-react-client/src/components/dashboard/DynamicKBPage/TextEditor.tsx`

- Simple `<textarea>` with monospace font, full-height
- Controlled component: `value` + `onChange`
- "Import from .doc/.docx" button that:
  1. Opens file picker (accept=".doc,.docx")
  2. Sends to `/api/dynamic-kb/import/doc`
  3. Sets returned text as content

Keep it simple — no rich text formatting, no WYSIWYG. The content goes to LLMs, not humans.

#### D. Table Editor Sub-Component

Location: `aspect-react-client/src/components/dashboard/DynamicKBPage/TableEditor.tsx`

- HTML `<table>` with `contentEditable` cells or controlled inputs
- Features:
  - Click cell to edit
  - Add row (button at bottom)
  - Add column (button at right)
  - Delete row (button per row)
  - Delete column (button per column header)
  - Tab navigation between cells
- "Import from .csv/.xls/.xlsx" button that:
  1. Opens file picker (accept=".csv,.xls,.xlsx")
  2. Sends to `/api/dynamic-kb/import/spreadsheet`
  3. Replaces table with returned data
- Internally stores data as `TableData` (`{ headers, rows }`)
- Sends JSON `{ headers, rows }` to the server on save — the server converts to one-row-per-block markdown (the client never deals with the markdown format)

**UX priority:** The table editor must feel intuitive and responsive. Think Google Sheets lite — not a complex spreadsheet, just a clean editable grid. Use CSS for clean cell borders, hover states, selected cell highlight.

#### F. Preview MD Modal

Location: `aspect-react-client/src/components/dashboard/DynamicKBPage/PreviewMDModal.tsx`

A modal triggered by a **"Preview MD"** button in the editor action bar. Shows the user the exact markdown that will be saved and sent to KB providers — i.e., what the LLM will actually see.

- **For text files**: Shows the raw markdown content as-is (since the user already writes markdown). Still useful to confirm.
- **For table files**: This is where the real value is — shows the one-row-per-block conversion so the user can see how their grid data translates to the structured format the LLM receives.

**Implementation:**
- For text: just display the current textarea content in a read-only code block
- For table: call a client-side preview version of `tableToMarkdown()` (or hit a lightweight server endpoint `POST /api/dynamic-kb/preview` that takes `{ headers, rows }` and returns the markdown string)
- Display in a modal with monospace font, syntax-highlighted if possible, read-only
- "Copy to clipboard" button for convenience
- Modal title: "Markdown Preview — This is what the AI will see"

**Recommendation:** Implement the conversion client-side too (it's simple string concatenation) so the preview is instant with no server round-trip. The server still has its own canonical conversion for saving.

#### E. Attach Dynamic File — In Existing KB Manager

In `KBManager.tsx`, add an "Attach Dynamic File" button alongside the existing "Upload Files" button.

Clicking it opens a modal (`AttachDynamicFileModal`) that:
1. Fetches dynamic files for the current agent via `GET /api/dynamic-kb/:agentName/files`
2. Shows a list with checkboxes (filter out already-attached files)
3. "Attach" button triggers `POST /api/dynamic-kb/files/:fileId/attach/:kbId` for each selected file
4. On success, refresh the KB's file list — the dynamic file now appears as a regular file in the KB

Dynamic files in the KB file list should have a visual indicator (e.g., a small "dynamic" badge or link icon) so the user knows they're managed elsewhere.

### 8. Auto-Sync Flow (Critical Path)

This is the most important part of the feature. When a user edits a dynamic file and saves:

```
User clicks "Save" in Dynamic KB editor
  │
  ▼
PUT /api/dynamic-kb/files/:fileId/content
  │
  ├─► Save content to GCS (overwrite)
  │
  ├─► Check dynamic_kb_attachments for this file
  │   │
  │   └─► For EACH attachment:
  │       │
  │       ├─► Get the KB record (provider info)
  │       ├─► Get the kb_file_id from attachment
  │       ├─► Get provider file IDs from knowledge_base_files record
  │       │
  │       ├─► DELETE old file from provider(s):
  │       │   ├─ OpenAI: delete from vector store
  │       │   ├─ Google: delete document from corpus
  │       │   └─ Anthropic: delete from Files API
  │       │
  │       ├─► UPLOAD new content to provider(s):
  │       │   ├─ OpenAI: add to vector store
  │       │   ├─ Google: upload to corpus
  │       │   └─ Anthropic: upload via Files API
  │       │
  │       ├─► UPDATE knowledge_base_files record with new provider IDs
  │       └─► UPDATE KB file stats
  │
  └─► Return response: { synced: true, syncedKBs: ["KB Name 1", "KB Name 2"] }
```

**The response should tell the client which KBs were synced**, so the UI can show a success toast: "Saved and synced to 2 knowledge bases".

### 9. GCS Storage Path Convention

Dynamic files are stored separately from regular KB files. Both types are `.md`:

```
Regular KB files:  kb-files/{kbId}/{timestamp}-{safeName}
Dynamic files:     dynamic-files/{agentId}/{fileId}.md    (both text and table)
```

When attaching to a KB, the file is **also** uploaded to the KB's provider(s) — but the "source of truth" for content is always the GCS dynamic file path. The provider copies are just for the LLM to search.

---

## UX Requirements

**This is critical — the UI must be intuitive, clean, and feel premium. Not just functional.**

- **Unsaved changes**: Clear visual indicator. Warn before navigating away (browser `beforeunload` + in-app confirmation).
- **Save feedback**: Show a toast/notification on successful save. If sync happened, mention which KBs were synced.
- **Loading states**: Skeleton loaders when loading file list and content. Spinner on save button while saving.
- **Error handling**: Inline error messages (not just console). If sync partially fails, show which KBs failed.
- **Empty states**: Nice empty state when no files exist ("Create your first dynamic file").
- **Responsive**: The editor should fill available space. Table should scroll horizontally if many columns.
- **Keyboard shortcuts**: Ctrl+S / Cmd+S to save from the editor.
- **Table usability**: Tab between cells. Enter to move down. Click to edit. Clear hover/focus states.
- **File deletion warning**: If deleting a dynamic file that's attached to KBs, warn that it will be removed from those KBs.
- **Attachment visibility**: In the KB Manager, dynamic files should be clearly distinguishable from manually uploaded files.

---

## Out of Scope

- Version history / undo for dynamic files (future enhancement)
- Collaborative editing (single user at a time is fine)
- Rich text formatting (bold, italic, etc.) — plain text/markdown only
- Drag-and-drop reordering of rows/columns in table editor
- Permissions / access control for dynamic files
- Dynamic file templates or presets

---

## Files Touched

| File | Change |
|------|--------|
| `db/schema/index.js` | Add `dynamicKBFiles` and `dynamicKBAttachments` tables |
| `db/migrations/0XX_add_dynamic_kb.sql` | Migration for new tables |
| `services/dynamic-kb.service.js` | **New** — CRUD, content, attachment, sync logic |
| `server.js` | Add dynamic KB API endpoints (or new router) |
| `src/services/dynamicKBService.ts` | **New** — API client |
| `src/types/dynamicKB.ts` | **New** — TypeScript interfaces |
| `src/hooks/useDynamicKB.ts` | **New** — State management hook |
| `src/components/dashboard/DynamicKBPage/` | **New** — Page, TextEditor, TableEditor |
| `src/components/dashboard/DashboardLayout.tsx` | Add nav entry |
| `src/components/kb/KBManager/KBManager.tsx` | Add "Attach Dynamic File" button + modal |
| `src/components/kb/AttachDynamicFileModal/` | **New** — Modal for attaching dynamic files |

---

## Acceptance Criteria

- [ ] **Create & edit text files**: Can create a text dynamic file, type content, save, reload, and see the same content
- [ ] **Create & edit table files**: Can create a table dynamic file, add rows/columns, edit cells, save, reload, and see the same data
- [ ] **Import from .doc/.docx**: Importing a Word document populates the text editor with extracted text
- [ ] **Import from .csv/.xls/.xlsx**: Importing a spreadsheet populates the table editor with parsed data
- [ ] **Files stored on GCS**: Content is persisted in Google Cloud Storage under `dynamic-files/` path
- [ ] **Attach to KB**: From the KB Manager, can attach a dynamic file to a KB — file appears in KB's file list and is uploaded to the KB's provider(s)
- [ ] **Detach from KB**: Can detach a dynamic file — file is removed from KB's provider(s)
- [ ] **Auto-sync on edit (THE BIG ONE)**: Edit a dynamic file that's attached to a KB → save → the KB's provider(s) receive the updated content. Verify by asking the agent about the updated content — it should reflect the changes.
- [ ] **Multi-KB sync**: A dynamic file attached to 2+ KBs syncs to all of them on save
- [ ] **Cross-provider sync**: A dynamic file attached to an OpenAI KB and a Google KB syncs to both providers correctly
- [ ] **Delete cascade**: Deleting a dynamic file removes it from all attached KBs
- [ ] **UI polish**: Unsaved changes indicator works, save toast appears, loading states are smooth, table editor is intuitive, empty states are clean
- [ ] **Existing KB unaffected**: Regular file upload/delete in KB Manager still works exactly as before

---

## Testing Guide

### Setup
1. Make sure you have at least one agent with a KB (any provider)
2. The agent should have a crew member with `knowledgeBase.sources` pointing to that KB

### Test Sequence

**Phase 1 — Basic CRUD**
1. Go to Dashboard → Dynamic KB
2. Create a text file called "Test Info". Type some unique content (e.g., "The company was founded in 2019 by Alice and Bob").
3. Save. Reload page. Content should persist.
4. Create a table file called "Price List". Add headers: Product, Price, Category. Add 3 rows of data.
5. Save. Reload. Table should persist exactly.
6. Rename "Test Info" to "Company Info". Delete a test file.

**Phase 2 — Import**
7. Create a text file. Click "Import from .doc". Upload a .docx file. Text should appear.
8. Create a table file. Click "Import from .csv". Upload a CSV. Table should populate.
9. Try importing .xlsx — should also work.

**Phase 3 — Attach & Sync (Critical)**
10. Go to KB Manager → select a KB → click "Attach Dynamic File" → select "Company Info".
11. The file should appear in the KB's file list (with a dynamic badge).
12. Go to the agent chat. Ask: "When was the company founded?" → Should answer "2019 by Alice and Bob".
13. Go back to Dynamic KB → edit "Company Info" → change to "founded in 2023 by Charlie".
14. Save (should show "Synced to 1 KB" toast).
15. Go to agent chat (new conversation). Ask the same question → Should now answer "2023 by Charlie".
16. **This is the money test.** If this works, the feature works.

**Phase 4 — Edge Cases**
17. Attach the same dynamic file to a second KB (different provider if possible). Edit and save → both should sync.
18. Detach from one KB. Edit and save → only the remaining KB should sync.
19. Delete a dynamic file that's attached → should be removed from KB cleanly.
20. Try saving with no changes → should still work (idempotent).
