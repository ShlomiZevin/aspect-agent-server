# Alfred Update Protocol — teach Alfred your new feature

> **Who this is for:** any Claude session (or human) that just shipped a
> Builder V2 feature. Alfred — the in-builder AI helper — must learn
> every feature, or he gives wrong advice and generates broken JSON.
> **Follow this after the feature is approved, in the same session.**
>
> **Why this exists:** every gap in this checklist is a real production
> incident that happened because a feature shipped without updating
> Alfred (see the incident gallery at the bottom). Don't add to it.

---

## 1. Alfred in one minute — the three brains

| Brain | File | Sees | Produces |
|---|---|---|---|
| **Brainstorm** | `alfred/services/alfredContext.js` (system prompt) + `alfredRunner.js` (tools) | The current agent as raw JSON (draft overlay), addon catalogue, token vocabulary, read-only tools (other agents, conversations+runs, change log, addon source) | Advice in chat |
| **Consolidator** (Apply step 1) | `alfred/services/applyConsolidator.js` | The chat transcript (after the last ✅ Applied marker) + the same agent JSON | A plan: targets `{entity, entityId, what_to_do}` |
| **Patch generator** (Apply step 2) | `alfred/services/patchGenerator.js` | The full `builder/types/index.ts` VERBATIM, addon descriptors, placeholder JSON, the current body | Changed sections / items (`submit_changes`), merged server-side |

After generation: `alfred/services/bodyValidator.js` validates the
merged body → client puts it in the working copy → user Saves.

**Golden rule:** all Alfred surfaces work on **what the user sees**
(the client ships working copies with every request). Apply only ever
writes the **current** agent. Cross-agent tools are read-only, forever.

---

## 2. The auto-synced tier — put your data HERE and Alfred learns it for free

These files flow into Alfred's prompts at server startup. If your
feature's knowledge lives in them, most of your work is done:

| You added… | Put it in… | Reaches |
|---|---|---|
| A new type / key / config shape | `builder/types/index.ts` (server copy is canonical; client mirrors via `aspect-react-client/scripts/sync-builder-types.cjs --check`) | Patch generator (embedded verbatim — **your doc-comments ARE its knowledge**, write them rich: invariants, defaults, examples) |
| A new addon/plugin | `builder/addons/<name>.addon.json` (descriptor with `purpose`, defaults) | Brainstorm catalogue + generator fresh-instance templates + validator known-plugins list — all three, automatically |
| A new `{{token}}` | `builder/promptPlaceholders.json` (+ its `trigger_prefixes` map) | Both brains + the client mention picker |

**⚠ Restart the server after ANY of these** — everything loads at
module init.

---

## 3. The hand-maintained tier — THE CHECKLIST

Go through every row. Most features touch 2–4 of them.

### 3.1 You added a new top-level section to AgentBody / CrewBody
(e.g. how `liveBrain`, `profiler` were added)

- [ ] `patchGenerator.js` → add to `AGENT_SECTION_KEYS` / `CREW_SECTION_KEYS`.
      **Missing = Alfred literally cannot change it** (merge silently ignores it).
- [ ] If it's an id'd array → also `AGENT_ITEM_SECTIONS` / `CREW_ITEM_SECTIONS`
      (maps section → id property) so item paths (`section/itemId`) work
      and big arrays don't get re-emitted wholesale.
- [ ] **Client** `aspect-react-client/src/builder/state/BuilderContext.tsx`
      → `applyAlfredBodies` merge whitelist. **Missing = Alfred's applied
      change VANISHES between "generated OK" and the working copy.**
