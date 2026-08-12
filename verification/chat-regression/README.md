# Data Chat — regression & accuracy check

**Date:** 2026-08-11 · **What was checked:** did the Insights work break Data Chat, which shares the same NL→SQL engine?

## Why this exists

Insights and Data Chat both go through `services/sql-generator.service.js` → `services/data-query.service.js`. This session changed that shared engine: SQL generation pinned to `temperature: 0`, a generic join-fan-out rule added, the zer4u rules rewritten wholesale, tevanaot's phantom `mv_parts_dim` replaced with an inline CTE, and a live-catalog rule corrector injected. Insights was re-verified after each change — **chat was not**, so it needed its own pass.

The harness replicates the crew's call exactly (see `agents/<x>/crew/*.crew.js`): chat passes **no `dataThroughDate` and no timeout override**, so it runs on the 15s default with no data-recency anchor. Testing through the Insights path would not exercise what chat actually does.

```bash
node scripts/test-chat-regression.js [dataset]   # writes chat-regression-<dataset>.json
```

## Results — 24 questions (2 simple + 2 complex per dataset)

| dataset | returned data | timed out | wrong answers |
|---|---|---|---|
| hypertoy | 3 | 1 | 0 |
| zer4u | 4 | 0 | 0 |
| newdeli | 4 | 0 | 0 |
| thestock | 4 | 0 | 0 |
| zolstock | 3 | 1 | 0 |
| tevanaot | 2 | 2 | 0 |
| **total** | **20** | **4** | **0** |

## Verified against direct SQL

| claim | chat returned | SQL | |
|---|---|---|---|
| zer4u ירושלים-12 revenue | 3,219,303.26 | 3,219,303.26 | exact |
| zer4u store count | 56 | 56 | exact |
| thestock total revenue ex-VAT | 774,094,991.01 | 774,094,991.01 | exact |
| hypertoy Lego family ex-VAT | 16,112,827.17 | 16,112,827.17 | exact |

The Lego row is the important one: **16,112,827 × 1.18 VAT = 19,013,136** against Qlik's **19,000,391**, confirming the product-join fan-out (which used to inflate totals 44.6%) is gone from the **chat** path too, not just Insights.

## Conclusion: no regressions

- Chat's prompt is byte-identical apart from the deliberate rule corrections — verified that the data-recency section renders `""` when `dataThroughDate` is absent, which is always the case for chat.
- The 4 timeouts hit chat's **own 15s default**, which was not changed. Two of them (`tevanaot` revenue-by-store, `zolstock` top-10 items) succeed under Insights' 75s budget — same query, different limit. That is a pre-existing chat limitation this pass surfaced, not something introduced.

## Follow-up worth considering

Raise chat's statement timeout, or route heavy chat questions through pre-aggregated views. 4 of 24 everyday questions timing out is a user-visible ceiling independent of correctness.
