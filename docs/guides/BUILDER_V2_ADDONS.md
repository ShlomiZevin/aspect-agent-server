# Builder V2 — Authoring Addons

This guide shows how to add a new addon (plugin) to the V2 builder.

Every addon lives in **three** halves that share a single source of truth (a JSON descriptor) and split responsibility for runtime, UI, and Alfred:

| Half | Where | What it owns |
|------|-------|--------------|
| **Descriptor JSON**  *(shared)* | `aspect-agent-server/builder/addons/<id>.addon.json` | The data: `pluginId`, `defaultLane`, `allowedOutputTypes`, `defaultOutputType`, `defaultContext`, `defaultPromptTemplate`, `defaultConfig`, plus optional UI flags like `hideStandardSections`. **One source of truth — read by client, server, and Alfred.** |
| **Server runtime** | `aspect-agent-server/builder/plugins/<id>/addon.<id>.js` | The `run(ctx)` function: LLM call shape (streaming vs one-shot), output parsing, memory-write extraction. Imports the descriptor JSON for `pluginId` + `allowedOutputTypes`. |
| **Client UI** | `aspect-react-client/src/builder/plugins/<id>/` | A thin `addon.<id>.ts` wrapper that hydrates the descriptor JSON + attaches the React `ConfigComponent` (and `DebugComponent`, if any). The `ConfigComponent` is the per-plugin form in the addon-config modal. |

The engine in [`BuilderRunner.js`](../../builder/runtime/BuilderRunner.js) is plugin-agnostic. It looks up the plugin in the registry and delegates the LLM-shape concerns to it.

**Why this split:** Alfred's patch generator ([alfred/services/patchGenerator.js](../../alfred/services/patchGenerator.js)) loads every `*.addon.json` at module init and embeds each as a "fresh AddonInstance template" in its system prompt. Adding the JSON file is what makes a new addon Alfred-compatible — no other Alfred work is needed.

---

## The descriptor JSON

The single source of truth. One file per addon at `aspect-agent-server/builder/addons/<id>.addon.json`. Filename: descriptive (e.g. `talker.addon.json`), never `index.*`.

Shape — every field is data, no functions:

```jsonc
{
  "pluginId":          "my-addon",            // stable id; matches the filename root
  "displayName":       "My Addon",
  "description":       "Short tagline for the picker.",
  "icon":              "🛠️",
  "color":             "#0ea5e9",

  "defaultLane":       "main",                // 'main' | 'background' | 'offline'
  "fieldMode":         "none",                // 'none' | 'extractor'
  "speaks":            false,                 // true only for Talker-like addons

  "allowedOutputTypes": ["json-to-memory"],   // engine validates per instance
  "defaultOutputType":  "json-to-memory",

  "defaultContext": {
    "history":      { "mode": "last_n", "n": 5 },
    "persona":      false,
    "memoryReads":  []
  },

  "defaultPromptTemplate": "{{prompt}}\n\n{{memory}}",

  "defaultConfig": {
    "prompt": "",
    "model":  { "providerId": "openai", "modelId": "gpt-4o-mini" }
  }
}
```

Optional fields used by some plugins:
- `allowedFieldSources: ['explicit' | 'inferred']` — only for `fieldMode: 'extractor'`.
- `hideStandardSections: { context, output, promptTemplate, repository }` — booleans that suppress those sections in the addon-config modal when they don't apply (e.g. Transition Router has no LLM call).

---

## The server plugin contract

A server plugin is a descriptor registered at module-load time. Pull the `pluginId` + `allowedOutputTypes` from the shared JSON so the runtime stays in sync automatically:

```js
const { registerPlugin } = require('../../runtime/pluginRegistry');
const descriptor = require('../../addons/my-addon.addon.json');

registerPlugin({
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
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

A thin wrapper that hydrates the shared JSON descriptor and attaches the React `ConfigComponent`. Lives in `aspect-react-client/src/builder/plugins/<id>/addon.<id>.ts`:

```ts
import type { PluginDescriptor } from '../../registry/plugins';
import { registerPlugin } from '../../registry/plugins';
import type { MyAddonConfig } from '../../types';
import { MyAddonConfigComponent } from './MyAddonConfig';
import descriptor from '@addons/my-addon.addon.json';

export const MY_ADDON_PLUGIN_ID = descriptor.pluginId;

