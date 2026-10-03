# Build with your own AI — the Intelligence Center door (task #96)

A client's people build Intelligence Center apps with **their own** AI —
ChatGPT, Claude.ai, Claude Desktop, Cursor, Claude Code, Codex — instead of
with Otto. Same result as Otto — a draft app on the Apps shelf — but the
thinking runs on the client's AI account, so it costs us nothing.

Modelled on LYBI's `/builder/mcp` (`docs/guides/BUILDER_MCP_MAINTENANCE.md`
— read it; most rules there apply here). One personal URL is two doors:

- **a real MCP server** (Streamable HTTP, stateless, official SDK): a JSON-RPC
  POST to the URL serves 10 tools. This is the door for business people —
  ChatGPT and Claude.ai cannot POST to a plain URL, but they can add it as a
  custom connector (no authentication; the key is in the URL).
- **a text guide + REST endpoints**: a GET of the URL returns the guide, for
  tools that fetch and POST themselves (Claude Code, Codex).

Both call one set of operations (`ops` in `mcp.routes.js`) and share one
guide (`entryDoc(req, {mcp})` names tools or URLs, everything else is shared).

## How a person uses it

1. Intelligence Center → Apps → **Your own AI** tile. Two tabs:
   - **ChatGPT / Claude**: copy the link, add it as a custom connector
     (Claude: Settings > Connectors; ChatGPT: Apps & Connectors, developer
     mode), turn it on in a chat.
   - **Claude Code / Codex**: copy the prompt *"Read <link> and help me build
     an app"* and paste it.
2. Ask for a screen. The AI reads the data description, writes a spec,
   dry-runs it until the numbers check out, saves it.
3. The app appears on **their** shelf as a draft. They open it and press
   **Save to Apps** (or ask the AI to publish) to share it with the
   organisation. They can also keep editing it with Otto.

MCP tools: `get_guide`, `get_schema`, `list_apps`, `get_app`, `check_app`,
`create_app`, `update_app`, `publish_app`, `unpublish_app`, `delete_app`
(read-only / destructive annotations set, so clients confirm the right ones).
The guide is also sent as the server's `instructions` on initialize.

Optional: say `setup` and the tool installs `/ic-help`, `/ic-schema`,
`/ic-list`, `/ic-show`, `/ic-create`, `/ic-update`, `/ic-check`,
`/ic-publish`, `/ic-unpublish`, `/ic-delete` as real
slash commands (Claude Code: `.claude/commands/`, Codex: `~/.codex/prompts/`).
The `ic-` prefix avoids Claude Code's own commands, which intercept bare `/list`.

## The three decisions everything rests on

1. **Otto's engine, not a second one.** The outside AI writes the same JSON
   screen spec Otto's build call writes. Everything after that is Otto's own
   code, unchanged: `validateSpec` → `executeSpec` (compiled SQL, statement
   timeout, row caps) → `verifyBuild` probes → `screens.storeSpec`. No SQL,
   HTML or code is ever accepted. A plan is derived from the spec
   (`mcp.service.derivePlan`) so Otto can revise the draft later.
