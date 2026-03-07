# Task: Crew Editor V2 — Unified Upgrade

This is the coordinating task for the crew editor upgrade. It covers three areas that must be implemented together:

1. **Two-phase chat** (discuss → generate) — see `task-crew-editor-two-phase-chat.md`
2. **Thinker+talker awareness** — see `task-crew-editor-thinker-awareness.md`
3. **Prompt viewer, change categories, and escalation UX** — defined below

All three must work together. This file defines the additions not covered by the other two tasks, and specifies how everything connects.

---

## Who Uses This Tool

The crew editor is for **non-technical domain experts** — product people who test agents, refine conversations, and iterate on behavior. They are NOT developers. They shouldn't need to read code to understand what the agent does.

The developer (you) focuses on features and infrastructure. The crew editor lets domain experts own the agent behavior independently.

This principle drives every design decision below.

---

## Part 1: Prompt Viewer (UI)

### Problem

The code panel shows the full `.crew.js` source file. Domain experts don't need to see imports, class definitions, or `buildContext()` code. They care about:
- **Guidance** — what the agent is told to do and how to talk
- **Thinking prompt** — what the thinker analyzes and decides (thinker crews only)

### Solution: Prompt View Tab

Add a third tab to the code panel header, alongside "Current" and "Proposed":

**"Prompts"** — shows extracted prompts in a clean, readable format (no code syntax, no line numbers).

The Prompts tab is always visible (not just when proposed changes exist like Current/Proposed). It's the default view when a crew is first loaded — domain experts land here, not on raw code.

#### Prompts tab layout

```
┌─────────────────────────────────────────────┐
│  Prompts    Current    [Proposed]            │
├─────────────────────────────────────────────┤
│                                             │
│  GUIDANCE                                   │
│  ─────────                                  │
│  You are a friendly banking advisor...      │
│  Ask one question at a time...              │
│  (full guidance text, plain readable)       │
│                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                             │
│  THINKING PROMPT          (thinker only)    │
│  ───────────────                            │
│  You are the strategic brain...             │
│  Return JSON: { ... }                       │
│  ## HOW TO THINK                            │
│  1. Read the conversation...                │
│  (full thinking prompt text)                │
│                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                             │
│  FIELDS                                     │
│  ──────                                     │
│  • name — Customer's full name              │
│  • phone — Phone number with country code   │
│  • age — Customer's age (number)            │
│  (field name + description list)            │
│                                             │
│  Transitions to: review-finalize            │
│                                             │
└─────────────────────────────────────────────┘
```

For non-thinker crews, the "THINKING PROMPT" section is simply not shown.

#### Data source

Use `_extractCrewSummary()` (defined in the two-phase chat task). The same extraction runs on the client side for the prompts tab — call a new endpoint or extract client-side from the already-loaded source string.

**Recommended approach:** Client-side extraction. The source is already loaded in state. Write a `extractCrewSummary(source: string)` utility in TypeScript that mirrors the server's regex extraction. This avoids an extra API call and keeps the prompts tab instant.

#### Tab behavior

- **Prompts** tab — default when a crew is loaded. Shows extracted prompts in readable format. Read-only (editing happens through chat).
- **Current** tab — full source code with syntax highlighting (existing behavior).
- **Proposed** tab — only visible when Claude generates changes (existing behavior). Shows the proposed full source.

When Claude generates changes and proposed source appears:
- The Proposed tab becomes visible and auto-selects (existing behavior)
- The Prompts tab stays available — user can switch to compare prompts visually

---

## Part 2: Change Categories

### The 5 categories

Every fix the crew editor makes falls into one of these:

| Label | Category | What it means |
|-------|----------|---------------|
| **A** | Guidance change | Changed the talker's prompt — tone, phrasing, behavior rules |
| **B** | Thinking prompt change | Changed the thinker's prompt — strategy, JSON schema, decision rules (thinker crews only) |
| **C** | Field change | Added, removed, or modified field definitions or descriptions |
| **D** | Code change | Modified transition logic, field sequencing, context builder, or other code |
| **E** | Escalation | Cannot fix from here — requires infrastructure, another crew, new tools, etc. |

