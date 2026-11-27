# Direct vs Vertex — Claude on the Vertex Lab agent (board #996)

**Checked 2026-11-27.** What changes when the same agent calls Claude through Google
Vertex AI instead of Anthropic's own API: whether it works today, speed, tokens, cost,
errors, streaming, tools, output, and the non-numeric implications.

Raw JSON in this folder (git-ignored like every `verification/*.json`; regenerate with the
commands below): `server-direct-2026-11-27.json`, `local-2026-11-27-all-addons.json`,
`local-2026-11-27-no-websearch.json`.

## 1. Does Claude on Vertex work today?

| Check | Result |
|---|---|
| Claude quota in `lybi-staging` | **No longer 0.** Service Usage shows the default Claude quotas: global endpoint e.g. Sonnet family 2,500 req/min, Haiku 3,000 req/min, Sonnet 4.6 / 4.5 1,500 req/min (+ token-per-minute limits). The old "quota 0" blocker is gone. |
| One raw call per model, global endpoint (`rawPredict`, 16 tokens) | **200** Claude Haiku 5.5 · Sonnet 5.5 · Sonnet 4.6. **404 "not found or your project does not have access"** Claude Opus 5.5, Haiku 4.5 (`claude-haiku-4-5@20251001` too) — both exist GA in Model Garden, so they are not enabled for the project. |
| Our own code path, from this machine (`check-vertex-route.js --live --only=claude`, ADC) | **ALL OK** — `runAddon → Talker → llm.js → AnthropicVertex`, one request to `aiplatform.googleapis.com/…/claude-haiku-5-5:streamRawPredict`, usage row `anthropic@vertex`, no direct-API hit. |
| Claude **web search** on Vertex | **Blocked by an organization policy**: `400 FAILED_PRECONDITION — Organization Policy constraint constraints/vertexai.allowedPartnerModelFeatures violated for projects/700084613835 … disallowed feature web_search for Partner model claude-sonnet-5-5`. Needs `publishers/anthropic/models/<model>:web_search` added to that constraint's allowed values (org admin). |
| Regions | `global` ✓ · `eu` multi-region ✓ (Sonnet 5.5, 200) · `europe-west1` ✗ 429 (regional Claude 5.5 quota 0) · **`me-west1` ✗ 404 — Claude is not offered in Tel Aviv.** |
| **On the staging server** | **Not yet.** A Vertex turn fails loudly, nothing sent anywhere: *"This agent's model route is Vertex, but VERTEX_PROJECT_ID is not set on this server…"*. The Cloud Run service account `lybi-server@lybi-staging.iam.gserviceaccount.com` has no `roles/aiplatform.user`. |

The local calls ran as Shlomi's `shlomi@boostart.io` user, which is **Editor** on
`lybi-staging` (that is why they were allowed). `shlomi@lybi.ai` needs an interactive
`gcloud auth login` on this machine.

**What turns it on for the server** (unchanged from #996, now no longer waiting on Google
for Claude): (1) `roles/aiplatform.user` for `lybi-server@lybi-staging.iam.gserviceaccount.com`
(owner, `--account=shlomi@lybi.ai`); (2) `VERTEX_PROJECT_ID=lybi-staging`,
`VERTEX_LOCATION=global` in `.env.production.staging` + a staging deploy; (3) optional:
enable Opus 5.5 / Haiku 4.5 in Model Garden; allow `web_search` in the org policy for the
Claude models we use. GPT-6 on Vertex (OpenAI preview) is still a separate Google ask.

## 2. The lab agent

**Vertex Lab** — slug `vertex-lab`, Lybi Staging, Builder domain "Shlomi":
https://lybi-staging.web.app/vertex-lab/builder · definition `scripts/fixtures/vertex-lab-agent.json`,
built by `node scripts/setup-vertex-lab.js` (Builder MCP + Builder API on staging). Not published.

Anthropic models only, on every add-on:

| Where | Add-on | Model |
|---|---|---|
| Agent (offline) | Summarizer, every 4 messages | Claude Haiku 5.5 |
| Crew **Intake** | Field Extractor (name, goal, target, monthly) → Rules (goal + monthly known → **Plan**, same turn) → Talker | Haiku 5.5 · — · Haiku 5.5 |
| Crew **Plan** | Thinker (months to goal; **web search** only for current interest rates) → Talker | Sonnet 5.5 · Sonnet 4.6 |

Test messages (`scripts/fixtures/vertex-lab-scenarios.json`, the harness sends them as-is):

1. **happy-path** — "Hi, I'm Dana." / "I want to save for a trip to Japan, about 12,000 shekels." / "I can put aside 1,500 a month." (→ Plan) / "How long will that take? And what if I add 500 more each month?"
2. **cascade** — "I'm Lior, saving 5,000 shekels for a new laptop, I can do 800 a month. How long?" (Intake hands over, Plan answers the same turn) / "Can I get there two months faster?"
3. **web-search** — "Hi, I'm Avi. Saving for a car, 60,000 shekels, 2,000 a month." / "What is the Bank of Israel interest rate right now? Would a savings deposit help me get there sooner?" (Thinker searches once)
4. **hebrew** — three Hebrew lines (apartment down payment, 200K, 3,000 → 4,000 a month); see the fixture.