2. **Isolation by signature.** The link carries a token
   `base64url(viewerId).hmac(clientSecret, slug + "\n" + viewerId)`. The slug
   is inside the signature, so one client's link opens nothing of another's.
   The per-client secret is the `ai-builder` module's binding, created on the
   first link request. The viewer id is Otto's anonymous per-browser id, so
   saved drafts belong to the person who copied the link (task #92 scoping).
3. **Full CRUD, but no new powers.** Create, read, update, publish (= Save to
   Apps), unpublish (= Edit) and delete exist with exactly the builder's rules:
   creator only; delete only a draft that was never published (a published
   app's removal stays super-admin). The guide tells the AI to get the
   person's explicit yes before publish or delete.

## Switching it on for a client

Admin → Modules → **Build with your own AI** → enable. Requires module
`otto` to be live for the same dataset (the door serves Otto's brief). With
the module off, the shelf payload is byte-identical to before (`aiBuilder`
key omitted) and every door URL answers 403.

To revoke every link a client was given: switch the module off (immediate),
or clear its binding (rotates the secret on the next link request).

## Where the code lives

| Path | Responsibility |
|---|---|
| `modules/ai-builder/module.js` | descriptor: app module, dataset scope, no settings |
| `otto/routes/mcp.routes.js` | THE door: gate, entry page (`entryDoc`), setup, schema, apps, check, save |
| `otto/services/mcp.service.js` | dry-run check, create/update through Otto's pipeline, `derivePlan` |
| `otto/services/mcp-token.service.js` | per-client secret, issue/verify, `doorOpen` |
| `otto/routes/otto.routes.js` | `GET /api/otto/:datasetId/ai-link?viewerId=` — mints the personal link |
| `modules/services/apps.service.js` | `aiBuilder: true` on the shelf when both modules are live |
| `server.js` | `app.use('/intelligence', …)` |

Client: `src/components/intelligence/Apps/custom/AiBuilderDialog.tsx`, the
tile in `AppsPage.tsx`, `ottoService.aiLink`, `aiBuilder.*` translations.

## Endpoints (under `/intelligence/:slug/mcp/:token`)

| Method | Path | What |
|---|---|---|
| GET | `/` (`/help`) | the guide: model, commands, workflow, spec format, rules (text/plain) |
| GET | `/setup` | slash-command files |
| GET | `/schema` | sources, fields, caveats, starter ideas; `?format=json` |
| GET | `/apps` | apps this viewer can see |
| GET | `/apps/:id` | one app with its full spec — working examples |
| POST | `/check` `{spec}` | validate + query + probes, saves nothing; errors name the exact field |
| POST | `/apps` `{title, summary?, icon?, spec}` | save a new draft (re-checked; 422 if it fails) |
| POST | `/apps/:id` `{spec?, title?, summary?, icon?}` | change an unpublished app (creator only) |
| POST | `/apps/:id/publish` | Save to Apps — visible to the organisation (creator only, built drafts) |
| POST | `/apps/:id/unpublish` | Edit — published app back to an editable draft, snapshot kept |
| DELETE | `/apps/:id` (or POST `/apps/:id/delete`) | delete a never-published draft (creator only) |

## What the door adds on top of Otto's contract

- **Chart checks** (`mcp.service.doorChecks`): a chart's series must be
  numeric; a pie takes one series and needs an orderBy and limit <= 10. Otto's
  plan step keeps its own model in line; an outside AI has no plan step, and a
  40-slice pie and a text-column series both passed the contract in testing.
  Kept out of `spec.contract.js` so Otto's engine stays untouched.
- **Errors are always sentences, never Express HTML**: a link without its
  key, an unknown path or verb (answered with the endpoint map), and a body
  that is not JSON (`errorHandler`, mounted in `server.js` after the router).
- **`mine`** on every listed app — the same `screens.canEdit` the writes use.
- **Scope warnings** (`mcp.service.scopeWarnings`): a KPI card on a result set
  that hit its limit covers more rows than the screen shows; a chart over 30
  rows is cut. Warnings, not errors — a top-10 table with a grand total is
  legitimate — returned by `/check` and by every save.

## Test log

- 2026-10-03: two runs of an outside agent that had never seen the code,
  given only the paste-in prompt. Round 1 (English): create, list, update,
  delete — every build passed `/check` first time. Its 11 notes on the guide
  were folded in (draft vs publish wording, plain-field measures, KPI fields
  are result-set columns, count = rows, filterBar scope, raw numbers,
  caveat choice, block order, `mine`, failure responses).
  Round 2 (Hebrew, setup, line + pie, impossible request, delete): found that
  KPI cards ignore a result set's `limit` (Otto's compiler, by design), so a
  "last 30 days" total card showed all 639 days with `/check` green. Door now
  returns `warnings` for cards on truncated sets and charts over 30 points;
  the guide says a "last N days" card cannot be built. Also: line charts on a
  date axis now draw oldest to newest (ScreenRenderer, client), update reminds
  to refresh the summary, delete echoes the title. Impossible request (new
  customers, no customer data) was refused honestly with alternatives.

  MCP door (same day): official SDK client against the local server — 16/16:
  initialize with instructions, 10 tools with annotations, read/check/create/
  update/delete round trip, failing spec refused as an `isError` result,
  someone else's app refused, SSE GET probe answered 405, plain GET still
  returns the guide.
  Prod (rev 00594): the same SDK battery 16/16, then a real Claude model
  (Messages API, `mcp-client-2025-11-20`, our URL as a remote MCP server —
  the Claude.ai connector path) given only "build me revenue by category
  with a top-10 bar chart, a table and a total KPI": get_guide → get_schema →
  check_app (passed first try) → create_app, then list_apps and delete_app on
  request. It relayed the filter scope and the revenue caveat unprompted.
  Not yet tried: a human adding the link in ChatGPT / Claude.ai settings.

## Keeping it in step with Otto

The entry page restates the spec format and rules that Otto's build prompt
(`otto/services/spec.service.js`) teaches. Enumerations (block kinds, aggs,
formats, icons, limits) are interpolated from `spec.contract.js`, so they
cannot drift; the prose rules can. **When the spec contract gains a block
kind or a rule, update `entryDoc()` too.**

## Verify

Local server + Cloud SQL Proxy, module enabled for the dataset:
link issued → entry/schema/setup → apps (others' drafts hidden) → token on
another slug 403/401, forged token 401 → check valid spec passes, broken
spec returns field-level errors → save refuses a failing spec (422) → save
creates a `ready` draft owned by the viewer, with a derived plan → other
viewers 404 → update works, someone else's published app refused. Delete the
test draft afterwards (Otto's DELETE with the test viewer id).

The real test is a real session: paste the link into Claude Code and ask
for a screen.
