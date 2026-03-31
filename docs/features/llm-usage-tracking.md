# LLM Usage Tracking

## Overview

LLM Usage Tracking records every LLM API call made by the system — token counts, model used, provider, which process made the call, and which agent/crew/conversation it belongs to. This data feeds a dashboard in the admin panel where you can see cost breakdowns, usage patterns, and per-call details.

Unlike the Billing page (which pulls from provider APIs like Anthropic/OpenAI billing), this is **our own internal tracking** — every `sendOneShot` call is logged with full metadata. This gives visibility into exactly where tokens are spent: profiler, thinker, field extractor, or other processes.

---

## How It Works

1. **Each LLM provider** (`llm.claude.js`, `llm.openai.js`, `llm.google.js`) returns `{ text, usage }` from `sendOneShot`, where `usage` contains `inputTokens` and `outputTokens` as reported by the provider's API response.

2. **The central router** (`llm.js` `sendOneShot`) intercepts the response, extracts the usage data, and calls `logUsage()` — a fire-and-forget function that inserts a row into the `llm_usage` table. This never blocks, never throws, and never affects the LLM response.

3. **Callers pass metadata** through the options object — `context` (process name), `agentName`, `crewMember`, `conversationId`, `userId`. The router reads these and includes them in the log entry.

4. **The admin dashboard** fetches from two API endpoints and computes cost estimates client-side using a static rate table.

---

## What Gets Logged

Every `sendOneShot` call through `llm.js` is logged. This covers:

| Process | Description | Model (typical) |
|---------|-------------|-----------------|
| `profiler` | Background profile enrichment | claude-sonnet-4-6 |
| `thinker` | Strategic reasoning before crew response | claude-sonnet-4-6 |
| `field_extractor` | Structured field extraction from conversation | claude-sonnet-4-6 (form) / gpt-4o-mini (conv) |
| `one-shot` | Misc one-shot calls (gender inference, etc.) | gpt-4o-mini |
| `claude-one-shot` | Direct Claude calls (crew editor, SQL gen, etc.) | claude-sonnet-4-6 |
| `test-runner` | Persona generation for test runner | gpt-4o |

**Not logged (yet):** Streaming conversation calls. These go through `sendMessageStreamWithPrompt` which uses a different code path. Most conversations use Gemini Flash (cheap), so this is low priority. Can be added by yielding a usage event at the end of the stream.

---

## Database Table

```sql
CREATE TABLE llm_usage (
  id            SERIAL PRIMARY KEY,
  agent_name    VARCHAR(100),
  crew_member   VARCHAR(100),
  process       VARCHAR(50) NOT NULL,      -- profiler, thinker, field_extractor, etc.
  model         VARCHAR(100) NOT NULL,     -- claude-sonnet-4-6, gpt-4o-mini, etc.
  provider      VARCHAR(50) NOT NULL,      -- openai, anthropic, google
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  conversation_id VARCHAR(255),
  user_id       VARCHAR(255),
  created_at    TIMESTAMP DEFAULT NOW() NOT NULL
);
```

Drizzle schema defined in `db/schema/index.js` as `llmUsage`.

---

## Usage Logger

**File:** `services/usageLogger.js`

Single exported function:

```js
logUsage({
  process,          // required: "profiler", "thinker", "field_extractor", etc.
  model,            // required: "claude-sonnet-4-6"
  provider,         // required: "anthropic", "openai", "google"
  inputTokens,      // required: number
  outputTokens,     // required: number
  agentName,        // optional
  crewMember,       // optional
  conversationId,   // optional
  userId,           // optional
})
```

**Behavior:**
- Fire-and-forget — does not `await`, wraps in try/catch
- If DB insert fails, logs a warning and moves on
- Never blocks the LLM response or any calling code

---

## Architecture: How Logging Flows

```
Caller (ProfilerAgent, ThinkingAdvisor, FieldsExtractor, etc.)
    │
    │ sendOneShot(prompt, message, { context: 'profiler', agentName, ... })
    │
    ▼
llm.js sendOneShot()
    │
    │ 1. Routes to provider based on model name
    │ 2. Provider returns { text, usage }
    │ 3. Calls logUsage() with usage + metadata (fire-and-forget)
    │ 4. Returns just `text` to caller (backward compatible)
    │
    ▼
usageLogger.js logUsage()
    │
    │ INSERT INTO llm_usage (fire-and-forget)
    │
    ▼
llm_usage table
```

**Backward compatibility:** Callers that already existed before this feature still receive a plain string from `sendOneShot`. The unwrapping from `{ text, usage }` to `text` happens inside `llm.js`. No caller code needed to change for logging to work.

**Direct provider callers** (e.g., `crew-editor.service.js` calling `claudeService.sendOneShot` directly) have been updated to handle the `{ text, usage }` return format. These calls are not logged through the central router — they could be logged separately if needed.

---

## API Endpoints

### `GET /api/admin/usage`

Paginated usage rows with filters.

