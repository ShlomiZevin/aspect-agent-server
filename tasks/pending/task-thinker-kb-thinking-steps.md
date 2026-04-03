# Thinker KB File Access → Thinking Steps

## Overview

When a thinker has KB enabled (added in the thinker KB feature), the files it accessed should appear in the thinking steps UI — just like the talker's KB access already does.

Currently, `sendOneShot` returns only `{ text, usage }`. The KB file access data exists in the provider response but is discarded. This task surfaces it through the thinking steps pipeline.

---

## Current State

- **Talker KB → thinking steps**: Works. The streaming path yields `file_search_results` events, which `server.js` (line ~1649) picks up and calls `thinkingService.addStep('file_search', ...)`.
- **Thinker KB → thinking steps**: Missing. `sendOneShot` returns `{ text, usage }` only. No file access data flows back.

### Provider-Specific KB Behavior

| Provider | KB Mechanism | File Access Data Available in Response? |
|----------|-------------|----------------------------------------|
| **OpenAI** | `file_search` tool → `file_search_call` output items | Yes — `response.output` contains `file_search_call` items with `results[]` (file names, scores) |
| **Google** | `fileSearch` tool → grounding metadata | Yes — `response.candidates[0].groundingMetadata.groundingChunks` contains `retrievedContext` with titles |
| **Claude** | Document blocks (file attach) | **No** — documents are injected as input, not retrieved via tool. Response contains no metadata about which documents were used |

**Conclusion**: OpenAI and Google can surface file access. Claude cannot — it would require a 3rd-party vector search (e.g., standalone OpenAI file_search call, Pinecone, or similar) to get retrieval metadata, which is a separate initiative.

---

## Implementation Plan

### Step 1: Extend `sendOneShot` Return Value (All Providers)

Each provider's `sendOneShot` currently returns `{ text, usage }`. Extend to `{ text, usage, fileSearchResults }`.

**OpenAI** (`llm.openai.js`):
```js
// After response = await this.client.responses.create(requestParams):
const fileSearchItems = response.output.filter(item => item.type === 'file_search_call');
const fileSearchResults = fileSearchItems.flatMap(item =>
  (item.results || [])
    .filter(r => r.score == null || r.score > 0.1)
    .map(r => ({ name: r.file_name || r.filename || 'Unknown', score: r.score }))
);
return { text, usage, fileSearchResults: fileSearchResults.length > 0 ? fileSearchResults : null };
```

**Google** (`llm.google.js`):
```js
// After response = await ai.models.generateContent(...):
const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
const fileSearchResults = groundingChunks
  .filter(c => c.retrievedContext)
  .map(c => ({ name: c.retrievedContext.title || c.retrievedContext.documentName || 'Unknown' }));
return { text, usage, fileSearchResults: fileSearchResults.length > 0 ? fileSearchResults : null };
```

**Claude** (`llm.claude.js`):
```js
// No change — return { text, usage, fileSearchResults: null }
// Claude document blocks don't produce retrieval metadata
```

### Step 2: Bubble Up Through ThinkingAdvisorAgent

`ThinkingAdvisorAgent.think()` currently returns parsed JSON advice. Extend to also return file search results.

```js
// In think():
const result = await llmService.sendOneShot(...);
// result is { text, usage } — after Step 1 it becomes { text, usage, fileSearchResults }

// Return fileSearchResults alongside the parsed advice:
return { ...parsedAdvice, _fileSearchResults: result.fileSearchResults };
```

Use `_` prefix to keep it out of the thinker's JSON schema (same convention as `_thinkingDescription`, `_thinkerModelUsed`).

### Step 3: Emit as Thinking Step in CrewMember.buildContext

In `CrewMember.buildContext()`, after the thinker returns, check for file search results and store them in context so the dispatcher can emit them.

```js
// After thinkingAdvice is set:
if (thinkingAdvice._fileSearchResults?.length > 0) {
  context._thinkerFileSearchResults = thinkingAdvice._fileSearchResults;
  delete thinkingAdvice._fileSearchResults; // Don't send to talker
}
```

### Step 4: Yield Event in Dispatcher

In `dispatcher.service.js` `_streamCrew`, after the thinking advisor event is yielded:

```js
// After: yield { type: 'thinking_advisor', advice: context.thinkingAdvice };
if (context._thinkerFileSearchResults?.length > 0) {
  yield { type: 'file_search_results', files: context._thinkerFileSearchResults, source: 'thinker' };
}
```

The existing `server.js` handler (line ~1649) already picks up `file_search_results` events and calls `thinkingService.addStep`. The `source: 'thinker'` field can optionally differentiate in the UI (e.g., "Thinker found files in KB: ..." vs "Found files in KB: ...").

---

## Files to Change

| File | Change |
|------|--------|
| `services/llm.openai.js` | `sendOneShot`: extract `file_search_call` results from `response.output` |
| `services/llm.google.js` | `sendOneShot`: extract grounding chunks from response |
| `services/llm.claude.js` | No change (return `fileSearchResults: null`) |
| `crew/micro-agents/ThinkingAdvisorAgent.js` | `think()`: return `_fileSearchResults` alongside advice |
| `crew/base/CrewMember.js` | `buildContext()`: move `_fileSearchResults` from advice to context |
| `crew/services/dispatcher.service.js` | `_streamCrew`: yield `file_search_results` event for thinker |
| `server.js` | Optional: differentiate thinker vs talker KB access in step description |

---

## Future: Claude KB Retrieval Metadata

Claude's document-block approach doesn't return retrieval metadata. To get file access visibility for Claude thinkers, options:

1. **Standalone vector search before thinker call** — call OpenAI's file_search API (or a vector DB) independently, inject results as text into thinker context, and use the search results for the thinking step. Most control, extra latency + cost.
2. **Switch thinker to OpenAI/Google when KB is needed** — loses Claude's reasoning quality for thinker use cases.
3. **Wait for Anthropic** — if/when Anthropic adds native retrieval with metadata.

This is out of scope for this task.

---

## Testing

1. Send a message to the banking onboarder v2 advisor crew
2. Verify thinker logs show `📚 Claude OneShot: injecting N document block(s)` (existing)
3. After this task: if thinker model is switched to OpenAI/Google, verify `file_search` thinking step appears in the UI with file names
4. Verify talker KB thinking steps still work as before (no regression)
