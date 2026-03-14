# Task: Crew Editor — Two-Phase Chat (Discuss + Generate)

> **Part of:** `task-crew-editor-v2.md` (coordinating task). Implement together with `task-crew-editor-thinker-awareness.md`.

## Problem

The crew editor sends the **full system prompt (~50KB)** on every single chat message:
- 44KB AGENT_BUILDING_GUIDE.md
- ~5KB crew source file
- ~3KB editor instructions

Claude also outputs the **complete updated file** on every response, even when the user is just asking a question or discussing an idea.

**Result:** $0.99/session, 3-5s response latency, and Claude edits before understanding the full picture.

## Solution: Two-Phase Chat

Split the chat into two modes:

### Phase 1: Discuss (default)
- Lightweight prompt: role description + extracted guidance text + field names only
- For thinker crews: also includes the full thinking prompt text (strategy rules + JSON schema) — this is essential for Claude to discuss strategy changes intelligently
- Claude discusses, asks clarifying questions, understands what to change
- No code output — plain language only
- Fast responses (~0.5-1s)
- Claude never decides to switch to generate mode — the user controls that via the Generate button

### Phase 2: Generate (on demand)
- Full prompt: complete crew source + AGENT_BUILDING_GUIDE + all editor instructions
- Triggered explicitly by the user (button click or message like "do it")
- Claude outputs the complete updated file
- One call per edit cycle

**Cost: $0.15/session (85% cheaper). Response time: ~4x faster for discuss messages.**

## Implementation

### Server: `crew-editor.service.js`

#### 1. New method: `_buildDiscussPrompt(currentSource)`

Uses `_extractCrewSummary()` to get guidance, fields, transition, and thinker info. Builds a lightweight prompt with just enough context for discussion. For thinker crews, includes the full thinking prompt text so Claude can discuss strategy changes intelligently:

```
You are a crew member editor for the Aspect multi-agent platform.
You're helping improve a crew member's behavior. The user is a product expert, NOT a developer. Speak in plain language.

===== CURRENT CREW BEHAVIOR =====

**Guidance (what the agent says/does):**
{extracted guidance text}

**Fields collected:**
{field names + descriptions}

**Transitions to:** {transitionTo value}

{if isThinker:}
===== THINKER+TALKER CREW =====

This is a thinker+talker crew. Two LLMs work together:
- **Thinker** (Claude) — decides WHAT to do: what to ask, what strategy to follow, when to recommend. Returns structured JSON.
- **Talker** (GPT-5) — decides HOW to say it: tone, phrasing, personality. Follows the thinker's advice.

**Thinking prompt (strategy + JSON schema):**
{extracted thinking prompt text}

When discussing changes:
- "What to say / ask / decide / recommend" → this is a thinking prompt change
- "How to say it / tone / personality / phrasing" → this is a guidance change
- Tell the user which one you'd change and why
{end if}

===== YOUR ROLE =====

- Discuss what changes the user wants
- Ask clarifying questions if the request is vague
- Suggest approaches and explain trade-offs
- DO NOT output code or the full file yet — that happens when the user clicks "Generate"
- Focus on understanding the problem before proposing a solution
- When the user reports "the agent did X wrong" — find what's causing it, don't just suggest adding "don't do X"

===== PROMPT FIXING PRINCIPLES =====

When the user reports a problem, think about root cause:
1. Find what in the current prompt is CAUSING the wrong behavior
2. Fix the definition — rewrite the rule so the right behavior is clear
3. Never add "don't do [thing that went wrong]" — that's a patch, not a fix
4. Describe desired behavior positively, not as a list of prohibitions
```

#### 2. New method: `_extractCrewSummary(source)`

Regex-based extraction:
- Guidance: match `get guidance()` getter, extract the template literal content
- Fields: match `get fieldsToCollect()` array, extract field names and descriptions
- TransitionTo: match `get transitionTo()` return value
- IsThinker: check for `usesThinker = true`
- ThinkingPrompt: if thinker, extract the full `THINKING_PROMPT` constant content (strategy rules + JSON schema)

Returns `{ guidance, fields, transitionTo, isThinker, thinkingPrompt }`.

#### 3. Modify `_buildSystemPrompt` → rename to `_buildGeneratePrompt`

Same as current full prompt, but add a preamble:

```
The user has been discussing changes with you. Based on that discussion, generate the complete updated crew file.
```

#### 4. Modify `chatWithClaude()`

Accept new parameter `mode`:

```javascript
async chatWithClaude(agentName, crewName, messages, currentSource, mode = 'discuss') {
  // ...
  const systemPrompt = mode === 'generate'
    ? this._buildGeneratePrompt(currentSource, guideContent)
    : this._buildDiscussPrompt(currentSource);
  // ...
  // Only extract source code from response in generate mode
  const updatedSource = mode === 'generate'
    ? this._extractUpdatedSource(response)
    : null;
  // ...
}
```

In discuss mode, skip loading the AGENT_BUILDING_GUIDE entirely.

#### 5. Modify `_extractUpdatedSource()`

No changes needed — it's only called in generate mode.

### Server: `server.js`

Update the chat endpoint to accept `mode`:

```javascript
// POST /api/admin/crew/:agentName/:crewName/chat
const { messages, currentSource, mode } = req.body;
const result = await crewEditorService.chatWithClaude(
  agentName, crewName, messages, currentSource, mode || 'discuss'
);
```

### Client: `crewEditorService.ts`

Update `chatWithClaude` to accept and pass `mode`:

```typescript
export async function chatWithClaude(
  agentName: string,
  crewName: string,
  messages: CrewEditorMessage[],
  currentSource: string,
  baseURL: string,
  mode: 'discuss' | 'generate' = 'discuss'
): Promise<CrewChatResponse> {
  const res = await fetch(`${baseURL}/api/admin/crew/${agentName}/${crewName}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, currentSource, mode }),
  });
  // ...
}
```

### Client: `CrewEditorAI.tsx`

#### Chat sends in discuss mode by default

The existing "Send" button calls `chatWithClaude(... , 'discuss')`.

#### New "Generate Changes" button

Add a button in the chat panel (next to or below the input area). When clicked:
- Sends the current conversation with `mode: 'generate'`
- The response will include `updatedSource`
- Code panel switches to show proposed source (existing flow)

Visual: a distinct button (different color/style from Send) labeled "Generate Changes" or with an icon (wand/sparkle).

#### Optional: auto-detect readiness

If Claude's discuss response indicates it's ready to generate (e.g., "I understand, shall I make the changes?"), show a hint or auto-highlight the Generate button. This is a nice-to-have, not required for v1.

### Client: `crew.ts` types

No new types needed — `CrewChatResponse` already has optional `updatedSource`.

## Files to Modify

| File | Change |
|------|--------|
| `aspect-agent-server/services/crew-editor.service.js` | Add `_buildDiscussPrompt`, `_extractGuidanceAndFields`, rename/modify prompts, add `mode` param |
| `aspect-agent-server/server.js` | Pass `mode` from request body to `chatWithClaude` |
| `aspect-react-client/src/services/crewEditorService.ts` | Add `mode` parameter |
| `aspect-react-client/src/components/dashboard/CrewEditorAI/CrewEditorAI.tsx` | Default to discuss mode, add Generate button |
| `aspect-react-client/src/components/dashboard/CrewEditorAI/CrewEditorAI.module.css` | Style for Generate button |

## Verification

### Standard crew
1. Open crew editor, select a standard crew member
2. Send "the agent is asking too many questions" → Claude responds in plain language, asks what specifically is wrong, no code
3. Have a 2-3 message discussion → all responses fast, no code
4. Click "Generate Changes" → Claude outputs the full updated file with explanation
5. Code panel shows proposed source → Apply flow works as before
6. Check server logs: discuss calls should NOT load the AGENT_BUILDING_GUIDE

### Thinker crew
7. Load a thinker crew (e.g., banking-onboarder-v2 main-conversation)
8. Send "the agent recommends too early" → Claude should discuss the thinking prompt strategy rules, mention it's a thinking prompt issue (not guidance)
9. Send "also the tone is too formal" → Claude should identify this as a guidance change and explain the difference
10. Click "Generate Changes" → Claude outputs the complete file with changes to BOTH the thinking prompt and guidance, clearly explaining which part changed and why
11. Send "the agent asked about income on the first message" → Claude should NOT suggest "add don't ask income first" — should discuss fixing the strategy rules