**Query params:**
- `from` — ISO date string (e.g., `2026-03-31T00:00:00`)
- `to` — ISO date string
- `agent` — filter by agent name
- `process` — filter by process name
- `model` — filter by model name
- `limit` — page size (default: 100)
- `offset` — pagination offset (default: 0)

**Response:**
```json
{
  "rows": [
    {
      "id": 1,
      "agentName": "Banking Onboarder V2",
      "crewMember": "advisor",
      "process": "thinker",
      "model": "claude-sonnet-4-6",
      "provider": "anthropic",
      "inputTokens": 6200,
      "outputTokens": 850,
      "conversationId": "abc-123",
      "userId": "anon_12345",
      "createdAt": "2026-03-31T10:15:00Z"
    }
  ],
  "total": 42
}
```

### `GET /api/admin/usage/summary`

Aggregated totals by process, model, and day.

**Query params:** `from`, `to` (same as above)

**Response:**
```json
{
  "byProcess": [
    { "process": "profiler", "count": 20, "totalInput": 180000, "totalOutput": 45000 },
    { "process": "thinker", "count": 15, "totalInput": 90000, "totalOutput": 12000 }
  ],
  "byModel": [
    { "model": "claude-sonnet-4-6", "provider": "anthropic", "count": 30, "totalInput": 250000, "totalOutput": 50000 }
  ],
  "byDay": [
    { "day": "2026-03-31", "count": 35, "totalInput": 270000, "totalOutput": 57000 }
  ]
}
```

---

## Admin Dashboard (Client)

**Location:** Dashboard > LLM Usage (nav item in sidebar)

**Component:** `components/dashboard/LLMUsagePage/LLMUsagePage.tsx`

### Features

1. **Date range picker** — defaults to today. Select any range and click Refresh.

2. **Summary cards** — four cards at the top:
   - Total Calls — number of LLM API calls
   - Input Tokens — total across all calls
   - Output Tokens — total across all calls
   - Estimated Cost — computed client-side using the rate table

3. **By Process table** — breakdown by process name (profiler, thinker, field_extractor, etc.) with color-coded badges

4. **By Model table** — breakdown by model and provider, with per-model cost estimation

5. **Recent Calls table** — individual call log with time, process, model, crew member, tokens, and cost

### Cost Estimation

Costs are computed **client-side** using a static rate table (not stored in DB). This makes it easy to update when prices change — just edit the `COST_PER_M` object in the component.

```typescript
const COST_PER_M = {
  'claude-sonnet-4-6':        { input: 3,    output: 15   },
  'claude-haiku-4-5-20251001': { input: 0.8,  output: 4    },
  'claude-opus-4-6':          { input: 15,   output: 75   },
  'gpt-4o':                   { input: 2.5,  output: 10   },
  'gpt-4o-mini':              { input: 0.15, output: 0.6  },
  'gemini-2.5-flash':         { input: 0.15, output: 0.6  },
  'gemini-2.5-pro':           { input: 1.25, output: 10   },
};
```

Unknown models show $0.00 cost (not a warning — just no estimate available).

---

## Files

### New Files
| File | Purpose |
|------|---------|
| `services/usageLogger.js` | Fire-and-forget usage logging utility |
| `components/dashboard/LLMUsagePage/LLMUsagePage.tsx` | Admin dashboard page |
| `components/dashboard/LLMUsagePage/LLMUsagePage.module.css` | Styles |
| `components/dashboard/LLMUsagePage/index.ts` | Export |

### Modified Files
| File | Change |
|------|--------|
| `db/schema/index.js` | Added `llmUsage` table definition |
| `services/llm.js` | Central logging in `sendOneShot` and `claudeOneShot` |
| `services/llm.claude.js` | Returns `{ text, usage }` from `sendOneShot` |
| `services/llm.openai.js` | Returns `{ text, usage }` from `sendOneShot` |
| `services/llm.google.js` | Returns `{ text, usage }` from `sendOneShot` |
| `crew/micro-agents/ProfilerAgent.js` | Passes metadata to sendOneShot options |
| `crew/micro-agents/ThinkingAdvisorAgent.js` | Passes metadata to sendOneShot options |
| `crew/micro-agents/FieldsExtractorAgent.js` | Accepts and passes metadata |
| `crew/base/CrewMember.js` | Passes crew/conversation metadata to thinker |
| `crew/services/dispatcher.service.js` | Passes metadata to field extractor |
| `server.js` | Usage API endpoints + passes metadata to profiler |
| `pages/DashboardPage.tsx` | Added LLM Usage route |
| `components/dashboard/DashboardLayout/DashboardLayout.tsx` | Added LLM Usage nav item |
| Direct callers (`crew-editor`, `sql-generator`, etc.) | Handle `{ text, usage }` return format |

---

## Future Improvements

- **Stream logging** — log conversation streaming calls (currently only one-shot calls are tracked)
- **DB persistence for cost rates** — admin-editable rate table instead of hardcoded
- **Alerts** — notify when daily cost exceeds a threshold
- **Per-user breakdown** — show which users consume the most tokens
- **Export** — CSV download of usage data
