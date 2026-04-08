# Task: Final Summary as a Designed Card (generic engine + domain-specific use)

## Background
Some closing messages are special — the LLM produces a 5-section message celebrating something (account opened, plan activated, onboarding done) and we want it rendered as a fully designed branded card instead of a regular markdown bubble.

First use case: the closing message of the **review-finalize** crew in Banking Onboarder V2, which already produces a 5-section celebratory message (opening / products / next steps / service / closing). Today it renders as plain markdown in neutral colors. Noa wants a designed card with bank brand colors, contained product elements, app download buttons, and clear visual hierarchy.

This task builds a **generic engine feature** and uses it for one **domain-specific** crew. No agent-specific code lives in the engine.

---

## Architecture Principles (CRITICAL)

These were learned during a previous implementation attempt — the same reasoning that drove the refactor must drive this build from the start.

1. **Engine vs domain split must be strict**
   - Engine layer (`crew/`, `services/`, client `components/`, `types/`): NO references to specific agents, NO Hebrew, NO banking terminology, NO hardcoded section structures.
   - Domain layer (`agents/banking-onboarder-v2/`): all banking-specific text, all Hebrew section labels, the formatter prompt, the trigger field name.

2. **The formatter agent must be domain-agnostic**
   - It accepts a `formatterPrompt` parameter from the crew config.
   - It does NOT contain banking-specific instructions in its own code.
   - Default fallback prompt should be minimal/generic, not banking-flavored.

3. **The card schema must be section-array based, not fixed keys**
   - WRONG (previous attempt): hardcoded `{ opening, products, nextSteps, appLinks, service, closing }` keys in the formatter, types, and React component. Locks the card to one domain shape.
   - RIGHT: `{ sections: [{ id, type, label, content?, items?, buttons? }, ...] }`. Order is render order. Type maps to a renderer. Label comes from the LLM in the message's language.

4. **Section labels must come from the LLM, not hardcoded in the React card**
   - Hardcoding `'מה פתחנו עבורך'` in the card component means only Hebrew agents can use it.
   - The LLM produces labels in the same language as the message content.

5. **Section types are engine-defined, but extensible**
   - Standard renderers: `headline`, `cards`, `text_with_buttons`, `key_value_list`, `footer`.
   - Unknown types must degrade gracefully (label + content fallback) so a new section type doesn't break old clients.

6. **Trigger detection is generic, not crew-name based**
   - The dispatcher must NOT contain `if (crew.name === 'review-finalize')`.
   - It checks `crew.finalSummaryConfig?.enabled` and the configured `triggerField` in collected fields.

7. **Idempotent — emit only once per conversation**
   - Persist a `finalSummaryEmitted: true` flag in conversation metadata after a successful emission.
   - On subsequent turns, the dispatcher sees the flag and skips the special path.

---

## Generic Engine Feature

### How it works

1. **Detection** — at the start of `dispatch()`, after fetching collected fields, the dispatcher checks:
   - Does the current crew have `finalSummaryConfig.enabled === true`?
   - Is the configured `triggerField` present and truthy in collected fields?
   - Has the conversation NOT already emitted a final summary?
   If all yes → route to `_streamFinalSummary` instead of the normal flow.

2. **Generation + buffering** — `_streamFinalSummary` calls `_streamCrew` (so the thinker still runs) but **buffers all text chunks** instead of yielding them. Non-text events (model_used, debug, file_search_results) are passed through normally. The user sees the thinking step `thinkingMessage` from the config (e.g. "מסכם הצעה...") while we wait.

3. **Formatting** — once the crew stream ends, the buffered text is passed to `FinalSummaryFormatterAgent` along with:
   - `formatterPrompt` (from crew config — domain-specific extraction instructions)
   - `expectedSectionTypes` (optional hint from crew config)
   The formatter agent runs a fast cheap LLM (e.g. `gpt-4o-mini`) and returns a generic `{ sections: [...] }` object.

4. **Emission** — the dispatcher yields one `final_summary` SSE event:
   ```js
   { type: 'final_summary', data: { structured: { sections: [...] }, rawText: '...' } }
   ```

5. **Persistence** — server.js captures the structured data, stores it in the assistant message metadata, and marks the conversation `finalSummaryEmitted: true`.

6. **Rendering** — client receives the event, creates an assistant message with `finalSummary` set, and the `<Message>` component renders `<FinalSummaryCard>` instead of the markdown body.

