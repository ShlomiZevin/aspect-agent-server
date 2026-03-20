# Task: Fallback Model per Crew Member

## Background
Each crew member has a `model` property that determines which LLM handles its responses. If that provider goes down (rate limit, outage, timeout), the user gets an error. We need a fallback model that kicks in automatically when the primary fails, so conversations stay uninterrupted.

Default fallback for all crews: `gpt-4o` (OpenAI — most reliable).

## What Changes

### 1. Crew Member Config — `fallbackModel` property
Add an optional `fallbackModel` to `CrewMember` base class:
```js
super({
  model: 'gemini-2.5-flash',
  fallbackModel: 'gpt-4o',  // optional, default: 'gpt-4o'
});
```
Serialized in `toJSON()` so the client knows about it.

### 2. LLM Call — Fallback Logic
In the dispatcher's `_streamCrew` (or in the LLM service layer), wrap the primary call:
- If the primary model throws a retriable error (timeout, 429, 500, 502, 503), retry once with `fallbackModel`.
- If the fallback also fails → surface the error to the user as today.
- Track which model actually responded (primary vs fallback) on the response metadata.

**Important:** Only retry on provider errors. Do not retry on 400/validation errors — those indicate a prompt or config problem that the fallback won't fix.

### 3. Thinker Fallback
The thinker also has a `thinkingModel`. It should get its own `thinkingFallbackModel` (default: `gpt-4o`). Same retry logic.

### 4. DB — Store which model was used
The `messages` table has a `metadata` JSONB column. Add:
```json
{
  "model": "gemini-2.5-flash",
  "modelUsed": "gpt-4o",
  "fallbackUsed": true
}
```
`modelUsed` = the model that actually generated the response. `fallbackUsed` = true only when fallback kicked in.

### 5. Debug Panel — Show model used
In the debug bubble on each message, show:
- **Model:** `gemini-2.5-flash` (configured)
- **Actually used:** `gpt-4o` (fallback) — only when fallback kicked in
- When no fallback was used, just show the model as today.

### 6. Debug Screen — Configure fallback
On the debug side panel (where model override already exists):
- Add a fallback model selector (same model list as the primary).
- Session-level override like the primary model override.
- Show `fallbackModel` source: `crew_default` vs `session_override`.

### 7. Update Existing Crews
Add `fallbackModel` to all banking-onboarder-v2 crews:
- `welcome` (primary: `gemini-2.5-flash`) → fallback: `gpt-4o`
- `advisor` (primary: varies) → fallback: `gpt-4o`
- `review-finalize` (primary: varies) → fallback: `gpt-4o`

Other agents can adopt later — default `gpt-4o` covers them without code changes.

## Out of Scope
- Circuit breaker / retry queue across multiple messages
- Provider health dashboard
- Automatic model selection based on latency
- Fallback for the field extractor (separate task)

## Files Touched

| File | Change |
|------|--------|
| `crew/base/CrewMember.js` | Add `fallbackModel`, `thinkingFallbackModel` properties + `toJSON` |
| `crew/services/dispatcher.service.js` | Wrap `_streamCrew` / LLM call with fallback retry |
| `services/llm.openai.js` | Ensure errors are thrown with status codes |
| `services/llm.google.js` | Ensure errors are thrown with status codes |
| `services/llm.claude.js` | Ensure errors are thrown with status codes |
| `server.js` | Store `modelUsed` + `fallbackUsed` in message metadata |
| Client: `DebugPanel.tsx` | Show "actually used" model when fallback kicked in |
| Client: Debug side panel | Add fallback model selector |
| Client: `types/` | Update `DebugPromptData` with fallback fields |
| Banking-onboarder-v2 crews | Add `fallbackModel: 'gpt-4o'` |

## Acceptance Criteria
- [ ] Primary model works → response comes from primary, `fallbackUsed: false`
- [ ] Primary model fails (simulate timeout) → response comes from fallback, `fallbackUsed: true`
- [ ] Both fail → error shown to user
- [ ] Debug bubble shows which model actually responded
- [ ] Debug panel shows fallback model config and allows session override
- [ ] Thinker has its own fallback that works independently
