# Crew Chain Architecture

> How agents are built, how crew members work, and the chain processing model.
> Visual presentations: `/lybi/how-we-build` (architecture), `/lybi/crew-builder` (mockup)

---

## Overview

Every agent is composed of **crew members** — each handling one phase of the conversation flow. Within each crew, a user message triggers a **chain of processing steps**, each with its own prompt, model, and purpose.

---

## Agent Structure

```
Agent
├── Agent Persona          (shared voice across all crews)
├── Crew: Welcome          (default)
│   ├── Talker             (GPT-4o + prompt)
│   └── Extractor          (GPT-4o Mini + fields)
├── Crew: Advisor
│   ├── Thinker            (Claude + thinking prompt)
│   ├── Talker             (Gemini Flash + prompt)
│   ├── Extractor          (GPT-4o Mini + fields)
│   └── Profiler           (GPT-4o, async)
└── Crew: Review
    └── Talker             (Claude + prompt)
```

**Key:** Each handler (talker, thinker, extractor, profiler) has its own model and prompt. They are distinct LLM calls.

---

## Personas

### Agent Persona (Agent-level)
Shared character voice injected into all crew members. Defines the agent's personality, tone, language, and safety rules. All crews inherit it.

### Crew Persona (Crew-level) — NEW
Phase-specific voice overlay. Different tone for welcome vs. assessment vs. closing. Stacks on top of the agent persona.

**Final persona = Agent Persona + Crew Persona**

---

## Chain Processing Model

When a user sends a message, the crew triggers a chain of reactions:

```
User Message
    │
    ├──→ Extractor (parallel) ──→ writes collected fields
    │
    ├──→ Thinker (sync, waits) ──→ writes advice to context
    │         │
    │         └──→ can also extract fields
    │
    ├──→ Talker (sync, streams) ──→ speaks to user
    │         reads: thinker advice + fields + dynamic context + KB
    │
    └──→ Profiler (async, background) ──→ writes deep profile
              doesn't block the response
```

### Each chain step differs by:

| Property | Description |
|----------|-------------|
| **Prompt** | What it's told to do |
| **Model** | Which AI runs it (GPT, Claude, Gemini, etc.) |
| **History** | How many messages it sees |
| **KB** | Connected to knowledge base or not |
| **Input context** | What data it reads from shared context |
| **Output** | Where it writes results |
| **Speaks to user?** | Returns text to chat or runs silently |
| **Sync / Async** | Must wait for it or runs in background |

### Future: Generic Chain

The current structure (extractor, thinker, talker, profiler) is a specific implementation. The architecture is moving toward a **generic chain** where each step is fully configurable — any number of steps, any order, any combination of sync/async. All sharing the same context.

---

## Shared Context

All chain steps read and write to the same context store:

- **User-level**: Persists across conversations (profile, preferences, journey stage)
- **Conversation-level**: Specific to one conversation (thinker advice, assessment state, collected fields)

When crew A finishes and crew B starts, crew B reads everything crew A saved.

---

## Field Collection

Fields can be collected by **any chain step** — the extractor, the thinker, or any future chain element. The system is agnostic about the source. Once a field has a value, it's available to all downstream steps.

### Field Extractor
- Runs in parallel with the main response
- Has its own model and prompt
- Extracts structured fields from conversation
- Extracts structured fields from the conversation

### Thinker as Field Source
- The thinker can also extract/determine field values as part of its analysis
- Fields from thinker are written to context like any other source

---

## Dynamic Context Injection

When an enum field has a specific value, **the matching case text is rendered in place of a `{{dynamic:FIELD}}` token**. No KB vector search — deterministic, in code. Authored agent-level, consumed by any addon's prompt.

See [BUILDER_V2_DYNAMIC_CONTEXT.md](./BUILDER_V2_DYNAMIC_CONTEXT.md) for the full design.

### How it works

```
Field: intent  (enum: open_account | close_account | complaint | info_request)

Dynamic Context for `intent`:
  open_account → "Focus on eligibility. Ask about employment and income.
                  Don't discuss fees yet."
  complaint    → "Acknowledge frustration first. Listen fully before
                  offering solutions. Never be defensive."

Talker prompt contains:
  ...
  {{dynamic:intent}}
  ...
```

At assemble time the token is replaced with the case text for the current value of `intent`.

### Why not KB?

KB uses vector search — it guesses which document is relevant. Dynamic Context is **exact**: field has value X from a known list → render case text Y. Direct mapping. No guessing.

### Use cases

- **Intent routing**: Different instructions per customer intent
- **User type adaptation**: Adjust tone/approach per personality (stubborn, confused, kid)
- **Stage-specific guidance**: Different instructions based on journey stage
- **Any enum field**: Any field with a closed list of values can switch context

---

## Thinker / Talker Pattern

Two-model approach where analysis and speaking are separated:

### Thinker
- Stronger analytical model (e.g., Claude)
- Has its own prompt and **output schema** (JSON fields it must return)
- Runs before the talker
- Writes strategy/advice to context
- Can determine field values
- Can decide to skip the talker and transition to next crew

### Talker
- Conversational model (e.g., Gemini Flash)
- Reads the thinker's advice from context
- Generates the user-facing response
- Follows the thinker's strategy

### Thinker Output Schema — NEW
The thinker's expected output can be defined as a JSON schema with typed fields:

```json
{
  "intent": "enum: open_account | close_account | complaint",
  "user_type": "enum: cooperative | stubborn | confused | kid",
  "nextQuestion": "string: The next question to ask",
  "readyToTransfer": "boolean: Should we transition?"
}
```

---

## Transitions

### Field-based
When all required fields are collected → automatic transition to next crew. Happens before the response is sent.

### Thinker-based
The thinker returns a flag (e.g., `readyToTransfer: true`) → skip talker, transition immediately.

---

## Visual Presentations

- **`/lybi/how-we-build`** — Slide deck explaining the full architecture
- **`/lybi/crew-builder`** — Interactive mockup of the crew editor UI
- **`/lybi/llm-guide`** — How AI models work (for non-technical users)