### Discuss mode: Claude uses categories to explain

During discussion, Claude should reference these categories naturally:

> "This sounds like a **guidance change** (A) — I'd rewrite the tone instructions to be more casual."

> "This would need a **thinking prompt change** (B) — the strategy rules about when to recommend need adjusting."

> "I can't fix this from here — this needs an **infrastructure change** (E). Let me help you write a bug report."

Claude doesn't need to be rigid about it — just clear about WHAT it's planning to change and WHY, using the category labels.

### Generate mode: Claude labels what it changed

When Claude outputs the updated file, it must include a change summary using category labels:

```
Here's the updated version:

**Changes made:**
- **(A) Guidance** — Rewrote the opening to be warmer and ask one question at a time
- **(C) Fields** — Added "preferredLanguage" field with description

```javascript
// ... full updated file
```​
```

This makes it immediately clear to the domain expert what was touched, without reading code.

### Escalation (E) — bug report generation

When Claude identifies that it can't fix something (category E), it should:

1. Explain in simple terms why this can't be fixed from the crew editor
2. Generate a ready-to-use bug report:

```
I can't fix this from here — this requires a change to [the dispatcher / the field extraction engine / etc.].

**Bug Report:**

**Title:** [clear, specific title]

**Description:**
[What the user wants to achieve]
[Why it can't be done from the crew editor]
[What infrastructure change is needed]

**Reported from:** Crew Editor — [agent name] / [crew name]
```

The user can copy this and send it to the developer.

---

## Part 3: System Prompt Updates

### Discuss prompt additions

The discuss prompt (from the two-phase chat task) needs these additions:

```
===== CHANGE CATEGORIES =====

Every change falls into one of these categories. Use the labels when discussing and explaining:

(A) GUIDANCE — change the talker prompt (tone, phrasing, behavior)
(B) THINKING PROMPT — change the thinker prompt (strategy, schema, decisions) [thinker crews only]
(C) FIELDS — add, remove, or improve field definitions
(D) CODE — modify transition logic, context builder, or other code
(E) ESCALATION — you cannot fix this, help write a bug report

When discussing, tell the user which category the fix falls into.
When you identify (E), don't attempt a fix — explain why and offer to write a bug report with a title and description.
```

### Generate prompt additions

The generate prompt (full system prompt) needs these in the OUTPUT RULES section:

```
- After the code block, include a "Changes made:" summary listing each change with its category label:
  (A) Guidance — what you changed
  (B) Thinking prompt — what you changed [if applicable]
  (C) Fields — what you changed [if applicable]
  (D) Code — what you changed [if applicable]
- If the change spans multiple categories, list each one
- If this is an escalation (E), do NOT output code — output the bug report instead
```

### Updated fix priority order

Replace the current 4-level priority with the 5 categories, reframed for clarity:

```
===== HOW TO FIX PROBLEMS =====

When the user reports a problem, fix it using the FIRST approach that works.

**(A) Change the GUIDANCE** — try this first, always
- Rewrite or adjust the guidance text
- Most problems (tone, phrasing, flow, wrong language, too many questions) are solved here
- The guidance must be flat — no if/else, no conditional sections, no dynamic placeholders

**(B) Change the THINKING PROMPT** — for thinker crews, when the problem is about WHAT the agent decides
- Strategy rules, JSON schema fields, decision timing, transition conditions
- If this is a thinker crew and the problem is about what the agent does (not how it sounds), this is your target

**(C) Add or improve FIELDS**
- If a field isn't being extracted correctly, improve the description
- Add new fields if the agent needs to collect new information
- Use type:'boolean' for yes/no, allowedValues for fixed options

**(D) Modify CODE** — only if A/B/C can't solve it
- Transition conditions (preMessageTransfer / postThinkingTransfer)
- Field sequencing (getFieldsForExtraction)
- Context builder (buildContext)
- Keep code minimal. Avoid adding complexity.

**(E) ESCALATE** — you cannot fix this
If the fix requires changes to infrastructure, the dispatcher, the base class, tools, database, streaming, UI, or a different crew member:
1. Explain to the user in simple terms why this can't be fixed from here
2. Generate a bug report with a clear title and description
```