## 3. How it was measured

```bash
# server: the real product path on staging, per route (Direct now; both once the server is set up)
TZ=UTC node scripts/compare-vertex-direct.js --routes=direct --repeat=2 --tag=direct-2026-11-27
TZ=UTC node scripts/compare-vertex-direct.js --routes=direct,vertex --repeat=2      # after #996 steps 1–2

# local A/B: the same requests, both routes, same machine, through services/llm.js
VERTEX_PROJECT_ID=lybi-staging VERTEX_LOCATION=global node scripts/compare-vertex-direct.js --local \
  --from=verification/vertex-vs-direct/server-direct-2026-11-27.json --tag=2026-11-27-all-addons
VERTEX_PROJECT_ID=lybi-staging VERTEX_LOCATION=global node scripts/compare-vertex-direct.js --local \
  --from=verification/vertex-vs-direct/server-direct-2026-11-27.json --only=thinker,talker --no-web-search --repeat=2 --tag=2026-11-27-no-websearch
```

- **Server mode** streams each turn through the customer API with the agent's ACTIVE body as
  `overrideAgentBody` (+ `modelRoute: 'vertex'` for Vertex) — no version saved, routes
  interleaved. From the SSE stream: first reply token, full reply, turn end, streaming, every
  add-on's status/duration/searches/transition/error. From Admin → LLM Usage: every call's
  tokens, cost, duration and route. Then the agent's error list (retries) and final fields;
  paired turns are compared (crew, transition, fields, length, word overlap).
- **Local A/B** rebuilds every add-on request of the Direct run (assembled prompt as the model
  got it + the conversation so far) and sends it once Direct (staging key) and once Vertex
  (ADC), alternating which goes first, one uncounted warm-up per route. It isolates the route
  itself. Caveat: from an office network in Israel, not from Cloud Run in me-west1 — the
  server-side Vertex numbers come with the server run once it is enabled.

## 4. Numbers

**Direct on staging — 22 turns (4 scenarios × 2), real product path**

| | Direct |
|---|---|
| Turns answered / errors / retries | 22/22 · 0 · 0 |
| Streamed | 22/22 |
| Web search worked | 2/2 search turns |
| First reply token, median (p90) | 3.38 s (5.97 s) — Intake turns 1.26 s · Plan turns 3.65 s · search turn 7.49 s |
| Full reply, median (p90) | 5.49 s (9.48 s) |
| Talker's own first token, median | 0.42 s (the rest is the Thinker before it) |
| Per call, median | Haiku 5.5 0.63 s · Sonnet 5.5 2.72 s · Sonnet 4.6 2.77 s |
| Tokens in / out | 97,646 / 9,146 |
| Cost (list price) | $0.29 total · $0.013/turn (Intake $0.0001 · Plan $0.013 · search turn $0.05) |

Most of a Plan turn's cost is the Thinker's web-search tool description (~3K input tokens on
every call, searching or not).

**Local A/B — the same request on both routes**

| Add-on · model | Calls | Direct total (first token) | Vertex total (first token) | Errors D / V |
|---|---|---|---|---|
| Talker · Haiku 5.5 | 4 + 8 | 1.11 s (0.50 s) · 0.96 s (0.61 s) | 0.98 s (0.78 s) · 1.40 s (0.74 s) | 0 / 0 |
| Talker · Sonnet 4.6 | 8 + 16 | 3.78 s (0.44 s) · 3.69 s (0.58 s) | 4.32 s (1.16 s) · 3.38 s (0.92 s) | 0 / 0 |
| Thinker · Sonnet 5.5, no web search | 16 | 3.19 s | 3.10 s | 0 / 0 |
| Thinker · Sonnet 5.5, **web search on** | 8 | 2.98 s | — | 0 / **8** (org policy) |
| Field Extractor · Haiku 5.5 | 7 | 0.64 s | 0.82 s | 0 / 0 |
| Summarizer · Haiku 5.5 | 1 | 2.92 s | 2.73 s | 0 / 0 |

- **First token is slower on Vertex:** 19 of 22 paired streaming calls, median **+0.31 s**,
  p90 1.11 s → 1.60 s. Whole-call time: talkers median +0.28 s; non-streaming Sonnet 5.5
  calls no measurable difference (−0.44 s median, noise).
- **First call per process is slow on Vertex:** warm-up 3.08 s vs 0.77 s Direct (Google OAuth
  token + TLS). The token is cached ~1 h, so it costs once per server instance per hour.
- **Tokens identical:** same input token counts on every paired request (21,128 / 21,128);
  output differs only by sampling. Usage rows say `anthropic` vs `anthropic@vertex`.
- **Output:** same structure and the same field values; wording differs as between any two
  runs: Direct vs Vertex word overlap median 0.61; two Direct runs of the same scenario on
  staging: 0.52.