export const myAddonPlugin: PluginDescriptor<MyAddonConfig> = {
  id:                   descriptor.pluginId,
  name:                 descriptor.displayName,
  description:          descriptor.description,
  icon:                 descriptor.icon,
  color:                descriptor.color,
  defaultLane:          descriptor.defaultLane          as PluginDescriptor<MyAddonConfig>['defaultLane'],
  fieldMode:            descriptor.fieldMode            as PluginDescriptor<MyAddonConfig>['fieldMode'],
  speaks:               descriptor.speaks,
  allowedOutputTypes:   descriptor.allowedOutputTypes   as PluginDescriptor<MyAddonConfig>['allowedOutputTypes'],
  defaultOutputType:    descriptor.defaultOutputType    as PluginDescriptor<MyAddonConfig>['defaultOutputType'],
  defaultContext:       descriptor.defaultContext       as PluginDescriptor<MyAddonConfig>['defaultContext'],
  defaultPromptTemplate: descriptor.defaultPromptTemplate,
  // Factory wraps the literal so each new instance gets its own
  // copy — preserves the PluginDescriptor.defaultConfig contract.
  defaultConfig: (): MyAddonConfig => structuredClone(descriptor.defaultConfig) as MyAddonConfig,
  ConfigComponent: MyAddonConfigComponent,
};

