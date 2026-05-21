# Builder V2 — Authoring Addons

This guide shows how to add a new addon (plugin) to the V2 builder.

Every addon lives in two halves that must agree on a few contracts:

| Half | Where | What it owns |
|------|-------|--------------|
| **Client descriptor** | `aspect-react-client/src/builder/plugins/<id>/` | Default config, default prompt template, default context (history / persona / memory), default output type, config UI component, what shows in pickers. |
| **Server descriptor** | `aspect-agent-server/builder/plugins/<id>/addon.<id>.js` | The LLM call shape (streaming vs one-shot), output parsing, memory-write extraction. |

The engine in [`BuilderRunner.js`](../../builder/runtime/BuilderRunner.js) is plugin-agnostic. It looks up the plugin in the registry and delegates the LLM-shape concerns to it.

---

## The server plugin contract

A server plugin is a descriptor registered at module-load time:

```js
const { registerPlugin } = require('../../runtime/pluginRegistry');

registerPlugin({
  id: 'my-addon',
  allowedOutputTypes: ['json-to-memory'],   // engine validates per instance
  async run(ctx) {
    // ... return { rawOutput, parsedOutput?, memoryWrites[], assistantText?, durationMs, tokens, parseError? }
  },
});
```

### What `ctx` gives you

| Field | Type | Purpose |
|------|------|---------|
| `instance` | `AddonInstance` | The saved addon JSON from the crew body — `pluginId`, `config`, `context`, `outputType`, `promptTemplate`. |
| `prompt` | `string` | Already assembled by the engine. Substitutions for `{{prompt}}` / `{{persona}}` / `{{memory}}` / `{{fields_schema}}` / `{{fields_current}}` are done. |
| `modelString` | `string` | Flattened `modelId` (e.g. `'gpt-4o-mini'`). Pass straight to `llm.sendOneShot` / `sendMessageStreamWithPrompt`. |
| `userMessage` | `string` | The current turn's user text. |
| `historyMessages` | `Array<{role, content}>` | Pre-fetched history per the instance's `context.history` config. Empty when `history.mode === 'none'`. |
| `memory` | `object` | The live memory blob for this conversation. **Mutate via the engine's `memoryWrites` return**, never directly. |
| `conversationId` | `number` | DB conversation id. |
| `agentSlug` | `string` | URL slug (e.g. `'banking-v2'`). |
| `agentNameForLogs` | `string` | Display name for `llm_usage.agent_name`. |
| `ownerUserId` | `string` | External user id (the "dummy user"). |
| `userId` | `number` | Internal DB user id. |
| `emit(event, payload)` | function | Send an SSE event. Use for streaming addons (`addon.token`). |
| `llm` | service | The shared `services/llm.js`. Call its methods to talk to providers. |
| `logUsage(row)` | function | Insert an `llm_usage` row. **You only need this for streaming**: one-shot calls log automatically inside `llm.sendOneShot`. |
| `usageProcess` | `string` | The pluginId. Use as `context` for `llm.*` calls so the row appears under your addon in the dashboard. |
| `usageCrew` | `string` | Crew name (for the CREW column in the usage dashboard). |

### What your `run()` must return

```js
{
  rawOutput:     string,               // exactly what the LLM said
  parsedOutput:  any,                  // (optional) post-parse structure
  memoryWrites:  [                     // (optional) writes the engine will merge + persist
    { domain: string|null, field: string, value: any },
    ...
  ],
  assistantText: string,               // (optional) text appended to the assistant message
  parseError:    string,               // (optional) include if parsing failed
  durationMs:    number,
  tokens:        { input: number, output: number, total: number },
}
```

The engine then:
1. Merges `memoryWrites` into the conversation memory blob, persists it via `builderMemory.saveMemory`.
2. Emits an `addon.output` SSE event whose payload mirrors what you returned.
3. Persists one `addon_runs` row whose `run_data` is the same payload (so the historical view rehydrates identical cards).

### What you don't need to worry about

| Concern | Where it's handled |
|---------|-------------------|
| Loading the conversation memory | Engine (`builderMemory.loadMemory`). |
| Fetching history | Engine (`historyService.loadHistory`). |
| Assembling the prompt | Engine (`promptAssembler.assemblePrompt`). |
| Persisting memory writes | Engine, after `run()` returns. |
| Persisting `addon_runs` | Engine, after `run()` returns. |
| `llm_usage` for one-shot calls | `llm.sendOneShot` does it for you. |

