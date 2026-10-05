# superhist quick-question tiles (task #97)

The CEO of The Social Supermarket reviewed the 12 Data Chat tiles. Each tile's
question was run through the real NL->SQL engine (`DataQueryService.queryByQuestion`,
same call shape as `scripts/test-chat-regression.js`) before and after the rule
changes in `services/schema-rules/superhist.rules.js` (RULE 7, 7a, 7b).

- `tiles-before.json` - all 12 tiles, rules as of 2026-10-04
- `tiles-after-rules.json` - tiles 2, 3, 5, 10 + the new "delayed deliveries" tile (13)

| # | tile | before | after |
|---|---|---|---|
| 2 | slow-moving 100 | stock>0 only, ranked by lifetime units | open for sale + stock>0, ranked by last-90-day units |
| 3 | waiting for courier | order_status OR display_status (11.8k) | display_status only (9.7k); no city in data |
| 5 | subsidy | net SUM only (2.94M) | positive 4.62M / negative -1.68M / net 2.94M |
| 10 | cancellations + credits | both status columns | display_status 'זוכה חלקית' 7,579 orders; no cancel status in export |
| 13 | delayed deliveries (new) | - | display_status waiting, 10+ days: 9,106 orders |

Data-side findings (not fixable here, sent to the client's BI): fruit-and-vegetable
box 1050394 has cost 0 in the export (7,500 lines, 1.09M revenue); 22 sold items
have no name and no cost; 'ממתין לשליח' is never refreshed on old orders
(9,087 of 9,730 are older than 10 days); no customer city; no cancelled status
and no credited amount; history starts 2026-01-01.

Reproduce: proxy on 5433, then the scratch runner logic above (12 tile texts from
`GET /api/insights/superhist/quick-questions`).
