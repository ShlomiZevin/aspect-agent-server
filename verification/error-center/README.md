# Error center — verification (task #903)

## Step 1 — the error record, the Errors tab, the failed-turn hook (2026-10-21)

**What was checked:** a whole turn that fails is kept, grouped, and tagged
by where the conversation came from; the chat's own reply is unchanged.

**How:** against a local server, three conversations on `tkb-demo` (one
Builder, one Customer = `source: 'live'`, one Simulation), each sent one
message with a deliberately broken setup (`overrideAgentBody: {}` → "Agent has
no defaultCrewId; nothing to run"). It fails before any model call — no cost.

| Check | Result |
|---|---|
| Turn reply still `addon.error` / `runtime_failed`, same message | ✓ all 3 |
| Errors list: one group, ×3, in 3 conversations | ✓ |
| Split Builder 1 · Customer 1 · Simulation 1 | ✓ |
| Occurrences link conversation + reply message (#4447–#4449) | ✓ |
| Filters: source=customer → 1, area=addon → 0, sort=frequent | ✓ |
| Screen in Chromium, no page errors; picking an occurrence moves nothing | ✓ (screenshots) |
| `node scripts/test-error-center.js` (offline, 25 checks) | ✓ 25/25 |
| `node scripts/test-simulation-jobs.js` | ✓ all pass |

Screenshots: `step1-group.png`, `step1-occurrence-picked.png`.

## Steps 2–8 (2026-10-22)

**How:** local server, `tkb-demo`, deliberately broken pieces injected into
single Builder test turns (working-copy bodies — the saved agent is
untouched): a non-existent plugin (main and offline lane), an extractor
pointed at a model that does not exist, Profiler / Live Brain panels with
no model, a proactive fire at a conversation that does not exist, a
malformed request body, and a real crash in a separate process.

| Hook | Recorded as | Result |
|---|---|---|
| Add-on, main lane | addon · our code · unknown_plugin | ✓ |
| Add-on, offline lane | offline · our code | ✓ |
| Model call (404 model) | model · model error · grouped by model — **once**, not again as the add-on | ✓ |
| Profiler / Live Brain panel | profiler / live-brain · no_model | ✓ |
| Proactive trigger | trigger · proactive_failed | ✓ |
| Route error (bad JSON) | server · route_error, agent read from the URL; still answers 400 | ✓ |
| Crash (unhandled rejection) | server · unhandled_rejection — row written, process still exits 1 | ✓ |
| Customer turn fails | customer sees "Sorry — something went wrong on my side…" (Builder keeps the technical text) | ✓ |
| Status | Handled → two new customer failures → reads "Back", note kept; menu count 9 → 8 on marking one handled | ✓ |
| Alert | exactly **one** "Error is back" email for two failures (claim is atomic) | ✓ sent to shlomi@boostart.io |
| Rate-limit retry (offline, stubbed provider) | 2 retries then answer; no retry after text was streamed; other errors not retried | ✓ |
| MCP | `/agents/:slug/errors` + details page, read only | ✓ in `test-builder-mcp.js` |
| Screen | status window keeps its size; header doesn't move; no page errors | ✓ screenshots |

Batteries: `test-error-center.js` 47/47 · `test-builder-mcp.js` ALL PASS ·
shared-code checks: `test-insights-unit` 65/65, `test-modules-unit` 56/56,
`test-otto-unit` 91/91, `test-stage3-unit` 35/35. (`test-stage2-unit` could
not run: its gitignored corpus file is not on this machine.)
