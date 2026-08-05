# Lybi HQ — server

Our internal company brain. **Not a product, not part of the builder, never customer-facing.**
Design doc: [`docs/guides/LYBI_HQ.md`](../docs/guides/LYBI_HQ.md).

> **Import rule — one direction only.** `hq/` may import from `services/` and `builder/`.
> **Nothing in the product may import from `hq/`.** That rule is what keeps the tiers separate
> while living in one repo.

## Layout

```
hq/
├── db/
│   ├── 001_hq_core.sql      hq_atoms · hq_sources · hq_links (idempotent)
│   └── migrate.js           runs every .sql here, in order
├── services/
│   ├── notion.service.js    Notion REST + blocks→markdown. Zero dependencies.
│   ├── atoms.service.js     atom/source persistence, hash-based upsert
│   ├── ingest.service.js    normalise → chunk → embed → Pinecone
│   ├── scribe.service.js    meeting → summary + decisions + actions
│   ├── ask.service.js       retrieve → answer → cite (bilingual retrieval)
│   └── drop.service.js      "here, take this" — link or text → atoms
└── routes/hq.routes.js      mounted at /api/hq
```

## Setup

```bash
node hq/db/migrate.js     # idempotent — safe to re-run
```

Environment:

| Var | Required | Notes |
|---|---|---|
| `NOTION_TOKEN` | for Notion import | Internal integration secret (`ntn_…`). Everything else works without it. |
| `PINECONE_API_KEY` / `PINECONE_INDEX_NAME` | yes | Reuses the shared `lybi` index; HQ lives in the `hq` namespace. |
| `OPENAI_API_KEY` | yes | Embeddings + query expansion. |
| `ANTHROPIC_API_KEY` | yes | Scribe + Ask. |
| `HQ_SCRIBE_MODEL` | no | default `claude-sonnet-4-6` |
| `HQ_ASK_MODEL` | no | default `claude-sonnet-4-6` |
| `HQ_EXPAND_MODEL` | no | default `gpt-4o-mini` — only rewrites the query |

### Connecting Notion (once, ~10 min)

1. notion.so → Settings → Connections → *Develop or manage integrations* → **New integration**
   (Internal).
2. Capabilities: **Read content**, **Read comments**, **Read user information**. Tick them now —
   adding one later means editing the integration *and* re-sharing.
3. Copy the secret → `NOTION_TOKEN`.
4. In Notion, open the page or database → `⋯` → **Connections** → add the integration.
   **This cascades to children**, so sharing one top-level parent covers everything beneath it.

A 404 from the API almost always means step 4 was skipped — the token is workspace-wide, but
access is opt-in per page tree.

## Endpoints

```
GET    /api/hq/status                what HQ knows, and whether Notion is wired
POST   /api/hq/drop/inspect          { input } → what a pasted string is (+ row count)
POST   /api/hq/drop                  { input, kind } → import. SSE for Notion, JSON otherwise.
GET    /api/hq/sources               connector health
POST   /api/hq/sources/:id/resync
DELETE /api/hq/sources/:id
GET    /api/hq/atoms                 ?kind= &search= &limit=
GET    /api/hq/atoms/:id
PATCH  /api/hq/atoms/:id             correct anything the Scribe got wrong
DELETE /api/hq/atoms/:id             drops its vectors too
POST   /api/hq/atoms/:id/scribe      re-run the Scribe
POST   /api/hq/atoms/:id/reindex
POST   /api/hq/ask                   { question } → { answer, citations, hits }
```

## Notes for whoever works on this next

- **Cost attribution is free.** Every LLM call is tagged `agentName: 'hq'` with a `crewMember`
  (`scribe` / `ask`), so `llm_usage` separates company spend from client spend with a `WHERE`
  clause — no migration, no extra column.
- **Bilingual retrieval is deliberate.** We speak a Hebrew/English mix and
  `text-embedding-3-small` is weak across scripts, so `ask.service` retrieves with the question in
  *both* languages and merges on best score. Without it, a Hebrew question returns nothing from an
  English transcript that plainly answers it — verified, not theoretical.
- **Re-ingest is cheap.** Atoms upsert on `external_id` and compare `content_hash`, so re-syncing a
  Notion database skips unchanged pages entirely and only re-embeds what moved.
- **The Scribe is fire-and-forget.** Transcripts are long; the HTTP request returns immediately with
  `scribe_status: 'running'` and the UI polls. Re-running it is safe and is the point of keeping
  full transcripts rather than summaries.
- **Client data must never be ingested.** The control is an allowlist at the source, not a filter at
  query time. Our Google Drive already contains client CSV exports (`drive-to-gcs.service.js`
  mirrors zer4u/hypertoy), so when the Drive watcher gets built it must take an explicit folder
  list — never the whole Drive. `hq_atoms.visibility` exists as a backstop, not the primary control.
