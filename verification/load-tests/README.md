# Load tests — verification (task #902)

## Step 1 — one conversation, the load-test way (2026-10-21)

**What was checked:** a simulation released with `via: "public"` sends every
turn through the address the release came in on (not straight into its own
process), and keeps each turn's time and — for a failed turn — the error
center's kind.

**How:** local server; Admin API `POST /api/simulations` on `tkb-demo`, a fixed
4-line script, `via: "public"` → job #35, conversation #4450.

| Check | Result |
|---|---|
| Stored address | `http://localhost:3000` (the release's own address — locally; production gives its Cloud Run URL) |
| Job | completed, 4/4 turns, no errors |
| Turn times | 7.2 s · 5.8 s · 4.8 s · 4.8 s |
| **Baseline** | **median 5.3 s, slowest 7.2 s** |
| Cost | 8 model calls (gemini-2.5-flash ×4, gpt-4o-mini ×4), ~3.2k tokens — well under $0.01 |
| `via: "sideways"` / no address | refused with a sentence, before anything runs |
| Failed-turn kinds (offline) | model rate limit · front-door 429/503 → server unavailable · timeout · our code |
| Screen: turn times + "Sent through" in the job; form option, no resize on click | ✓ (screenshots) |
| `node scripts/test-error-center.js` | ✓ 33/33 |
| `node scripts/test-simulation-jobs.js` | ✓ all pass |

Not checked: a failed turn through the public address end-to-end (only the
kind mapping, offline), and production (not deployed).

## Step 2 — two at once, shown as one run (2026-10-22)

**What was checked:** a load test releases several simulations together —
all conversations created first, then started in the same tick — and the
Admin → Load tests view shows them as one run.

**How:** local server; `POST /api/load-tests` on `tkb-demo`, 2 conversations,
the step-1 baseline's 4-line script → run #36 (jobs #37/#38, conversations
#4451/#4452).

| Check | Result |
|---|---|
| Both conversations started | same second (21:06:55) |
| Run | finished, 2/2 conversations, 8/8 turns, no errors, 23.3 s wall |
| Turn times (s) | conv 1: 6.3 · 4.8 · 4.8 · 3.8 — conv 2: 6.2 · 4.5 · 5.2 · 3.8 |
| **2 at once vs. baseline** | **median 4.8 s vs 5.3 s, slowest 6.3 s vs 7.2 s — no slowdown** (within run-to-run noise) |
| Refusals | 5 conversations → "1 to 2 for now"; no script → refused; nothing created |
| Simulations list | leaves out load-test conversations (they open under the run) |
| Screen: counts, side-by-side grid, conversation below; picking a row moves nothing | ✓ (screenshots) |
| `test-simulation-jobs.js` | ✓ all pass — after teaching its fake DB the new "no parent" filter (it first failed on it); +8 checks: timed turns, failed-turn kind, `via` refusals, held/started jobs, run children kept out of the Simulations list |
| `test-error-center.js` | ✓ 33/33 |

Not checked: the live view while a run is going (it polls every 3 s like
Simulations; only the finished state was screenshotted).

## Steps 3–6 (2026-10-22)

Every run: baseline (one alone) → N at once, through the public address,
default 5-line script, `tkb-demo`, local server.

| Run | Baseline median | Under load median · slowest 5% | Slowdown | Errors | Cost (est.) | Server |
|---|---|---|---|---|---|---|
| #39 · 5 at once | 4.6 s | 4.4 s · 5.3 s | 0.95× | 0 | $0.23 ($0.14) | — |
| #46 · 10 at once | 4.2 s | 5.7 s · 7.0 s | **1.35×** | 0 | $0.40 ($0.41) | — |
| #58 · 10 at once, pool 5 | — | — | **1.24×** | 0 | $0.40 ($0.40) | DB pool **5/5 in use, up to 6 waiting** (11 of 34 samples) · CPU ≤16% · 207 MB |
| #70 · 10 at once, `DB_POOL_MAX=15` | 4.6 s | 4.3 s · 5.3 s | **0.92×** | 0 | $0.40 | DB 10/15, **0 waiting** · CPU ≤20% |
| #82 · 2 at once, started from the screen | | | as fast | 0 | $0.11 est. | |

**Finding:** at 10 at once the slowdown is the database connection pool —
`DB_POOL_MAX=5` (local and both production env files), not CPU, memory or
the model provider (no rate limits seen). With 15 the slowdown disappears.
**Not changed** — it is a production setting; see the report.

**Estimate fix:** #39 cost 1.6× its average-based estimate (scripted turns are
heavier than the agent's everyday ones). The estimate now uses the higher of
the 30-day average and the last load test's real per-turn cost — #46 then
estimated $0.41 for $0.40 spent.

Cap: over-$20 refusal and the stop at $20 spent are proven offline
(`test-load-tests.js`, 19 checks) — no real agent here comes near $20 within
20 × 10. Manual Stop: same gate, also offline. MCP: estimate / refusals /
reads in `test-builder-mcp.js`.

Not done: Google Cloud metrics across instances (instance count), and the
separate simulation service — both need production.

## Correction — what the local pool numbers mean (2026-10-22)

Measured with a driver-level probe (every query's time on its connection and
every wait for a free one):

| | Value |
|---|---|
| Round trip, this machine → the database | **64 ms** median (Israel → europe-west1) |
| Database queries per agent turn (tkb-demo) | **~46** |
| Connection time per turn, locally | 46 × ~65 ms ≈ **3 s** |
| Same, production (Cloud Run next to the DB, est. 2–3 ms/query) | ≈ **0.1–0.15 s** — not measured |
| Database limit | `max_connections = 50`, for everything |
| Load-test bookkeeping per turn | ~36 queries before the fix → **~4** after (one query for all jobs every 3 s, heartbeat 10 s, finished runs frozen) |

So the 10-at-once slowdown above is mostly the distance to the database,
multiplied by the pool. It is NOT evidence that production needs a bigger
pool. The recommendation to raise `DB_POOL_MAX` to 15 is withdrawn until a
load test runs on production.