7. **History reload** — `conversationService.ts` reads `metadata.finalSummary` from past messages and rehydrates the card.

### Generic section schema

```ts
interface FinalSummarySection {
  id: string;                // e.g. "opening", "products" — snake_case
  type: string;              // renderer type (see below)
  label: string | null;      // section heading IN THE MESSAGE'S LANGUAGE
  content: string | null;    // for headline, text_with_buttons, footer
  items: Array<unknown> | null;  // for cards, key_value_list
  buttons: FinalSummaryButton[] | null;  // for text_with_buttons
}

interface FinalSummaryButton {
  label: string;
  url: string;
  icon?: 'ios' | 'android' | 'link' | null;
}

interface FinalSummaryData {
  structured: { sections: FinalSummarySection[] };
  rawText: string;
}
```

### Standard section types (engine-defined renderers)

| Type | Required fields | Purpose |
|---|---|---|
| `headline` | `content` | Big celebratory opener — strongest visual weight |
| `cards` | `items: [{ name, benefit }]` | Grid of contained product/feature cards |
| `text_with_buttons` | `content`, `buttons: [{ label, url, icon? }]` | Prose + action buttons (e.g. app downloads) |
| `key_value_list` | `items: [{ key, value, url? }]` | Contact info, service hours, etc. |
| `footer` | `content` | Lighter, distinct closing line |

**Unknown section types** must render as a generic `<label>: <content>` block — the engine never breaks because of an unfamiliar type.

---

## Files to Touch

### Server (engine layer — domain-agnostic)

| File | Change |
|------|--------|
| `crew/base/CrewMember.js` | Add `this.finalSummaryConfig = options.finalSummaryConfig \|\| null` with full JSDoc explaining the schema |
| `crew/services/dispatcher.service.js` | Add detection block at the start of `dispatch()` (after `crew_info` yield, before `oneShot` check). Add new private method `async *_streamFinalSummary(crew, params)` that buffers `_streamCrew` text chunks, calls the formatter, yields `final_summary` event, marks `finalSummaryEmitted` in conversation metadata |
| `crew/micro-agents/FinalSummaryFormatterAgent.js` | NEW. Generic formatter — accepts `{ text, formatterPrompt, expectedSectionTypes, usageMeta }`, returns `{ sections: [...] }`. The schema instructions are baked into the agent (always returns sections array), but the **domain context** (what kind of message, what sections to look for) comes from the caller's `formatterPrompt` |
| `server.js` | Declare `let finalSummaryData = null` near `modelUsedData`. Add chunk handler for `chunk.type === 'final_summary'` — capture data, set `fullReply = chunk.data.rawText` if empty, forward via SSE. Add `finalSummary: finalSummaryData` into `messageMetadata` when saving the assistant message |

### Server (domain layer — banking-onboarder-v2)

| File | Change |
|------|--------|
| `agents/banking-onboarder-v2/crew/review-finalize.crew.js` | Add `finalSummaryConfig: { enabled: true, triggerField: 'signature_completed', thinkingMessage: 'מסכם הצעה...', expectedSectionTypes: [...], formatterPrompt: '...' }`. The `formatterPrompt` is the ONLY place that says "banking", lists the 5 banking sections in order, gives Hebrew label suggestions, and tells the formatter how to map URLs to buttons |

### Client (engine layer — domain-agnostic)

