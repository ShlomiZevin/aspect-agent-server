# LLM Usage & Billing — Mapping and Plan

> Generated: 2026-03-14

---

## Part 1: Complete LLM Usage Map

### All LLM Calls in the Platform

| # | Usage | Provider(s) | Model | File |
|---|-------|-------------|-------|------|
| 1 | **Agent Chat (streaming)** | OpenAI / Claude / Gemini | Per crew config | `services/llm.js` → routes to provider |
| 2 | **Agent Chat (non-streaming)** | OpenAI | gpt-4 (default) | `services/llm.openai.js` |
| 3 | **Field Extraction** (micro-agent) | Any (routed by model) | `gpt-4o` / `gpt-4o-mini` | `crew/micro-agents/FieldsExtractorAgent.js` |
| 4 | **Thinking Advisor** (micro-agent) | Any (routed by model) | `claude-sonnet-4-20250514` | `crew/micro-agents/ThinkingAdvisorAgent.js` |
| 5 | **Podcast Transcription (OpenAI)** | OpenAI | `whisper-1` | `services/transcription.service.js` |
| 6 | **Podcast Transcription (Google)** | Google | `gemini-1.5-pro` | `services/transcription.service.js` |
| 7 | **Podcast Summarization** | Any (user-selected) | `claude-opus-4-6` (default) | `server.js:3312` |
| 8 | **Voice Message Transcription** | OpenAI | `whisper-1` | `server.js:3196` |
| 9 | **Crew Generation (AI Playground)** | Claude | Configurable | `services/llm.claude.js` |
| 10 | **Crew File Code Export** | Claude | Configurable | `services/llm.claude.js` |
| 11 | **SQL Generation** | Claude | `claude-sonnet-4-*` | `services/sql-generator.service.js` |
| 12 | **SQL Error Analysis** | Claude | `claude-sonnet-4-*` | `services/sql-helper.service.js` |
| 13 | **Schema Description** | Claude | `claude-sonnet-4-*` | `services/schema-descriptor.service.js` |
| 14 | **KB: Vector Store Mgmt** | OpenAI | N/A (storage) | `services/llm.openai.js` |
| 15 | **KB: Google File Search** | Google | N/A (storage) | `services/kb.google.service.js` |

### Current State: Single Key Per Provider

Today all usages of a provider share one API key. No way to see what costs what.