- [ ] Client `bodyOfAgent` (same file) → snapshot the key on Save
      (use the empty==absent pattern so old agents don't read dirty).
- [ ] `bodyValidator.js` → light shape checks (see `checkProfiler` as
      the template: required keys, enum values, per-item checks).

### 3.2 You added a new capability / concept / behavior
(e.g. parallel steps, choice fields, field auto-harvest, Live Brain)

- [ ] **Brainstorm** — add a self-contained `# Section` to
      `STATIC_SYSTEM_PROMPT` in `alfredContext.js`: what it is, when to
      suggest it, decision rules, hard don'ts. Write for advising a
      non-technical user. If two features are easily confused, state
      the decision rule as a question (see "Choice vs Targeted KB").
- [ ] **Patch generator** — add a rules block to its `SYSTEM_PROMPT`:
      the exact generation recipe (shapes, id formats, required
      companion pieces) + explicit NEVERs. The types file covers the
      *shape*; your block covers the *behavior* (what to emit when,
      what never to emit).
- [ ] **Consolidator** — ONLY if the feature changes how a request
      decomposes into targets (e.g. "the enum lives on the agent, the
      field on the crew → two targets, agent first") or is something
      Apply cannot do (it must EXCLUDE those and explain, e.g. crew
      creation). Most features don't need this.

### 3.3 You extended an EXISTING enum/union
(history modes, field sources, renders, lanes, output types, trigger kinds…)

- [ ] `bodyValidator.js` → the matching `VALID_*` set. **Missing = Apply
      422s on VALID bodies — including addons the patch never touched.**
- [ ] Prompts (3.2) only if the new value changes what Alfred should advise.

### 3.4 You changed runtime behavior that affects authoring advice
(e.g. "any JSON key matching a field name auto-writes the field")

- [ ] Brainstorm section (what it means for design + debugging).
- [ ] Generator rule (how to exploit / avoid it when writing prompts).

### 3.5 You added/renamed API surfaces Alfred's tools read
(conversations, runs, change log, agents list)

- [ ] Check `alfred/services/alfredTools.js` still reads the right
      tables/columns; extend a tool or add one in `alfredRunner.js`
      (definition in `TOOLS`, handler in `runTool`).
- [ ] New tool? Add its label to `TOOL_LABELS` in
      `aspect-react-client/src/builder/components/ChatPanel/BuilderChat.tsx`
      (otherwise the chat shows a raw tool name while it runs).

### 3.6 Things you must NOT do

- Don't create a `.addon.json` descriptor for **internal** plugins the
  user never adds from the picker (e.g. `live-brain-panel`,
  `profiler-panel`) — instead teach the prompts the surface's own
  config (3.2) and state "never emit this pluginId".
- Don't update `docs/guides/BUILDER_V2_SCHEMA.md` — it's superseded;
  the canonical schema is `builder/types/index.ts`.
- Don't contradict the standing hard rules already in the prompts:
  read-only cross-agent tools · Apply writes only the current agent ·
  Apply cannot create/delete crews · `promptTemplate` is always
  `"{{prompt}}"` · panels are never chain addons · Choice = minimal
  owned enum, Targeted KB only for per-value dynamic context ·
  item paths preferred for big sections.

---

## 4. Grounding rule — read the code, not the plan

Before writing any prompt text: **read the implemented code** (types,
the runtime module, the UI that authors it). Plans and design docs
drift; Alfred taught from a stale doc confidently does the wrong thing.
If the user says "make sure you're aligned", they mean this.

---

## 5. Verify before you're done

1. `node --check` every edited server file; client `npx tsc --noEmit`
   if you touched the client.
2. `node -e "const c=require('./alfred/services/alfredContext'); console.log(c.SYSTEM_PROMPT.includes('<your section title>'))"` → `true`.
3. Unit-poke the validator with a realistic valid body (must pass) and
   a broken one (must fail with precise errors) — see the test snippets
   pattern: `node -e "require('./alfred/services/bodyValidator')…"`.
4. If you touched the merge: unit-poke `mergeChanges` (exported from
   `patchGenerator.js`).
5. **Restart the server**, then live-test in Builder Chat:
   - Ask brainstorm "what is <feature>?" → correct explanation.
   - Ask him to create/edit one → ✨ Apply → the draft is shaped right
     and lands in the right place (check the server log line
     `[patch] … changed sections: …`).
6. Check `llm_usage` output tokens for the apply are sane (hundreds to
   a few thousand — a value pinned at a round cap means truncation).

---

## 6. Report

Update the fleet unit **alfred-sync** (see `c:/workspace/fleet/FLEET_PROTOCOL.md`)
with a note describing what Alfred learned — that unit's history is the
canonical log of Alfred's knowledge state. If you can't write to it,
say so in your own unit's notes.

---

## 7. Incident gallery — why each checkbox exists

| Incident | Root cause | The checkbox that prevents it |
|---|---|---|
| Alfred's Live Brain apply "worked" but vanished | `applyAlfredBodies` client whitelist missing `liveBrain` | 3.1 client merge |
| Agent tag edits never persisted | `bodyOfAgent` missing `tags` | 3.1 snapshot |
| Apply 422 on untouched addons | validator's history-mode set frozen at `none/last_n/full` | 3.3 |
| Choice field created as dangling `enumType` | consolidator never taught the two-target decomposition; validator didn't resolve enum ids | 3.2 consolidator + 3.1 validator |
| Simple lists built as full Targeted KBs | no decision rule between two features sharing one data structure | 3.2 decision-rule-as-question |
| "Malformed JSON" 500s on big plans | consolidator output cap + no truncation detection | 5.6 (watch for cap-pinned usage) |
| 16K truncation creating 13 fields | wholesale section re-emission of a giant enum bible | 3.1 item sections |
| Alfred said "I can't apply changes" long after Apply shipped | stale hand-written prompt | 3.2 brainstorm |

---

## 8. File map (quick reference)

```
aspect-agent-server/
  alfred/services/alfredContext.js    brainstorm system prompt + agent-JSON context (+ draft overlay)
  alfred/services/alfredRunner.js     brainstorm tool loop (TOOLS + runTool)
  alfred/services/alfredTools.js      tool implementations (read-only lenses)
  alfred/services/applyConsolidator.js  Apply step 1 — the plan
  alfred/services/patchGenerator.js   Apply step 2 — sections/items + merge (SECTION_KEYS, ITEM_SECTIONS, mergeChanges)
  alfred/services/bodyValidator.js    invariants on the merged body (VALID_* sets)
  alfred/routes/alfredRoute.js        HTTP surface: chats, apply, markers, log
  builder/types/index.ts              CANONICAL schema — embedded verbatim in the generator
  builder/addons/*.addon.json         addon descriptors — catalogue + templates + validator
  builder/promptPlaceholders.json     token vocabulary — both brains + mention picker

aspect-react-client/src/builder/
  state/BuilderContext.tsx            applyAlfredBodies whitelist · bodyOfAgent/bodyOf · workingBodiesOf
  components/ChatPanel/BuilderChat.tsx  chat UI · TOOL_LABELS · apply markers · save-first warning
  components/ApplyModal/ApplyPreviewModal.tsx  preview → generate flow
```