| File | Change |
|------|--------|
| `types/chat.ts` | Add `FinalSummaryButton`, `FinalSummaryCardItem`, `FinalSummaryKeyValueItem`, `FinalSummarySection`, `FinalSummaryData` types. Add `finalSummary?: FinalSummaryData` to `Message` interface. Add `\| { type: 'SET_FINAL_SUMMARY'; payload: FinalSummaryData }` to `ChatAction` |
| `services/chatService.ts` | Add `onFinalSummary?: (data: FinalSummaryData) => void` to `StreamCallbacks`. Destructure it. Handle `parsed.type === 'final_summary'` in the event loop |
| `hooks/useChat.ts` | Add `SET_FINAL_SUMMARY` reducer case — creates a new assistant message with `finalSummary` attached, `content` set to `rawText`, captures current `thinkingSteps` and `pendingDebugData`. Wire `onFinalSummary` callback in `sendMessage` — sets `hasStartedStreaming = true` and dispatches `SET_FINAL_SUMMARY` |
| `services/conversationService.ts` | Read `msg.metadata?.finalSummary` and pass through to the `Message` object so history reload restores the card |
| `components/chat/FinalSummaryCard/FinalSummaryCard.tsx` | NEW. Renders `data.structured.sections` by iterating and dispatching to a renderer per type. Uses ONLY CSS variables (`var(--primary)`, `var(--surface)`, `var(--text-primary)`, etc.) for colors. Section labels come from `section.label` — no hardcoded text. Unknown types fall back to `label + content` block. Fully RTL-friendly via `dir="rtl"` |
| `components/chat/FinalSummaryCard/FinalSummaryCard.module.css` | Card styling — gradient background, brand-color border with top accent stripe, headline section with strongest weight, products grid (responsive 1→2 columns), branded buttons, lighter footer styling. ALL colors via CSS variables |
| `components/chat/FinalSummaryCard/index.ts` | Re-export |
| `components/chat/index.ts` | Add export |
| `components/chat/Message/Message.tsx` | Import `FinalSummaryCard`. Replace markdown render block with conditional: `{message.finalSummary ? <FinalSummaryCard data={message.finalSummary} /> : <markdown>}`. UI elements row + debug panel + feedback panel still render after the card |

---

## What the dispatcher's `_streamFinalSummary` looks like (sketch)

```js
async *_streamFinalSummary(crew, params) {
  const { conversationId, agentName } = params;
  const config = crew.finalSummaryConfig || {};

  // 1. Show thinking step so the user has feedback
  yield {
    type: 'thinking_step',
    step: { stepType: 'final_summary', description: config.thinkingMessage || 'Preparing summary...', stepOrder: 0 }
  };

  // 2. Buffer the crew stream — no text chunks reach the client
  let fullText = '';
  for await (const chunk of this._streamCrew(crew, params)) {
    if (typeof chunk === 'string') { fullText += chunk; continue; }
    if (chunk?.chunk && typeof chunk.chunk === 'string') { fullText += chunk.chunk; continue; }
    yield chunk; // pass through model_used, file_search_results, etc.
  }

  if (!fullText.trim()) {
    yield { type: 'stream_error', error: 'Final summary produced no text' };
    return;
  }

  if (!config.formatterPrompt) {
    // Engine fallback — emit raw text so user still sees something
    yield { chunk: fullText };
    return;
  }

  // 3. Run the generic formatter with domain prompt
  const formatter = require('../micro-agents/FinalSummaryFormatterAgent');
  const conversation = await conversationService.getConversationByExternalId(conversationId);
  const structured = await formatter.format({
    text: fullText,
    formatterPrompt: config.formatterPrompt,
    expectedSectionTypes: config.expectedSectionTypes,
    usageMeta: { agentName, crewMember: crew.name, conversationId, userId: conversation?.userId },
  });

  if (!structured) {
    yield { chunk: fullText };  // graceful fallback
    return;
  }

  // 4. Emit the structured card event
  yield { type: 'final_summary', data: { structured, rawText: fullText } };

  // 5. Mark idempotent
  await conversationService.updateConversationMetadata(conversationId, { finalSummaryEmitted: true });
}
```

## What the formatter's system prompt looks like (engine-defined schema instructions)

The formatter ALWAYS appends the schema rules to whatever `formatterPrompt` the crew provides. Crew controls "what to extract"; engine controls "what shape to return".

Schema instructions (constant in the formatter file):
```
Return ONLY valid JSON in this exact shape:
{ "sections": [ { id, type, label, content, items, buttons } ] }

Section type rules:
- headline: { content, label: null, items: null, buttons: null }
- cards: { items: [{ name, benefit }], label, content: null, buttons: null }
- text_with_buttons: { content, buttons: [{ label, url, icon }], items: null, label }
  - URLs must be in the buttons array, NOT in content
- key_value_list: { items: [{ key, value, url? }], label, content: null, buttons: null }
- footer: { content, label: null, items: null, buttons: null }

Hard rules:
- Preserve original wording and language. Do NOT translate or summarize.
- Preserve emojis.
- Section labels must be in the same language as the message content.
- Return null (not "null") for absent fields.
- Do NOT wrap response in markdown fences.
- Section order in the array IS the render order.
```

## What the banking crew's `formatterPrompt` looks like (domain layer)

