# Builder V2 — Unified Prompt Editor (planned refactor)

**Status:** planned · not started
**Why:** every place that authors a prompt currently wires four to six
loosely-related pieces by hand (MentionTextarea, `useMentionOptions`,
`useSnippetCreator`, `SnippetsUsedFooter`, the hint line under the
textarea, the `addon:${instanceId}:prompt` storageKey). Future surfaces
— expand-snippets toggle, "Turn selection into snippet", lint chips,
preview overlays — would need the same wiring repeated in every host.
A single component fixes that.

## Goal

One drop-in component that *every* prompt-authoring surface uses:

```tsx
<PromptEditor
  value={config.prompt}
  onChange={prompt => patch({ prompt })}
  agentId={agentId}
  instanceId={instance.instanceId}      // → storageKey
  boundField={{ fieldId: linkedId }}    // optional, for field-bound plugins
  placeholder="…"
  rows={10}
/>
```

Hosts drop the four current imports. Future prompt-editor improvements
land in one file.

## What it absorbs

From today's plugin configs (Talker / Thinker / Field Interviewer /
Field Reasoner / Summarizer / Field Extractor / Persona modal / DC
screen), the wrapper takes over:

- **MentionTextarea** instantiation — value/onChange passes through;
  storageKey is derived from `instanceId`.
- **`useMentionOptions`** — internal call, forwarded `boundField`
  prop, internal `useSnippetCreator` wiring for the `+ New snippet…`
  quick-add. Hosts stop importing the hook.
- **`useSnippetCreator`** — internal call, never seen by hosts.
- **SnippetsUsedFooter** — auto-rendered below the textarea. Hosts
  stop importing it.
- **Hint line** — the `Type @ memory · # parameters · …` copy is
  generated from the active picker prefixes (so adding a new sigil
  doesn't need a copy-edit in 8 plugins).

## What it adds

Anything that needs to surface on a prompt textarea but doesn't justify
a new wiring round across 8 hosts:

- **Expand snippets toggle** — currently inside `SnippetsUsedFooter`;
  moves up into the wrapper so it sits at the textarea level.
- **Right-click → "Turn selection into snippet"** — selection
  awareness is at the textarea ref; the wrapper owns it.
- **Lint chips** — surface unresolved tokens (`{{field:missing}}`,
  `{{snippet:typo}}`) inline so the author catches them before save.
- **Per-key direction pin + height memory** — already in
  MentionTextarea today, gets a friendlier UI affordance.

## Migration

One pass through the 8 sites that today wire MentionTextarea +
useMentionOptions + SnippetsUsedFooter + useSnippetCreator by hand:

- `aspect-react-client/src/builder/plugins/talker/TalkerConfig.tsx`
- `aspect-react-client/src/builder/plugins/thinker/ThinkerConfig.tsx`
- `aspect-react-client/src/builder/plugins/fieldInterviewer/FieldInterviewerConfig.tsx`
- `aspect-react-client/src/builder/plugins/fieldReasoner/FieldReasonerConfig.tsx`
- `aspect-react-client/src/builder/plugins/summarizer/SummarizerConfig.tsx`
- `aspect-react-client/src/builder/plugins/fieldExtractor/FieldExtractorConfig.tsx`
- `aspect-react-client/src/builder/components/ChainCanvas/PersonaModal.tsx`
- `aspect-react-client/src/builder/components/DynamicContextScreen/DynamicContextScreen.tsx`
  (3 spots — umbrella, fallback, section editors)

Each becomes a single `<PromptEditor>` call. The four imports collapse
to one.

## Open questions for the refactor

1. **Naming:** `PromptEditor` vs `PromptArea` vs `PromptField`. Leaning
   `PromptEditor` — it composes (textarea + footer + toggle + lint),
   the others read as "just a wrapped textarea".
2. **Where to host the expand toggle:** keep it inside the footer (as
   today) or hoist to the textarea's top-right? Top-right is more
   discoverable for new snippets but conflicts with the eventual
   right-click affordance if both surface there.
3. **`boundField` opt-out:** plugins that don't need `{{this_field}}`
   simply omit the prop. Plugins that DO need it pass it. Same
   ergonomic as today — no regression.
4. **`storageKey` collisions for DC's three textareas:** today they
   pass distinct keys like `dc:${dcId}:umbrella`. The wrapper would
   need a `storageKeyPrefix` escape hatch so multi-textarea hosts can
   namespace.
5. **Persona modal is `agent.persona`, not `config.prompt`:** the
   wrapper's API needs to be plain `value`/`onChange`, not tied to a
   plugin config shape. (Already drafted that way above.)

## Out of scope for the wrapper (deferred)

- Inline editable snippets (typing inside an expanded snippet block
  writes back to `snippets[i].content`). Considered, but the
  contenteditable cost outweighs the marginal ergonomic win — the
  current "click to open SnippetModal" flow is fine.
- Real-time runtime preview (rendering the prompt against the live
  brain). Different surface; belongs on a separate "Prompt template"
  modal that already exists on the AddonModal footer.

## When to do it

After Snippets v1 ships and we have one more reason to repeat the
wiring (e.g. right-click "Turn into snippet" or lint chips). Doing it
now would touch the same 8 files we just touched; doing it on the
*next* feature lets the refactor absorb the new feature too — one
cascade for two features instead of two cascades.
