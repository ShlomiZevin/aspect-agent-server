# superhist — acceptance before the client sees it

**Ran 2026-09-02, against production after the first load. 19/19 passed.**

```
node verification/superhist-acceptance/run-acceptance.js
```

Every question goes through the REAL chat path (`runChatTurn`), and every figure
in the answer is checked against a value the runner computes itself in SQL. An
agent that returns a confident wrong number is worse than one that fails, so
"it replied" is not a pass — the number has to match. Numbers are compared by
their digits, so `8,421,009`, `8421009` and `₪8.42M` all count as the same
answer.

## Ground truth at the time of the run

| | |
|---|---|
| orders | 19,062 |
| members | 15,881 |
| repeat members | 2,508 |
| order total (with shipping) | ₪8,438,893 |
| product revenue | ₪8,421,009 |
| subsidy | ₪511,647 |
| units | 822,404 |
| distinct items sold | 1,481 |
| period | 2026-07-01 → 2026-08-11 |

## What is checked

| group | checks | what it defends |
|---|---|---|
| headline figures | 11 | revenue, orders, members, repeat rate, subsidy, top product, payment method — each against SQL |
| refusals | 4 | category, margin and store questions decline and say why, in both languages, without handing over a fabricated table |
| partial month | 2 | August stops on the 11th; a July-vs-August comparison must disclose that rather than report a 79% collapse |
| shipping rows | 2 | item answers filter `line_kind = 'product'` — the item count is 1,481, not the 3,202 you get by counting the item column across every row |

## Two checks that were wrong, not the agent

Worth keeping, because both were the test being wrong about what a right answer
looks like:

- **Payment method.** The stored value is Hebrew (`כרטיס אשראי`) and the
  question was asked in English, so a correct answer translates it — the crew
  mirrors the language it was asked in. The check demanded the stored string
  back. It now accepts either.
- **Store refusal.** "There are no stores or branches to compare — the Social
  Supermarket operates exclusively online" is a perfect refusal and matched none
  of the wordings the check first listed. Refusals are now judged by substance:
  does it decline, does it say why, and does it avoid handing over a ranked
  table where an explanation belongs.

## Not covered here

**Insights narratives.** The investigation pipeline runs end to end (~86s) and
its verify step does real work — it caught the model claiming "8 complete weeks"
over six weeks of data and forced a regeneration. But the one investigation run
for this pass produced a headline whose two figures (181,286 and 55,768 units)
reconcile to no weekly total in the data; the analysis appears to sum a selected
subset of items and then describe it as the whole. Chat is verified; report
narratives are not, and should not be shown to the client until they are.

Cleanup is automatic: the runner deletes its own conversations, so nothing it
creates is left in the store anyone else reads.