```
You are a structured-data extractor for a banking account-opening closing message in Hebrew.

The message celebrates that a customer has just finished opening their account. It contains 5 sections in this order:
1. Celebratory opening — id "opening", type "headline"
2. Account & products — each product is its own item. id "products", type "cards", label "מה פתחנו עבורך"
3. Next steps — text + iOS/Android download links. id "next_steps", type "text_with_buttons", label "הצעדים הבאים". Put download URLs in buttons (label "iOS"/"Android", icon "ios"/"android"). DO NOT leave URLs in content.
4. Service contact — phone, WhatsApp, hours, website. id "service", type "key_value_list", label "אנחנו כאן בשבילך"
5. Warm closing — id "closing", type "footer", label null

If a section is missing, omit it entirely (do not emit empty sections).
Preserve the original Hebrew wording, emojis, and tone.
```

---

## UX Flow (end to end)

1. User completes signature → extractor sets `signature_completed: true`
2. User sends next message
3. Dispatcher detects: `review-finalize` crew + `finalSummaryConfig.enabled` + `signature_completed=true` + `finalSummaryEmitted` not set → routes to `_streamFinalSummary`
4. Thinking step appears: "מסכם הצעה..." (1-3 seconds)
5. Crew stream runs (with thinker), text chunks buffered
6. Formatter agent runs on the buffered text (~1-2s)
7. `final_summary` SSE event arrives at client
8. Client creates assistant message with `finalSummary` data
9. `<Message>` renders `<FinalSummaryCard>` with branded sections
10. Conversation metadata marked `finalSummaryEmitted: true` → next turn skips this path
11. On history reload, `metadata.finalSummary` is hydrated → card re-renders identically

---

## Out of Scope

- Animations / transitions when the card appears (future polish)
- Sharing / printing the card
- Editing the card content from the agent side
- Multiple final summaries per conversation (idempotency enforced)
- Streaming the card chunk-by-chunk (the buffered approach is the design — see UX rationale below)

### Why buffer instead of stream?

The user explicitly chose buffered (non-streaming) for the final card. Reasons:
- Avoids the jarring two-state UX (markdown bubble → swap to card)
- The card is meant to feel like a designed artifact, not chat text
- The thinking step "מסכם הצעה..." gives the user feedback during the wait
- Final messages are short and the formatter is fast — total wait is ~2-4s

---

## Acceptance Criteria

### Engine genericity (must all pass)
- [ ] No occurrence of `'banking'`, `'review-finalize'`, `'lybi'`, or any agent name in `crew/`, `services/`, `types/`, `components/chat/FinalSummaryCard/`, or `components/chat/Message/Message.tsx`
- [ ] No Hebrew strings anywhere except inside `agents/banking-onboarder-v2/`
- [ ] `FinalSummaryFormatterAgent` works for any crew that provides a `formatterPrompt` — no hardcoded section names in the agent code
- [ ] `FinalSummaryCard` component reads ALL labels from `section.label` — never from a hardcoded string
- [ ] `FinalSummaryCard` colors come ONLY from CSS variables — no hex values for brand colors
- [ ] An unknown section type renders as a graceful fallback (label + content), not an error

### Banking V2 behavior (must all pass)
- [ ] Triggers exactly when `signature_completed=true` AND `finalSummaryEmitted` is not yet set
- [ ] Does NOT re-trigger on subsequent turns in the same conversation
- [ ] Thinking step "מסכם הצעה..." shown during formatting
- [ ] Card renders in current bank theme colors (works for all 5 bank themes)
- [ ] Opening section is visually prominent
- [ ] Each product is its own contained card
- [ ] App download buttons render with iOS/Android icons in brand color and open in new tab
- [ ] Service section shows only the channels actually present in the message
- [ ] Closing line is visually distinct (lighter, italic)
- [ ] Card persists on conversation reload from history
- [ ] Falls back to plain markdown rendering if formatter fails (graceful degradation)
- [ ] Full RTL Hebrew rendering, all sections readable
- [ ] Other crews (welcome, advisor) work exactly as before — no regression

### Future-proofing
- [ ] Adding a new section type to the standard renderers is one place: `FinalSummaryCard.tsx`
- [ ] Enabling final summary for a different crew/agent requires only adding `finalSummaryConfig` to that crew — zero engine changes
- [ ] The formatter prompt can be edited via the crew playground (db prompt override) without code changes
