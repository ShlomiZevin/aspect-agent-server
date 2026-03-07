# Task: Crew Editor — Thinker+Talker Awareness

> **Part of:** `task-crew-editor-v2.md` (coordinating task). Implement together with `task-crew-editor-two-phase-chat.md`.

## Problem

The crew editor's Claude assistant doesn't know about thinker+talker crews. When a user loads a thinking crew member and says "the agent isn't asking the right questions" or "change what it recommends", Claude only knows how to edit the guidance (talker prompt). But in a thinker crew, the **thinking prompt** is where "what to say" lives — the guidance just controls "how to say it."

Without this awareness, Claude will try to fix strategy problems in the guidance, which won't work — the talker follows `thinkingAdvice`, it doesn't decide what to do on its own.

## How Thinker+Talker Crews Work

Two LLMs per message:
- **Thinker** (Claude) — analyzes the conversation, returns structured JSON advice
- **Talker** (GPT-5) — speaks to the user based on that advice

The split:
| What | Where | Prompt |
|------|-------|--------|
| What to say, what to ask, strategy, decisions | Thinker | `thinkingPrompt` (constant at top of file) |
| How to say it, tone, personality, phrasing | Talker | `guidance` (inside the class) |

A thinker crew file has these markers:
- `this.usesThinker = true` in the constructor
- `this.thinkingPrompt = THINKING_PROMPT` in the constructor
- A `THINKING_PROMPT` constant at the top of the file with a JSON schema
- `fieldsToCollect: []` (thinker replaces field extraction)
- `buildContext()` calls `thinkingAdvisor.think()`

## What the Crew Editor Needs to Know

### 1. Detect thinker crews automatically

When the loaded source contains `usesThinker = true`, Claude should recognize this is a thinker+talker crew and adjust its editing strategy.

### 2. Route the fix to the right prompt

| User says | Edit target |
|-----------|------------|
| "It asks the wrong questions" | Thinking prompt — `nextQuestion` logic or strategy rules |
| "It recommends too early" | Thinking prompt — strategy rules (when to recommend) |
| "The tone is too formal" | Guidance — talker personality and tone |
| "It talks too much" | Guidance — brevity instructions |
| "It doesn't pick up on signals" | Thinking prompt — `signals` field description or strategy |
| "It should collect X information" | Thinking prompt — add field to JSON schema |
| "It should transition when X" | Thinking prompt — `readyToTransfer` conditions + `postThinkingTransfer` |

**Rule of thumb:** If it's about *what* the agent does → thinking prompt. If it's about *how* it sounds → guidance.

### 3. Thinking prompt JSON schema structure

The thinking prompt defines a JSON schema that the thinker returns. When editing, Claude should:

- Keep the schema structure clean — group fields logically with comments
- Ensure the talker guidance references `thinkingAdvice` fields that actually exist in the schema
- When adding new behavior, add the field to the JSON schema AND add a strategy rule explaining when/how to use it

### 4. Always include `_thinkingDescription`

Every thinking prompt JSON schema **must** have a `_thinkingDescription` field. This is displayed in the UI thinking indicator as a live summary of what the thinker decided.

```json
{
  "_thinkingDescription": "short summary — e.g. 'Profiling: asking about employment' or 'Ready to recommend Plan A'",
  ...other fields
}
```

Guidelines:
- Short (5-15 words)
- Describes the **decision**, not the data — "Asking about budget" not "budget is null"
- Present tense — "Recommending Plus plan" not "Recommended Plus plan"
- Specific to this turn

If the user asks to add new fields or change the schema, remind them to keep `_thinkingDescription` in the schema and update the example description to reflect the new behavior.

### 5. The JSON schema IS the state machine