---

## The client plugin contract

Mirrors the server descriptor plus UI affordances. Lives in `aspect-react-client/src/builder/plugins/<id>/addon.<id>.ts`:

```ts
import type { PluginDescriptor } from '../../registry/plugins';
import { registerPlugin } from '../../registry/plugins';
import { DEFAULT_FAST_MODEL } from '../../registry/providerModels';
import type { MyAddonConfig } from '../../types';
import { MyAddonConfigComponent } from './MyAddonConfig';

const PROMPT_TEMPLATE = `{{prompt}}

{{memory}}`;

export const myAddonPlugin: PluginDescriptor<MyAddonConfig> = {
  id: 'my-addon',
  name: 'My Addon',
  description: 'Short tagline for the picker.',
  icon: '🛠️',
  color: '#0ea5e9',
  defaultLane: 'main',
  fieldMode: 'none',                 // or 'extractor'
  speaks: false,                     // true only for Talker-like addons
  allowedOutputTypes: ['json-to-memory'],
  defaultOutputType: 'json-to-memory',
  defaultContext: {
    history: { mode: 'last_n', n: 5 },
    persona: false,
    memoryReads: [],
  },
  defaultPromptTemplate: PROMPT_TEMPLATE,
  defaultConfig: () => ({ prompt: '', model: DEFAULT_FAST_MODEL, /* … */ }),
  ConfigComponent: MyAddonConfigComponent,
};

registerPlugin(myAddonPlugin);
```

Then `require` it from `aspect-react-client/src/builder/plugins/index.ts` (side-effect import).

### Prompt template — byte-equality contract

The prompt template lives **inside the addon instance JSON** (`AddonInstance.promptTemplate`). Both sides use the same substituter:

- Client: `aspect-react-client/src/builder/components/PromptTemplateModal/buildPromptPreview.ts`
- Server: `aspect-agent-server/builder/runtime/promptAssembler.js`

They MUST produce the same output for the same inputs. If you add a new placeholder:

1. Add it to `KNOWN_PROMPT_PLACEHOLDERS` in `aspect-react-client/src/builder/types/index.ts`.
2. Implement the substitution in **both** `buildPromptPreview.ts` and `promptAssembler.js`.

History is **not** a placeholder — it's a separate runtime LLM parameter (`historyMessages`).

---

## Worked example: a "Summarizer" addon

Goal: a one-shot addon that produces a one-line summary of the conversation so far and writes it to memory under the `summary` field.

### Client — `aspect-react-client/src/builder/plugins/summarizer/addon.summarizer.ts`

```ts
import type { PluginDescriptor } from '../../registry/plugins';
import { registerPlugin } from '../../registry/plugins';
import { DEFAULT_FAST_MODEL } from '../../registry/providerModels';

interface SummarizerConfig {
  prompt: string;
  model: { providerId: string; modelId: string };
}

const PROMPT_TEMPLATE = `{{prompt}}

Produce a one-line summary. Output JSON: { "summary": "..." }.

{{memory}}`;

export const summarizerPlugin: PluginDescriptor<SummarizerConfig> = {
  id: 'summarizer',
  name: 'Summarizer',
  description: 'Distills the conversation into a one-liner.',
  icon: '📝',
  color: '#06b6d4',
  defaultLane: 'main',
  fieldMode: 'none',
  speaks: false,
  allowedOutputTypes: ['json-to-memory'],
  defaultOutputType: 'json-to-memory',
  defaultContext: {
    history: { mode: 'last_n', n: 10 },
    persona: false,
    memoryReads: [],
  },
  defaultPromptTemplate: PROMPT_TEMPLATE,
  defaultConfig: () => ({
    prompt: 'You summarize conversations crisply.',
    model: DEFAULT_FAST_MODEL,
  }),
  ConfigComponent: () => null, // no fancy UI — `prompt` editor inherited from common
};

registerPlugin(summarizerPlugin);
```

Add to `aspect-react-client/src/builder/plugins/index.ts`:

```ts
import './summarizer/addon.summarizer';
```