---

## Part 4: Cross-Task Integration

### How everything connects

```
User opens crew editor
  → Crew source loads
  → Prompts tab shown by default (Part 1)
  → Source indicator badge shows "Project File" or "GCS Override" (already implemented)

User sends a chat message
  → Discuss mode (two-phase chat task)
  → Lightweight prompt includes extracted guidance + thinking prompt + categories
  → Claude discusses using category labels (A/B/C/D/E)
  → Claude identifies thinker crews automatically (thinker awareness task)

User clicks "Generate Changes"
  → Generate mode (two-phase chat task)
  → Full prompt with building guide + thinker section + output rules
  → Claude outputs complete file + change summary with category labels
  → Proposed tab appears, user reviews

User clicks "Apply Changes"
  → Apply prompt dialog asks for version name (already implemented)
  → Source applied, backed up, set as default (already implemented)
  → Prompts tab updates to reflect new source
```

### Implementation order

1. **Server first:** `_extractCrewSummary()`, discuss/generate prompts with categories and thinker awareness
2. **Client service:** `mode` parameter for chat, client-side `extractCrewSummary()` utility
3. **Client UI:** Prompts tab, Generate button, category labels in chat messages

---

## Files to Modify

| File | Change |
|------|--------|
| `aspect-agent-server/services/crew-editor.service.js` | `_extractCrewSummary()`, `_buildDiscussPrompt()`, rename `_buildSystemPrompt` → `_buildGeneratePrompt`, add thinker section, add categories, update fix priority, update output rules, `mode` param in `chatWithClaude()` |
| `aspect-agent-server/server.js` | Pass `mode` from request body |
| `aspect-react-client/src/services/crewEditorService.ts` | Add `mode` parameter to `chatWithClaude` |
| `aspect-react-client/src/utils/extractCrewSummary.ts` | **NEW** — client-side crew summary extraction (guidance, fields, transition, isThinker, thinkingPrompt) |
| `aspect-react-client/src/components/dashboard/CrewEditorAI/CrewEditorAI.tsx` | Prompts tab (default view), Generate button, discuss/generate mode switching |
| `aspect-react-client/src/components/dashboard/CrewEditorAI/CrewEditorAI.module.css` | Prompts tab styles, Generate button styles |

---

## Verification

### Prompts tab
1. Load a standard crew → Prompts tab is default, shows Guidance + Fields sections
2. Load a thinker crew → Prompts tab shows Guidance + Thinking Prompt + Fields
3. Switch to Current tab → full source with syntax highlighting
4. Generate changes → Proposed tab appears, Prompts tab still available

### Two-phase chat
5. Send a message → discuss mode, fast response, no code
6. Click Generate → full file output with change summary and category labels
7. Check server logs → discuss calls don't load AGENT_BUILDING_GUIDE

### Thinker awareness
8. Load thinker crew, say "recommends too early" → Claude discusses (B) thinking prompt change
9. Say "tone is too formal" → Claude discusses (A) guidance change
10. Generate → output labels both (A) and (B) in change summary

### Change categories
11. Say "add a field for customer's birthday" → Claude discusses (C) field change
12. Say "change when the agent transitions" → Claude discusses (D) code change
13. Say "the chat bubbles look wrong" → Claude identifies (E) escalation, generates bug report with title + description

### Anti-whack-a-mole
14. Say "the agent asked about income on the first message" → Claude does NOT suggest adding "don't ask income first" — discusses fixing strategy rules