The thinker's JSON response is what drives the conversation forward. The schema defines:
- **Profile fields** — what information to collect (the thinker decides when to ask)
- **Strategy fields** — `nextQuestion`, `strategy`, `toneNotes` (the thinker decides what's next)
- **State fields** — booleans and flags tracking progress (the thinker updates these)
- **Transition fields** — `readyToTransfer` (the thinker decides when the crew is done)

When the user wants to change conversation flow, the fix is usually in the strategy rules section of the thinking prompt — not in code.

## Prompt Fixing Principle (Reinforcement)

When a user reports "the agent did X and that's not okay", Claude should **not** add a rule saying "don't do X." Instead:

1. **Find the root cause** — What in the thinking prompt or guidance is causing this behavior? Is the strategy incomplete? Is a field missing? Is a rule ambiguous?
2. **Fix the definition** — Rewrite the rule that led to the wrong behavior. Make it clear what the right behavior IS.
3. **Never add negative examples** — "Don't ask about income on the first message" is a whack-a-mole patch. "Ask at least 2 rapport questions before profiling" is a proper fix.

This applies to both the thinking prompt and the guidance.

## Relationship with Two-Phase Chat Task

This task defines WHAT Claude needs to know about thinker crews. The two-phase chat task (`task-crew-editor-two-phase-chat.md`) defines WHEN Claude gets this context:

- **Discuss mode**: `_buildDiscussPrompt` extracts the thinking prompt text and includes it in the lightweight discuss prompt. Claude can discuss strategy vs tone changes without the full source.
- **Generate mode**: `_buildGeneratePrompt` (full system prompt) includes the thinker section below. Claude sees the complete source and generates the updated file.

Both prompts need the thinker awareness section. The discuss prompt gets it via extracted text; the generate prompt gets it as a static section.

## Implementation

### Modify `_buildSystemPrompt()` in `crew-editor.service.js`

Add a new section to the system prompt, between "WHAT YOU'RE EDITING" and "HOW TO FIX PROBLEMS":

```
===== THINKER+TALKER CREWS =====

Some crews use a thinker+talker pattern: a thinker LLM (Claude) analyzes the conversation and returns structured JSON advice, then a talker LLM (GPT-5) speaks based on that advice.

You can tell this is a thinker crew if the source has:
- `this.usesThinker = true`
- A `THINKING_PROMPT` constant with a JSON schema
- `thinkingAdvisor.think()` call in `buildContext()`

**Two prompts, two purposes:**
- **Thinking prompt** (THINKING_PROMPT constant) — controls WHAT the agent does: what questions to ask, what strategy to follow, when to recommend, when to transition. Returns structured JSON.
- **Guidance** (inside the class) — controls HOW the agent talks: tone, personality, phrasing. The talker receives `thinkingAdvice` in context and follows it.

When the user reports a problem:
- "Wrong questions / wrong strategy / wrong timing" → edit the THINKING_PROMPT (strategy rules or JSON schema)
- "Wrong tone / too formal / talks too much" → edit the guidance

**JSON schema rules:**
- Always keep the `_thinkingDescription` field — it shows in the UI thinking indicator
- Group fields logically with comments
- When adding fields, also add strategy rules explaining when/how to populate them
- The schema IS the state machine — profile fields, strategy, state flags, and transition triggers

When editing the thinking prompt:
- Explain to the user which prompt you're changing and why ("I'm updating the thinking prompt because this is about what the agent decides, not how it talks")
- If both prompts need changes, do both and explain each
```

### Reinforce the anti-whack-a-mole principle

The existing principle #3 already covers this. No code change needed — just verify the wording is strong enough. Current wording is good:

> "When fixing a problem, never just add 'don't do [the thing that went wrong]'. Instead, find what in the prompt is CAUSING the wrong behavior and fix that."

### Auto-detect in prompt

The detection is automatic — Claude sees the full source code and can identify `usesThinker = true`. The system prompt section above tells Claude what to do when it sees this pattern.

## Files to Modify

| File | Change |
|------|--------|
| `aspect-agent-server/services/crew-editor.service.js` | Add thinker awareness section to `_buildSystemPrompt()` |

## Verification

1. Load a thinker crew (e.g., banking-onboarder-v2 main-conversation)
2. Say "the agent recommends too early" → Claude should edit the THINKING_PROMPT strategy rules, not the guidance
3. Say "the tone is too stiff" → Claude should edit the guidance, not the thinking prompt
4. Say "add a field to track whether the customer has kids" → Claude should add it to the thinking prompt JSON schema with `_thinkingDescription` still present
5. Say "the agent asked about income on the first message, that's wrong" → Claude should NOT add "don't ask about income first" — instead should fix the strategy rules about when to ask profiling questions
6. Load a non-thinker crew → Claude should work as before, no thinker references