### Server — `aspect-agent-server/builder/plugins/summarizer/addon.summarizer.js`

```js
const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');

async function run(ctx) {
  const start = Date.now();
  const { instance, prompt, modelString, userMessage, conversationId,
          agentNameForLogs, ownerUserId, historyMessages,
          llm, usageProcess, usageCrew } = ctx;

  const result = await llm.sendOneShot(prompt, userMessage, {
    model: modelString,
    jsonOutput: true,
    historyMessages,
    context: usageProcess,
    agentName: agentNameForLogs,
    crewMember: usageCrew,
    conversationId: String(conversationId),
    userId: ownerUserId,
  });
  const raw = typeof result === 'string' ? result : (result?.text || '');
  const { parsed, error } = parseOutput('json-to-memory', raw);

  const memoryWrites = [];
  if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
    memoryWrites.push({ domain: null, field: 'summary', value: parsed.summary });
  }

  return {
    rawOutput:    raw,
    parsedOutput: parsed,
    memoryWrites,
    parseError:   error || undefined,
    durationMs:   Date.now() - start,
    tokens:       { input: 0, output: 0, total: 0 },
  };
}

registerPlugin({
  id: 'summarizer',
  allowedOutputTypes: ['json-to-memory'],
  run,
});
```

Add to `aspect-agent-server/builder/plugins/index.js`:

```js
require('./summarizer/addon.summarizer');
```

That's it. The engine will:
- Show the addon in the chain canvas / picker (client).
- Validate the chosen `outputType` against `allowedOutputTypes` (server).
- Resolve the addon's model via the central registry.
- Assemble the prompt + load history + load memory.
- Call your `run()`.
- Persist `memoryWrites` into the conversation memory.
- Persist an `addon_runs` row.
- Stream the live addon card to the chat panel.

---

## Conventions / gotchas

- **Always set a stable `id`.** The crew body references the plugin by id; renaming an id breaks every saved crew that uses it.
- **`outputType` is per-instance, declared by the user.** `allowedOutputTypes` on the plugin is just the list of values the picker offers. A user can pick any item from the allowed list; your `run()` should branch on `instance.outputType` if you support more than one.
- **Don't mutate `ctx.memory` directly.** Return writes; the engine merges + persists. Direct mutation will leave the in-memory blob and the DB out of sync.
- **For streaming addons, log usage yourself.** Capture the trailing `{ type: 'usage' }` chunk from the provider stream and call `ctx.logUsage(...)`. The `llm.sendOneShot` path auto-logs; the streaming path does not.
- **History is separate.** Don't try to interpolate it into the prompt — pass `historyMessages` as the LLM call parameter.
- **The prompt template lives in the addon JSON** (snapshot at create time). If you update the plugin's `defaultPromptTemplate`, existing instances keep their old template until the user explicitly resets. That's intentional — it stops a plugin update from quietly changing every existing crew's behavior.

---

## Where things live (quick reference)

```
aspect-agent-server/
  builder/
    runtime/
      BuilderRunner.js          ← engine (plugin-agnostic)
      pluginRegistry.js
      promptAssembler.js
      outputParser.js
      builderMemory.js
      historyService.js
      addonRunsStore.js
    plugins/
      index.js                  ← side-effect imports
      talker/addon.talker.js
      fieldExtractor/addon.fieldExtractor.js
    services/builderProjects.js
    routes/
      projectsRoute.js          ← /api/builder/* (CRUD on doc)
      runtimeRoute.js           ← /api/agents/:slug/* (runtime + history + runs)
  services/
    llm.js                      ← provider router (uses models.service)
    models.service.js           ← single source of truth for models
    usageLogger.js
    context.service.js          ← what builderMemory wraps

aspect-react-client/src/builder/
  state/BuilderContext.tsx
  state/useProjectSync.ts
  state/builderApi.ts
  state/runtimeStream.ts
  registry/plugins.ts
  registry/providerModels.ts    ← fetched from server at boot
  registry/useModels.ts
  plugins/
    index.ts                    ← side-effect imports
    talker/addon.talker.ts
    fieldExtractor/addon.fieldExtractor.ts
  components/
    PromptTemplateModal/buildPromptPreview.ts   ← must match promptAssembler.js
    AddonRun/AddonRunCard.tsx
    ...
```
