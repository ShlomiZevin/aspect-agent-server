# Real-estate developer demo — verification (2026-11-24)

**What was checked:** the Ofek Development demo agent (`agents/realestate/`) on the
seeded `realestate` schema, through the real chat path (`runChatTurn`, in-process),
with the questions the demo will be driven with — the presenter's list (leads,
conversion, regions / rooms / size, segments and benefits, lead source, buyer
profile, purchase purpose) plus the "wow" moments (who to call today, availability
board, stuck units, sell-out forecast, discount leakage, Haifa conversion drop).

**Reproduce** (Cloud SQL Proxy on 5432 + 5433):

```bash
node scripts/seed-realestate-synthetic.js            # (re)build the schema — dates end today
node scripts/test-realestate-demo.js <label> [idx,...]
```

Raw runs: `replay-<label>.json` (gitignored like other raw runs).

## Findings the data holds (seed `--dry` and the views agree)

| Finding | Figure |
|---|---|
| Cost per deal by source | signage ₪2.9K · portals ~₪4.8K · referral ₪7.5K · Facebook ₪63K · Instagram ₪104K |
| Rep over-discounting | רונן לוי 7.40% vs 4.37% company avg → ₪12.77M above average |
| Slow first call-back | אלון ברק median 1,379 min → 1.14% conversion; Haifa 4.5% → 1.6% after May 2026 |
| Overpriced stuck units | Haifa 5-room north: 13 of 14 unsold for 646 days at +13–21% vs comparable sales; 48 recent leads want 5 rooms |
| Benefit per segment | first home + 20/80 58.7% (vs parking 11.3%) · investors + price cut 61.7% · for-children + parking 60.0% |
| Sell-out forecast | Haifa at 1.0 unit/month → 2029-06, 21 months after delivery |

## Runs

| Run | Result |
|---|---|
| r1 | 3 questions; call-today table had 14 half-translated columns; board OK |
| r2 | 13 questions; **call-today failed** (schema description cached with pre-rename columns) and **board returned empty** (model looped on `building=1` to the tool-iteration cap) |
| fixes | seed regenerates the cached schema description; board tool lost its `building` parameter (one call = whole project); Hebrew label words added to table-format |
| r4b1, r4b2 | board 11s, 1 call, correct reply; call-today 35s, correct — twice each |
| r5 | full 13: **13/13 answered**, one tool call each, 11-45s. Two weak: stuck units ordered by project name first (led with Negev, not Haifa); "why did Haifa drop" compared unripe recent leads |
| fixes | rule: stuck units ordered by premium, never project first; new `v_conversion_monthly` (ripe monthly cohorts + reps + call-back speed) for "why conversion changed" |
| r6, r7 | stuck units leads with Haifa 5-room (+12.6-20.8%, 646 days, 48 leads); Haifa drop explained by the handover מיכל אברהם → אלון ברק (30 min → ~24h call-back, 4.76% → 1.88%), 23s |

## Intelligence suggested reports (bootstrap, Hebrew)

All 5 generated; each headline is one of the planted findings above (discounts ₪12,770,955;
benefit per segment; אלון ברק 1.14%; 137 stuck units, Haifa +10.55%; signage ₪2,909 vs
Instagram ₪103,600 per deal).