registerPlugin(myAddonPlugin);
```

Then `require` it from `aspect-react-client/src/builder/plugins/index.ts` (side-effect import).

The `@addons/*` import alias is configured in [vite.config.ts](../../../aspect-react-client/vite.config.ts) (`resolve.alias`) and [tsconfig.app.json](../../../aspect-react-client/tsconfig.app.json) (`compilerOptions.paths`). It resolves into the sibling `aspect-agent-server/builder/addons/` directory; `server.fs.allow: ['..']` lets Vite's dev server read the parent path.

If you add new fields to your descriptor JSON that the client uses, you can either widen `PluginDescriptor` in [registry/plugins.ts](../../../aspect-react-client/src/builder/registry/plugins.ts) or just read them via a typed cast at the use site. The cast pattern above is the existing convention.

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

**Three files. Two index registrations. One TS type (only if your config has a non-trivial shape).** Done.

### 1. Descriptor JSON — `aspect-agent-server/builder/addons/summarizer.addon.json`

```jsonc
{
  "pluginId":          "summarizer",
  "displayName":       "Summarizer",
  "description":       "Distills the conversation into a one-liner.",
  "icon":              "📝",
  "color":             "#06b6d4",

  "defaultLane":       "main",
  "fieldMode":         "none",
  "speaks":            false,

  "allowedOutputTypes": ["json-to-memory"],
  "defaultOutputType":  "json-to-memory",

  "defaultContext": {
    "history":     { "mode": "last_n", "n": 10 },
    "persona":     false,
    "memoryReads": []
  },

  "defaultPromptTemplate": "{{prompt}}\n\nProduce a one-line summary. Output JSON: { \"summary\": \"...\" }.\n\n{{memory}}",

  "defaultConfig": {
    "prompt": "You summarize conversations crisply.",
    "model":  { "providerId": "openai", "modelId": "gpt-4o-mini" }
  }
}
```

Adding the JSON file is what makes the addon Alfred-compatible. The patch generator picks it up at module init and starts treating `summarizer` as a valid `pluginId` Alfred can create.

### 2. TypeScript type (optional) — `aspect-react-client/src/builder/types/index.ts`

If your config has a non-trivial shape, define an interface. For the Summarizer, the shape is just `prompt` + `model`, which is covered by `TalkerConfig`-like shapes — you can either reuse one or add a new one:

```ts
export interface SummarizerConfig {
  prompt: string;
  model: ModelRef;
}
```

### 3. Client wrapper — `aspect-react-client/src/builder/plugins/summarizer/addon.summarizer.ts`

```ts
import type { PluginDescriptor } from '../../registry/plugins';
import { registerPlugin } from '../../registry/plugins';
import type { SummarizerConfig } from '../../types';
import descriptor from '@addons/summarizer.addon.json';

export const SUMMARIZER_PLUGIN_ID = descriptor.pluginId;

export const summarizerPlugin: PluginDescriptor<SummarizerConfig> = {
  id:                   descriptor.pluginId,
  name:                 descriptor.displayName,
  description:          descriptor.description,
  icon:                 descriptor.icon,
  color:                descriptor.color,
  defaultLane:          descriptor.defaultLane          as PluginDescriptor<SummarizerConfig>['defaultLane'],
  fieldMode:            descriptor.fieldMode            as PluginDescriptor<SummarizerConfig>['fieldMode'],
  speaks:               descriptor.speaks,
  allowedOutputTypes:   descriptor.allowedOutputTypes   as PluginDescriptor<SummarizerConfig>['allowedOutputTypes'],
  defaultOutputType:    descriptor.defaultOutputType    as PluginDescriptor<SummarizerConfig>['defaultOutputType'],
  defaultContext:       descriptor.defaultContext       as PluginDescriptor<SummarizerConfig>['defaultContext'],
  defaultPromptTemplate: descriptor.defaultPromptTemplate,
  defaultConfig: (): SummarizerConfig => structuredClone(descriptor.defaultConfig) as SummarizerConfig,
  ConfigComponent: () => null, // no fancy UI — common `prompt` editor handles it
};

registerPlugin(summarizerPlugin);
```

Add to `aspect-react-client/src/builder/plugins/index.ts`:

```ts
import './summarizer/addon.summarizer';
```

### 4. Server runtime — `aspect-agent-server/builder/plugins/summarizer/addon.summarizer.js`

```js
const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');
const descriptor = require('../../addons/summarizer.addon.json');

async function run(ctx) {
  const start = Date.now();
  const { prompt, modelString, userMessage, conversationId,
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
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  run,
});
```

Add to `aspect-agent-server/builder/plugins/index.js`:

```js
require('./summarizer/addon.summarizer');
```

### What you get for free

- **Engine** shows the addon in the chain canvas / picker; validates the chosen `outputType` against `allowedOutputTypes`; resolves the model via the central registry; assembles the prompt + loads history + loads memory; calls your `run()`; persists `memoryWrites` into conversation memory; persists an `addon_runs` row; streams the live addon card to the chat panel.
- **Alfred** can create instances of this plugin in any crew. No prompt updates needed — the patch generator already embeds the descriptor as a fresh-instance template the moment the JSON file lands on disk (after server restart).

---

## Conventions / gotchas

- **Always set a stable `id`.** The crew body references the plugin by id; renaming an id breaks every saved crew that uses it.
- **`outputType` is per-instance, declared by the user.** `allowedOutputTypes` on the plugin is just the list of values the picker offers. A user can pick any item from the allowed list; your `run()` should branch on `instance.outputType` if you support more than one.
- **Don't mutate `ctx.memory` directly.** Return writes; the engine merges + persists. Direct mutation will leave the in-memory blob and the DB out of sync.
- **For streaming addons, log usage yourself.** Capture the trailing `{ type: 'usage' }` chunk from the provider stream and call `ctx.logUsage(...)`. The `llm.sendOneShot` path auto-logs; the streaming path does not.
- **History is separate.** Don't try to interpolate it into the prompt — pass `historyMessages` as the LLM call parameter.
- **The prompt template lives in the addon JSON** (snapshot at create time). If you update the plugin's `defaultPromptTemplate`, existing instances keep their old template until the user explicitly resets. That's intentional — it stops a plugin update from quietly changing every existing crew's behavior.
- **Edit the descriptor JSON, never duplicate its fields.** The `.addon.json` file is the only place that holds defaults. The client `addon.<id>.ts` wrapper and the server `addon.<id>.js` plugin read from it; never re-declare a default inline. If you find yourself wanting a value the descriptor doesn't have, add it to the JSON first and surface it via cast at the use site.
- **Adding the JSON file is what makes an addon Alfred-compatible.** No prompt edits, no schema-doc edits. Alfred's patch generator scans `builder/addons/*.addon.json` at module init. Restart the server and the new plugin shows up as a fresh-instance template the next time Alfred runs an Apply.

---

## Where things live (quick reference)

```
aspect-agent-server/
  builder/
    addons/                                  ← SHARED descriptor JSONs
      talker.addon.json                       (read by server, client, and
      fieldExtractor.addon.json               Alfred's patch generator —
      transitionRouter.addon.json             single source of truth)
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
      talker/addon.talker.js                  (run() + register, hydrates
      fieldExtractor/addon.fieldExtractor.js   id + allowedOutputTypes
      transitionRouter/addon.transitionRouter.js  from the JSON above)
    services/builderProjects.js
    routes/
      projectsRoute.js          ← /api/builder/* (CRUD on doc)
      runtimeRoute.js           ← /api/agents/:slug/* (runtime + history + runs)
  alfred/
    services/
      patchGenerator.js         ← loads builder/addons/*.addon.json at
                                  module init, embeds each as a "fresh
                                  instance template" in its system prompt
  services/
    llm.js                      ← provider router (uses models.service)
    models.service.js           ← single source of truth for models
    usageLogger.js
    context.service.js          ← what builderMemory wraps

aspect-react-client/
  vite.config.ts                ← '@addons/*' alias + server.fs.allow ['..']
  tsconfig.app.json             ← matching 'paths' + resolveJsonModule

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
    talker/                                   (each: thin wrapper that
      addon.talker.ts                          hydrates @addons/<id>.json
      TalkerConfig.tsx                         + attaches ConfigComponent)
      TalkerConfig.module.css
    fieldExtractor/
      addon.fieldExtractor.ts
      FieldExtractorConfig.tsx
      FieldExtractorConfig.module.css
    transitionRouter/
      addon.transitionRouter.ts
      TransitionRouterConfig.tsx
      TransitionRouterConfig.module.css
  components/
    PromptTemplateModal/buildPromptPreview.ts   ← must match promptAssembler.js
    AddonRun/AddonRunCard.tsx
    ...
```
