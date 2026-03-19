# Knowledge Base System — User Guide

## Overview

The Knowledge Base (KB) system lets you manage files that your AI agents use to answer questions. Files are uploaded to **providers** (OpenAI, Google Gemini, Anthropic) where the AI can search and reference them during conversations.

There are two ways to manage KB content:

1. **Regular file upload** — Upload existing files (.pdf, .docx, .xlsx, etc.) directly to a KB
2. **Dynamic KB** — Create and edit files inside the platform, with automatic sync to all connected KBs

---

## Part 1: Dynamic KB

### What is Dynamic KB?

Dynamic KB lets you create and edit knowledge files directly in the dashboard — no need to prepare files externally. When you edit a dynamic file and it's attached to a KB, the system **automatically syncs** the updated content to all connected providers. No manual delete-and-reupload.

**Access:** Dashboard sidebar → **Dynamic KB**

### Creating a File

1. Click **+ New** in the Dynamic Files sidebar
2. Enter a file name (e.g. "Banking Fees", "Product Catalog")
3. Choose the type:
   - **Text** — Free-form content. Best for policies, FAQs, descriptions
   - **Table** — Structured data in a grid. Best for pricing, product lists, directories

### Editing a Text File

The text editor is a plain textarea where you write in **Markdown**. A guidance tip is shown above the editor:

- Use `## Headers` to separate topics — helps the AI find information faster
- Keep each section focused on one topic
- Use bullet lists (`-`) for related items
- Use `**bold**` for key terms
- Break content into short, titled sections — avoid walls of text

**Import:** Click "Import from .doc / .docx" to paste content from a Word document.

### Editing a Table File

The table editor shows a clean spreadsheet-like grid:

- **Add columns** — button at the right
- **Add rows** — button at the bottom
- **Edit cells** — click any cell to type
- **Delete rows/columns** — hover to see the × button
- **Tab** moves between cells, **Enter** moves down
- **Import** from .csv, .xls, or .xlsx — click the import button below the table

**How tables are stored:** Under the hood, the system converts your table to a special Markdown format optimized for AI retrieval. Each row becomes a self-contained block with all its column values, so the AI always has full context when finding data. You never see this format — the grid view is all you work with.

### Preview MD

Click **Preview MD** in the action bar to see the exact Markdown that gets sent to the AI. This is useful for:

- **Text files** — Verify your markdown structure looks right
- **Table files** — See how each row becomes a structured block that the AI can search

### Saving

- **Ctrl+S / Cmd+S** saves from anywhere in the editor
- The **Save** button at the bottom saves your changes
- An orange dot appears next to the file name when you have unsaved changes
- If the file is attached to KBs, the button shows **"Save & Sync to X KBs"** — saving automatically pushes the updated content to all connected providers
- A toast notification confirms the save and which KBs were synced

### Attaching to a Knowledge Base

Dynamic files are separate from KBs until you attach them:

1. Go to **Knowledge Base** in the dashboard
2. Select a KB
3. Click **Attach Dynamic File**
4. Choose which dynamic file(s) to attach
5. The file appears in the KB's file list with its content uploaded to the KB's providers

After attaching, any time you edit and save that dynamic file in the Dynamic KB page, all attached KBs are automatically updated.

### Detaching

To remove a dynamic file from a KB, delete it from the KB's file list (DB View). This removes it from the providers and clears the attachment link.

### Renaming

Renaming a dynamic file (click the name in the editor header) updates the file name everywhere — in the DB, in all attached KBs, and on all providers. The rename triggers a re-sync automatically.

### Deleting

Deleting a dynamic file removes it from Google Cloud Storage and detaches it from all KBs (removing it from all providers).

---

## Part 2: Provider Management

### Multiple Providers

Each KB can be connected to **any combination** of providers:

- **OpenAI** — Vector stores with semantic search (best retrieval quality)
- **Google Gemini** — File Search stores (free storage)
- **Anthropic** — Files injected as document blocks into Claude's context (no semantic search, but works for small KBs)

### Creating a KB

When creating a new KB, you see **checkboxes** for each provider. Select any combination — the system creates the necessary stores on each provider.

### Syncing to Additional Providers

If you have an existing KB on OpenAI + Gemini and want to add Anthropic:

1. Select the KB
2. Click **+ Sync to Provider**
3. A modal appears — check which providers to add
4. Click **Sync** — all existing files are copied to the new provider(s)

### Detaching a Provider

If a KB has 2+ providers, each provider row shows a **Detach** button. Detaching removes the provider's store and clears its file references. The KB continues working on the remaining providers.

### Provider View

The **DB View / Provider View** toggle in the file list header lets you see what actually exists on each provider:

- **DB View** — Files as recorded in our database
- **Provider View** — Files as they actually exist on OpenAI, Google, and Anthropic

This is useful for spotting mismatches (stale files, failed syncs). Each provider section shows file names, sizes, and statuses. You can:

- **Delete** files directly from any provider
- **Refresh** to get the latest state
- **Preview** files from the DB view (for dynamic KB files, shows the Markdown content)

> **Note:** Deletions may take a few seconds to reflect on the provider side. Use the Refresh button to check.

---

## Quick Reference

| Action | Where | How |
|--------|-------|-----|
| Create dynamic file | Dashboard → Dynamic KB | + New → choose text or table |
| Edit & save | Dynamic KB → select file | Edit content → Save (Ctrl+S) |
| Preview what AI sees | Dynamic KB → Preview MD | Click "Preview MD" button |
| Attach to KB | KB Manager → Attach Dynamic File | Select file(s) from list |
| Upload regular file | KB Manager → Upload Files | Drag & drop or browse |
| Sync to new provider | KB Manager → + Sync to Provider | Select provider(s) → Sync |
| Detach provider | KB Manager → provider ID row | Click Detach |
| Check provider state | KB Manager → Provider View toggle | View actual files on providers |
| Import table from Excel | Dynamic KB → table editor | Import .csv / .xls / .xlsx |
| Import text from Word | Dynamic KB → text editor | Import .doc / .docx |
