# KB_V2 — Stage B: the KB Retriever addon (RAG access)

> Captures the **decided design** for how Builder V2 agents use a Knowledge
> Base at runtime. Stage A (the admin KB workbench: create KBs, chunk →
> embed → index into Pinecone, test retrieval) is built. This doc is the
> spec for Stage B — bringing KB retrieval into the addon/cortex engine.
>
> Guiding principle (see memory `project_kb_playable_atoms`): **no hidden
> hardcoded retrieval — only the engine running user setup.** Every
> decision (whether to retrieve, what to ask, how fresh, how injected,
> how shown) is a knob the builder sets.
>
> **Implemented token:** the injection token is **`{{kb:NAME}}`** (the
> `{{kb-retrieve:NAME}}` form used below was the brainstorm name; the
> prompt-token grammar only allows `[a-z_]` in a prefix, so the hyphen
> wouldn't parse — `kb` is the shipped prefix).

---

## 1. The model: KB retrieval is its own addon

KB retrieval is a **first-class addon** (a chain step in the cortex), NOT a
hidden behaviour and NOT a knob welded onto the Talker. It runs in the
chain, can be gated/positioned like any addon, shows a debug card like any
addon, and writes its result to a **named slot** that prompts inject via a
token.

Rejected alternatives (and why):
- **Knob on the Talker (plugin-to-addon):** hides retrieval inside another
  addon — against the "no behind-the-scenes" principle.
- **Token-fired definition (no chain step):** clean for naive mode, but the
  LLM trigger/query steps want to be real runs with a debug card → chain
  step wins.
- **Agentic / LLM-tool retrieval:** powerful but the LLM decides when/what,
  least inspectable/deterministic. Cut.
- **In-addon routing (LLM picks which KB):** cut. If you need different
  behaviour for different KBs, **add a second Retriever addon.** One
  Retriever searches all its selected KBs uniformly.

---

## 2. Standard RAG, exposed as knobs

This is textbook adaptive RAG, surfaced as configuration:

- **Naive RAG** — embed the message, retrieve, inject. (Direct mode.)
- **Query rewriting / condense-question** — an LLM turns the conversation
  into a standalone query. (Query = LLM.)
- **Adaptive / Self-RAG** — an LLM decides whether retrieval is needed at
  all. (Trigger = LLM.)

Two **independent axes**, each Simple or LLM:

| Axis | Simple | LLM |
|---|---|---|
| **Trigger** (*when* to fire) | `Always` — every turn | `LLM` — a prompt returns fire / don't-fire |
| **Query** (*what* to ask) | `History` — last N messages (default 1) | `LLM` — a prompt rewrites the conversation into a query |

Mix freely (Always+LLM-query, LLM-trigger+History, both, neither). Both
LLM steps are **full prompts** — mention-aware (`@ # {{…}}`), with
edit/preview and rename-cascade — and **each has its own model picker**
(the trigger can be the cheapest model; the query rewrite slightly better).
Direct mode (`Always` + `History`) makes **zero** extra LLM calls.

> "hi"/"thanks": `Always` fires even on these (cheap; min-score drops the
> junk). To skip them, set Trigger = `LLM`. That's exactly what the trigger
> axis is for.

---

## 3. Output, injection, and the empty sentinel

- Writes to a **named domain**, format **text** or **structured-with-scores**.
- Injected anywhere via **`{{kb-retrieve:NAME}}`** (multiple Retrievers →
  multiple names → inject in different spots).
- **Empty handling:** when nothing was retrieved (didn't fire, or zero
  results) the token must NOT render blank — a prompt like *"answer only
  from {{kb-retrieve:terms}}"* would then look broken. It renders a
  **configurable empty-sentinel** (default: *"No relevant information was
  found in the knowledge base."*) so the model always knows there's no data.

---

## 4. Freshness: the slot lifecycle (the re-init rule)

Retrieved chunks are **ephemeral, recomputed per turn** — never persisted
as long-term memory (persisting would inject stale, wrongly-scoped context
and bloat the window). Slot lifecycle:

- **Successful retrieval** → **replaces** the slot.
- **Turn with no retrieval** (trigger said no, or zero results) → governed
  by a per-addon toggle **`On no retrieval:`**
  - **`Clear`** (default) → slot empties → token renders the sentinel.
    Safe: no stale context.
  - **`Keep last`** → slot retains the previous result until the next
    successful retrieval. Good for tight follow-up flows **with LLM-trigger**
    (the model's "don't fetch" = "current context suffices"). Staleness
    trap on topic-switch, so not the default. `Keep` makes the slot a
    bounded conversation-persisted transient (always overwritten by the
    next real retrieval).

So re-asking "what are the terms?" then "what about termination?" retrieves
**twice, fresh** — correct, because the query changed and each question
should pull its own chunks (the condense-question step makes the vague
follow-up retrieve the right chunks).

---

## 5. Debug card (chat / addon trail)

Like every other addon, the Retriever emits a run card. Collapsed summary:
**mode** (trigger/query), the **fire decision** (+ the LLM's reason if
LLM-trigger), the **final query string**, and **hits** (file · score).
**Expand** → full chunk text. Keeps retrieval inspectable without flooding
the trail with chunk text by default (size guard).

---

## 6. Final config spec (what to build)

**KB Retriever addon** — chain step. Config fields:

- **KBs**: multi-select of the agent's KBs (searches all selected).
- **Trigger**: `Always` | `LLM` (full prompt + own model).
- **Query**: `History` (last N, default 1) | `LLM` (full prompt + own model).
- **Retrieval knobs**: `topK` · `minScore` · `maxTokens` (same knobs as the
  Stage-A Test panel — what you tuned in admin is what the addon runs).
- **Output**: `name` (domain) · `format` (`text` | `structured`) ·
  **empty-sentinel text** (configurable; default above).
- **On no retrieval**: `Clear` (default) | `Keep last`.
- **Inject token**: `{{kb-retrieve:NAME}}`, recomputed per turn per §4.
- **Debug card** per §5.
- **Multiple instances** for divergent behaviour; **no routing**.

Runtime per turn: resolve Trigger → (fire?) → resolve Query → Pinecone
`query(namespaces, queryText, {topK,minScore,maxTokens})` →
`formatForPrompt()` (or structured) → write/clear slot → token injects on
downstream prompt assembly → emit debug card.

---

## 7. Build order (touch-points)

1. **`{{kb-retrieve:NAME}}` token** — add to the grammar + `promptPlaceholders.json`
   / `KNOWN_PROMPT_PLACEHOLDERS`; resolve in the **server assembler** and the
   **client preview** (byte-equal); add to the **rename cascade**.
2. **Addon descriptor + plugin (3 files + 2 registrations)** — server
   `kb-retriever.addon.json` + `addon.kb-retriever.js` (run: trigger →
   query → search → slot), client descriptor + `KbRetrieverConfig.tsx`.
3. **Runtime slot store** — per-turn write/clear/keep for the named slot
   (reuse `builderMemory` with overwrite/clear semantics, or a parallel
   ephemeral `retrieval` section).
4. **Debug card** — emit the KB run card via the existing addon SSE +
   `addonRunsStore`.
5. **KB selection in config** — list the agent's KBs (`/api/kb/*` /
   namespaces) in the multi-select.

Reuses the Stage-A Pinecone service (`services/kb.pinecone.service.js`:
`query`, `formatForPrompt`) unchanged.
