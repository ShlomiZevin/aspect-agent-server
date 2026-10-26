# Fewer database queries per turn (task #914)

**What was checked:** that cutting the database queries of a customer turn
changes nothing the customer sees or the system stores — on a real agent with real
conversations — and how many queries it saves.

**Result (2026-10-25):** identical on all 30 turns · **45.0 → 29.8 queries per turn (−34%)**.

## The changes

| Change | Where | Saves per turn (Noa's agent) |
|---|---|---|
| Memory save writes directly (UPDATE, INSERT if no row) instead of reading the row first | `builder/runtime/builderMemory.js` `saveMemory` | ~8 (one per add-on) |
| History read once per turn phase, not once per add-on (memo reset when the reply is written) | `builder/runtime/historyService.js`, `ctx.historyCache` in `BuilderRunner.js` / `addonRunner.js` | ~3.6 |
| Agent setup in 2 queries, not 4 (agent+project+version joined; crew+version joined) — always fresh, no cache | `builder/services/builderProjects.js` `resolveRunnable` | ~2.5 (more on cascades) |
| Conversation row read once in the chat route and handed to the runner | `builder/routes/runtimeRoute.js`, `BuilderRunner.runOnce({ convRow })` | 2 |

Considered and **not** done: remembering the customer's user id (1 query; a user
deleted in Admin → Users and logging in again would have hit a stale id), caching
the agent setup in memory (stale across instances after an edit), batching the
add-on trail inserts (changes failure and cleanup order). The original map of all
queries and the options: `turn-query-map.html`.

## How it was proved

1. **Record** — the old code, against the staging database (`lybi-staging-db`), real
   models on staging keys: 3 account-opening conversations × 10 customer messages
   (`conversations.json` — messages from production simulations of Noa's agent).
   Every model call's exact input and answer saved (167 calls).
2. **Replay, old code** — same messages, model answers from the recording; a model
   call whose input differs in any way stops the run (a "replay miss").
3. **Replay, new code** — the same.
4. Compare: every SSE event the customer's screen receives (turn-level in order;
   each add-on's own events in order — parallel add-ons finish in any order), the
   reply text, the stored messages, the conversation's memory, the conversation
   row, and every add-on trail row. Ids, times and token counts are ignored.

| Comparison | Result |
|---|---|
| Recording (real models) vs old-code replay | IDENTICAL — `compare-real-vs-replay.txt` (the method has no noise) |
| Old-code replay vs new-code replay | IDENTICAL, 0 replay misses — `compare-before-after.txt` |
| Queries per turn, old | 45.0 avg (35–69) — `queries-before.txt` |
| Queries per turn, new | 29.8 avg (24–43) — `queries-after.txt` |

Covered: history modes `all` and `none`, 8 crew transitions including cascades
inside one turn, parallel add-on steps in both lanes. Not used by this agent —
`last_n`, `since_summarizer`, `since_transition` — so the memo for every mode is in
the offline battery `scripts/test-turn-queries.js` (19 checks).

Other batteries after the change: `test-error-center` 47/47, `test-load-tests`,
`test-simulation-jobs` ALL PASS, `test-builder-mcp` ALL PASS.

## Reproduce

```bash
# from this folder; needs .env.production.staging and this machine on lybi-staging-db's allow-list
MODE=record CASSETTE=$PWD/tape.json QLOG=$PWD/q-A.jsonl node replay-server.js   # old code; costs ~$5 of model calls
node replay-drive.js run-A.json 3100 10
MODE=replay CASSETTE=$PWD/tape.json QLOG=$PWD/q-B.jsonl node replay-server.js   # $0
node replay-drive.js run-B.json 3100 10
node cmp914.js run-A.json run-B.json
node qcount914.js run-B.json q-B.jsonl --detail
```

Raw runs (`run-*.json`, `q-*.jsonl`, `tape.json`) and `conversations.json` are not in git
(`verification/` ignores JSON). `conversations.json` = `[{ id, msgs: [customer messages…] }]` —
the customer messages of 3 account-opening simulations on origin (conversations 4663, 4646, 4655).
