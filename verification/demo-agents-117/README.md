# Demo agents: table requests and speed (task #117)

**What was checked.** Itzik reported two things. When he asks for a table, the chat asks him a question back. And "the agent is slow". We replayed his real session from 2026-11-15 (Aspect demo, TechZone) and the ZolStock case from 2026-11-11 through the real chat path (`runChatTurn`) after the prompt changes.

**Reproduce.** Start the Cloud SQL proxy, then run:

```
node scripts/replay-demo-agents-117.js <label> [scenarioIdx,...]
```

The script writes `replay-<label>.json` into this folder.

## Before (production logs, 2026-11-15 session)

- **Turn time.** A normal turn took 25-36 s. One turn ("תתקן את זה") took 378 s: 12.5k output tokens and 5 `present_table` calls.
- **Tables written twice.** The model wrote each table two times: once in the reply text and once as `present_table` rows. Often it skipped the text copy and wrote "the table is below". In the chat that is only a button, so the user saw no table.
- **Questions at the end.** Every reply ended with "רוצה ש...?", because the prompt required a CTA.
- **Wrong tool.** "כן" (an offer to show stock value) called `get_finance_report` and showed the balance sheet.
- **ZolStock.** "top 10 best-selling items" got the reply "products or salespeople?". The `top sellers` ambiguity rule was applied to a phrase it does not cover.
- **Aspect fashion.** The crew runs from an active Crew Editor version, "Faster" (crew_prompts id 104), which pins **gpt-4o**. That is below the Terra floor.

## Changes

- **`present_table` removed** from the three demo crews (technology, fmcg, fashion). The model writes the table once in the reply. The client already turns every markdown table into the full-table viewer with Excel export (`parseMarkdownTables`). This also works when an old conversation is reopened.
- **Statement instead of question.** The CTA is now one next step written as a statement, not a question. A table request is answered at once, using defaults. Short follow-ups ("כן", "בטבלה", "תתקן") carry out the previous offer.
- **Finance tool scope.** In technology, stock per product, SKU or branch is no longer routed to `get_finance_report`.
- **ZolStock ambiguity rule.** `renderForCrew` now says that a question naming products ("best-selling items / products / models") is not ambiguous.
- **Migration 069.** It deactivates the gpt-4o fashion version. **It has not been run yet.**

## After (replay-after.json, replay-fashionfile.json)

| Crew | Question | s | Model | Table | Ends with "?" |
|---|---|---:|---|---|---|
| technology | איזה מוצר נמכר הכי הרבה? | 16.5 | terra | - (single answer) | no |
| technology | תן לי בטבלה | 8.3 | terra | yes | no |
| technology | תוסיף לי אחוז המכר | 8.9 | terra | yes | no |
| technology | כן | 10.1 | terra | yes (was: balance sheet) | no |
| technology | תבנה טבלה עם עשרת המוצרים... | 14.1 | terra | yes | no |
| technology | אילו מוצרים כדאי להעביר בין סניפים? | 25.4 | terra | yes | no |
| technology | תסדר את זה בטבלת ההעברות | 21.0 | terra | yes | no |
| technology | תן לי דוח רווח והפסד לחודש האחרון | 8.1 | terra | finance card | no |
| technology | Which products sell the most? Give me a table. | 10.6 | terra | yes (English) | no |
| fmcg | טופ 10 מוצרים נמכרים החודש | 19.8 | terra | yes | no |
| fashion (DB version, gpt-4o) | Top 10 best-selling items this month | 5.1 | gpt-4o | yes | **yes** |
| fashion (file prompt = after 069) | Top 10 best-selling items this month | 13.3 | terra | yes | no |
| fashion (file prompt = after 069) | תן לי טבלה של 10 הפריטים... | 24.0 | terra | yes | no |
| ZolStock | What are the top 10 best-selling items this year by quantity? | 23.6 | terra | yes (was: clarifying question) | no |

Teva Naot was not changed. A live smoke test on 2026-11-17 took 13-16 s per question, and tables came back with no questions.
