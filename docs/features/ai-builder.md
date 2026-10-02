# Build with your own AI — the Intelligence Center door (task #96)

A client's people build Intelligence Center apps with **their own** AI
coding tool (Claude Code, Codex, any chat that can fetch a URL) instead of
with Otto. Same result as Otto — a draft app on the Apps shelf — but the
thinking runs on the client's AI account, so it costs us nothing.

Modelled on LYBI's `/builder/mcp` (`docs/guides/BUILDER_MCP_MAINTENANCE.md`
— read it; most rules there apply here). Like that door it is **not an MCP
server**: a text page that teaches the tool, plus plain HTTP endpoints.

## How a person uses it

1. Intelligence Center → Apps → **Your own AI** tile → copy the prompt.
2. Paste it into Claude Code / Codex: *"Read <link> and help me build an app"*.
3. Ask for a screen. The tool reads the data description, writes a spec,
   dry-runs it until the numbers check out, saves it.
4. The app appears on **their** shelf as a draft. They open it and press
   **Save to Apps** to share it with the organisation. They can also keep
   editing it with Otto.

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