| Key | Env Variable | Used By (Usage #) |
|-----|-------------|-------------------|
| `openai_api_key` | `OPENAI_API_KEY` | 1,2,3,5,8,14 |
| `anthropic_api_key` | `ANTHROPIC_API_KEY` | 1,4,7,9,10,11,12,13 |
| `gemini_api_key` | `GEMINI_API_KEY` | 1,6,15 |

---

## Part 2: The Approach — Separate API Keys via Provider Projects/Workspaces

### How Provider Billing APIs Work

| Capability | OpenAI | Anthropic | Gemini (AI Studio) |
|------------|--------|-----------|-------------------|
| Token usage by API key | Yes (`group_by=api_key_id`) | Yes (`group_by[]=api_key_id`) | No API |
| Dollar cost by API key | **No** | **No** | No API |
| Dollar cost by Project/Workspace | **Yes** (`group_by=project_id`) | **Yes** (`group_by[]=workspace_id`) | No API |
| Budget caps | Yes (per project) | Yes (per workspace) | No |

**Key insight:** Both OpenAI and Anthropic give you **dollar costs per Project/Workspace** (not per API key). So the way to segregate costs is:

- **OpenAI** → Create separate **Projects** (each with its own API key)
- **Anthropic** → Create separate **Workspaces** (each with its own API key)
- **Gemini** → Switch to **Vertex AI** (costs appear in GCP BigQuery billing by service) OR accept no per-usage breakdown

### Proposed Usage Groups (Projects/Workspaces)

| Group Name | Usages Included | OpenAI Project | Anthropic Workspace |
|------------|----------------|----------------|---------------------|
| **chat** | Agent chat, field extraction, thinking advisor (#1-4) | `aspect-chat` | `aspect-chat` |
| **transcription** | Podcast + voice transcription (#5,6,8) | `aspect-transcription` | — (not used for transcription) |
| **content** | Podcast summarization (#7) | — | `aspect-content` |
| **tools** | Crew generation, SQL, schema (#9-13) | — | `aspect-tools` |
| **storage** | KB vector stores, file search (#14,15) | `aspect-storage` | — |

> Note: Some groups only apply to one provider. Chat is the big one — it uses all 3 providers.

### Alternative: Per-Agent Groups

If you want cost **per agent** instead of per usage type:

| Group | OpenAI Project | Anthropic Workspace |
|-------|----------------|---------------------|
| **freeda** | `aspect-freeda` | `aspect-freeda` |
| **aspect-insight** | `aspect-insight` | `aspect-insight` |
| **banking** | `aspect-banking` | `aspect-banking` |
| **platform** | `aspect-platform` (tools, playground, transcription) | `aspect-platform` |

> Can also combine: per-agent for chat, shared for platform tools.

---

## Part 3: Implementation Plan

### Phase 1: Create Projects & Workspaces (Manual, 30 min)

**OpenAI** (platform.openai.com → Settings → Projects):
1. Create projects: `aspect-chat`, `aspect-transcription`, `aspect-storage`
2. Generate API key for each project
3. Optional: set monthly budget caps per project

**Anthropic** (console.anthropic.com → Settings → Workspaces):
1. Create workspaces: `aspect-chat`, `aspect-content`, `aspect-tools`
2. Generate API key for each workspace

**Gemini**: Either keep as-is or switch to Vertex AI (see below).

### Phase 2: Extend Provider Config (Code Changes)

**2.1 Add new config keys to `provider-config.service.js`**

New keys to add to `ENV_FALLBACKS`:

```
openai_api_key_chat         → OPENAI_API_KEY_CHAT
openai_api_key_transcription → OPENAI_API_KEY_TRANSCRIPTION
openai_api_key_storage      → OPENAI_API_KEY_STORAGE
anthropic_api_key_chat      → ANTHROPIC_API_KEY_CHAT
anthropic_api_key_content   → ANTHROPIC_API_KEY_CONTENT
anthropic_api_key_tools     → ANTHROPIC_API_KEY_TOOLS
```

**2.2 Key resolution with fallback**

Each usage requests a specific key. If not set, falls back to the default key:

```
openai_api_key_chat → openai_api_key → OPENAI_API_KEY → null
```

This means:
- Start with just default keys (works today, no breakage)
- Add per-usage keys gradually as you create projects
- Everything keeps working even with only 1 key per provider

**Files to modify:**
- `services/provider-config.service.js` — add new keys + fallback logic

### Phase 3: Route API Keys to Usages (Code Changes)

Pass the appropriate key name to each LLM call point.

**3.1 LLM Service changes (`services/llm.js`)**

Add `apiKeyName` to the options that flow through the system:

```js
// Today:
sendOneShot(prompt, message, { model, context: 'field-extractor' })

// After:
sendOneShot(prompt, message, { model, context: 'field-extractor', apiKeyName: 'openai_api_key_chat' })
```

Each provider service (`llm.openai.js`, `llm.claude.js`, `llm.google.js`) checks:
1. If `apiKeyName` is provided → use `providerConfigService.getCached(apiKeyName)`
2. Otherwise → use default key (current behavior)

**3.2 Instrumentation points**

| File | Change | Key Name |
|------|--------|----------|
| `crew/services/dispatcher.service.js` | Pass `apiKeyName` based on usage type | `*_api_key_chat` |
| `crew/micro-agents/FieldsExtractorAgent.js` | Add `apiKeyName` to sendOneShot | `*_api_key_chat` |
| `crew/micro-agents/ThinkingAdvisorAgent.js` | Add `apiKeyName` to sendOneShot | `*_api_key_chat` |
| `services/transcription.service.js` | Use `openai_api_key_transcription` | `openai_api_key_transcription` |
| `server.js` (voice transcribe) | Use `openai_api_key_transcription` | `openai_api_key_transcription` |
| `server.js` (podcast summarize) | Use `anthropic_api_key_content` | `anthropic_api_key_content` |
| `services/sql-generator.service.js` | Use `anthropic_api_key_tools` | `anthropic_api_key_tools` |
| `services/sql-helper.service.js` | Use `anthropic_api_key_tools` | `anthropic_api_key_tools` |
| `services/schema-descriptor.service.js` | Use `anthropic_api_key_tools` | `anthropic_api_key_tools` |
| `services/llm.claude.js` (crew gen) | Use `anthropic_api_key_tools` | `anthropic_api_key_tools` |

**Files to modify:**
- `services/llm.js` — pass `apiKeyName` through to provider
- `services/llm.openai.js` — accept `apiKeyName`, resolve key
- `services/llm.claude.js` — accept `apiKeyName`, resolve key
- `services/llm.google.js` — accept `apiKeyName`, resolve key
- `services/transcription.service.js` — use per-usage key
- `crew/services/dispatcher.service.js` — attach key name
- `crew/micro-agents/FieldsExtractorAgent.js` — attach key name
- `crew/micro-agents/ThinkingAdvisorAgent.js` — attach key name
- `services/sql-generator.service.js` — attach key name
- `services/sql-helper.service.js` — attach key name
- `services/schema-descriptor.service.js` — attach key name
- `server.js` — podcast summarize, voice transcribe

### Phase 4: Update Billing Dashboard

**4.1 Update billing service to query per-project/workspace**

Modify `billing.service.js`:

```js
// OpenAI: query costs grouped by project
const costsUrl = `https://api.openai.com/v1/organization/costs?start_time=${startTs}&end_time=${endTs}&group_by=project_id`;

// Anthropic: query costs grouped by workspace
const costUrl = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start}&group_by[]=workspace_id`;
```

**4.2 Combine Billing + API Keys into one page**

New **"Usage & Billing"** page with tabs:

| Tab | Content |
|-----|---------|
| **Overview** | Provider cards with total cost (existing) + project/workspace breakdown |
| **By Project** | Cost per OpenAI project / Anthropic workspace / GCP service |
| **API Keys** | Existing API Keys page content (moved here) |

**Files to modify:**
- `services/billing.service.js` — add per-project/workspace queries
- `BillingPage.tsx` → rename to `UsageBillingPage.tsx`, add tabs
- `ApiKeysPage.tsx` — move into tab or import as component
- `DashboardLayout.tsx` — merge nav items

### Phase 5 (Optional): Vertex AI Switch for Gemini

If Gemini cost visibility matters:

```js
// In llm.google.js, change:
this.ai = new GoogleGenAI({ apiKey });
// To:
this.ai = new GoogleGenAI({ vertexai: true, project: 'aspect-agents', location: 'europe-west1' });
```

Then Gemini costs appear in GCP BigQuery billing under "Vertex AI" service. No separate API key needed — uses GCP service account auth.

---

## Summary

| Phase | What | Effort | Result |
|-------|------|--------|--------|
| **1** | Create OpenAI Projects + Anthropic Workspaces | 30 min (manual) | API keys ready |
| **2** | Add per-usage key config with fallback | 1-2 hours | Config layer ready |
| **3** | Route keys to each usage point | 2-3 hours | Keys actually used |
| **4** | Update billing dashboard | 1-2 days | Cost per project visible |
| **5** | Vertex AI switch (optional) | 30 min | Gemini in GCP billing |

**Total: ~2 days of coding** (Phases 2-4)

No logging, no custom tracking — just use provider billing APIs with separate projects/workspaces.
