# Hebrew & mixed-language verification

**Date:** 2026-08-11 · **What was checked:** do Insights and Data Chat work correctly when asked in Hebrew, and in mixed Hebrew/English?

## Why

These clients are Israeli retailers; Hebrew is the primary working language, and the schemas themselves hold Hebrew values (record types like `'מכירות'`, store and product names). Every prior verification pass in this session was English-only, which proves very little about the real usage. Mixed input is realistic too — users reach for the English word for a metric inside a Hebrew sentence.

```bash
node scripts/test-chat-regression.js --hebrew        # 12 chat questions (6 Hebrew, 6 mixed)
node scripts/test-insights-suite.js <dataset> hebrew # 2 Hebrew investigations per dataset
```

## Data Chat — 12 questions, 12 successes

| dataset | pure Hebrew | mixed HE+EN |
|---|---|---|
| hypertoy | ✅ 27 rows | ✅ 10 rows |
| zer4u | ✅ 56 rows | ✅ 6 rows |
| newdeli | ✅ 44 rows | ✅ 1 row |
| thestock | ✅ 1 row | ✅ 10 rows |
| zolstock | ✅ 93 rows | ✅ 10 rows |
| tevanaot | ✅ 111 rows | ✅ 111 rows |

**0 errors, 0 timeouts** — better than the English pass, which had 4 timeouts. `tevanaot` "revenue by store" timed out in English and returned 111 rows here, so those timeouts are phrasing-sensitive rather than fundamental.

### Numbers are identical to the English runs

| claim | Hebrew question returned | ground truth (SQL) |
|---|---|---|
| hypertoy בילו revenue ex-VAT | 10,596,621.78 | 10,596,622 |
| zer4u ירושלים-12 revenue | 3,219,303.26 | 3,219,303.26 |
| zer4u store count | 56 | 56 |
| newdeli עזריאלי completed orders | 227,890 | 227,890 |
| thestock total revenue ex-VAT | 774,094,991.01 | 774,094,991.01 |

**Correctness is language-independent.**

## Insights — figures correct, language was not

All Hebrew investigations produced reports with verified-correct figures (hypertoy total ₪111.9M, Lego 140,535 units, zer4u top-10 = 48.9% of ₪51.1M, תוספת לזר 806,127 units — all exact).

**Defect found: 4 of 6 Hebrew questions were answered in English.** The synthesize prompt never instructed the model to match the request language.

**Fixed** — an explicit LANGUAGE rule now requires every user-visible string to match the prompt's language, while keeping database values (store/product names) and ₪ untouched. Re-verified on hypertoy:

| | before | after |
|---|---|---|
| hypertoy #1 | Hebrew ✅ | Hebrew ✅ |
| hypertoy #2 | English ❌ | **Hebrew ✅** — *"סך הכנסות רשת היפר טוי: ₪111.9M ב-27 סניפים — בילו מוביל עם ₪10.6M (9.47%)"* |

## Outstanding

- **thestock, tevanaot and newdeli Hebrew runs pre-date the language fix** and still show English write-ups in their captured JSON. Their *numbers* were verified; only the language was wrong. Re-run those three to confirm the fix generalises.
- **tevanaot** hit one timeout on the Hebrew inventory question.
- **newdeli phrasing sensitivity:** English "average order value" returned ₪62.53 over 3.74M orders; the mixed-language version returned ₪62.66 over 3,653,151. The two phrasings resolved to different order populations (likely a different `status` filter). Neither is provably wrong, but the same question should not produce two populations — worth root-causing.