**Vertex on staging (server mode): not run** — the server is not configured (section 1).
The command is ready; the same table then gets a Vertex column, plus "call routes seen" =
`vertex` proves no call went direct.

## 5. Implications beyond the numbers

| Topic | Direct (Anthropic API) | Vertex (Google) |
|---|---|---|
| **Model availability** | Every model on release day. | Claude models are GA in Model Garden, but **each must be enabled per project** (Opus 5.5 and Haiku 4.5 are not, today → 404). Every current Claude model is listed there (launch timing vs Anthropic not checked here); enabling + quotas per project are on us. |
| **Region / data residency** | No region choice for us; `inference_geo` exists on the Anthropic API but not on Vertex. | `global` (cheapest, no residency guarantee) · `eu` / `us` multi-region · specific regions. **No Claude in me-west1 (Tel Aviv)** — a bank that requires Israel-resident inference can't get it for Claude on Vertex; EU is the closest. Regional quotas start at 0 for the newest models (europe-west1 → 429). |
| **Features** (Vertex column per Anthropic's platform table) | Everything. | ✓ Messages, streaming, tool use, structured outputs, thinking/effort, **prompt caching**, token counting, citations, PDFs, 1M context. **Web search: basic version only, and blocked by our org policy today.** ✗ Web fetch, code execution, **Files API**, **Message Batches** (50 % off), Models API, MCP connector, Agent Skills, server-side refusal fallbacks, fast mode on Opus. For us: web search needs the policy change; legacy Aspect KB documents (Files API) already fail loudly on Vertex; we don't use batch / caching today (caching is available on Vertex when we do). |
| **Quotas / rate limits** | Our Anthropic tier, one org-wide limit. | Per project, per model, per region, per minute (requests + input + output tokens). Defaults now in place on `global`; raising them is a Google request per project — **every bank's own project starts from defaults or zero.** |
| **Billing** | Anthropic invoice, our card. | On the Google Cloud invoice of the project. Claude on the global endpoint = Anthropic list prices; regional / multi-region about +10 % (repo note 2026-11-17, re-check before quoting). **Google startup credits cover Gemini only, not Claude.** In a bank's own project, the bank pays Google. |
| **Who holds the keys** | An Anthropic API key in our env file. | No API key: a Google service account (`roles/aiplatform.user`) with Application Default Credentials. Access is IAM, auditable in Google Cloud logs; the bank can own and revoke it. |
| **Failure behaviour** | — | No fallback to Direct, ever (by design): a model not enabled, a missing env value, web search blocked → the add-on fails loudly on its run card. Embeddings, transcription and the simulated user stay Direct on both routes. |

## 6. Summary for the agenda (plain words)

- Claude through Google Vertex **works** in our staging cloud now — the Google quota block is
  gone. To turn it on for the staging server we need one permission and two settings (owner
  account) and a staging deploy.
- **Speed:** the customer sees the first word about **0.3 s later** on Vertex (up to ~0.5 s on
  slow moments); the rest of the reply takes the same time. The first call after a server
  start adds ~2 s once.
- **Cost:** same tokens, same price on the global endpoint (EU/regional ~10 % more). The bill
  moves from Anthropic to Google; our Google startup credits don't cover Claude.
- **Gaps:** Claude's web search is blocked by a Google organization policy until we allow it;
  two models (Opus 5.5, Haiku 4.5) must be switched on in Google's model catalogue; batch
  discounts, file uploads and web fetch don't exist on Vertex.
- **Location:** Claude isn't available in Google's Tel Aviv region. The choices are "global"
  or "EU" — worth knowing before a bank asks for data to stay in Israel.
- **Control:** no API key — access is a Google permission the bank can own, see and revoke.

## Server A/B after go-live (2026-11-27, Tasks session)

Staging went live on Vertex on 27.11. The role `roles/aiplatform.user` is on the lybi-server service account. `VERTEX_PROJECT_ID=lybi-staging` and `VERTEX_LOCATION=global` are set (revision lybi-server-00057). A project-level org policy allows `web_search` for the Claude models we use (the org default is `denyAll`).

The final run used all 4 scenarios × 2, through the staging server (`--tag=server-ab-final`):

| | Direct | Vertex |
|---|---|---|
| Turns answered | 22/22 | 22/22 |
| Same crew + transition / final fields | — | 22/22 / identical |
| First reply token, median (p90) | 3.07 s (5.05 s) | 3.81 s (5.32 s) |
| Talker first token, median | 0.46 s | 0.97 s |
| Full reply, median | 5.30 s | 5.41 s |
| Haiku 5.5 / Sonnet 5.5 / Sonnet 4.6 per call | 0.68 / 2.31 / 2.96 s | 1.14 / 2.56 / 3.29 s |
| Cost per turn | $0.0134 | $0.0123 |

**Open issue:** 4 Thinker calls (Sonnet 5.5 with web search) were still refused by the org policy 40 minutes after the policy was set, while 12 went through. This looks like the change still propagating; re-check before calling web search on Vertex done.
