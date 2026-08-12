# Insights accuracy — full-pipeline verification

**Date:** 2026-08-11 · **What was checked:** does an Aspect Intelligence report state numbers that are actually true?

## Method

42 real investigations — for each of the 6 datasets, the 3 system-proposed example prompts plus 4 hand-written cases (2 simple, 2 complex). For every report, the SQL it cites is re-executed independently, the authoritative aggregates are rebuilt from that fresh result, and **every figure displayed on screen** is compared against them.

```bash
node scripts/test-insights-suite.js <dataset> all     # run (writes suite-results-<dataset>.json)
node scripts/recheck-insights-suite.js                # re-verify without re-running investigations
node scripts/summarize-insights-suite.js [--full]     # render the report
```

Disabled datasets are enabled for the run and restored in a `finally` block. **Do not mutate dataset config while a run is in flight** — doing so killed two cases mid-run during this session and produced a false "3/7" result.

## Results

| dataset | cases | produced a report | errored | figures verified | matched |
|---|---|---|---|---|---|
| hypertoy | 7 | 6 | 1 | 26 | **26** |
| newdeli | 7 | 7 | 0 | 28 | 26 |
| tevanaot | 7 | 4 | 3 | 29 | **29** |
| thestock | 7 | 5 | 2 | 0 | — |
| zer4u | 7 | 6 | 1 | 19 | **19** |
| zolstock | 7 | 6 | 1 | 33 | **33** |
| **total** | **42** | **34 (81%)** | **8** | **135** | **133 (98.5%)** |

Baseline before this session's work: **21/42 reports (50%)**, 60 of 74 figures matched.

## Cross-checked against the client's own Qlik dashboard (hypertoy)

| figure | Aspect | Qlik | |
|---|---|---|---|
| Total sales incl. VAT | ₪131,801,440 | ₪131,801,440 | exact |
| Lego product family | ₪19,000,391 | ₪19,000,391 | exact |
| דמויות | ₪7,849,434 | ₪7,849,434 | exact |
| Branch totals (top 6) | all exact | | exact |

## Known-good spot checks (direct SQL)

| claim | reported | SQL |
|---|---|---|
| zer4u ירושלים-12 revenue | 3,219,303.26 | 3,219,303.26 |
| zer4u total / store count | ₪51.1M / 56 | 51,077,832 / 56 |
| zer4u top-10 store share | ₪24,978,277 = 48.9% | identical |
| thestock total revenue ex-VAT | ₪774M | 774,094,991.01 |

## Outstanding

- **8 errors**: thestock 2 and zolstock 1 zero-row (inventory / sell-through questions), tevanaot 3, hypertoy 1 timeout, zer4u 1 — the zer4u one is the measure-baseline guard *correctly* rejecting a fan-out.
- **2 mismatches**, both in one newdeli report, on branches whose names share a prefix (`עזריאלי חיפה` 7% off, `עזריאלי תל אביב (Egz)` 21% off). Not yet root-caused; see `docs/features/insights.md` § Known limitations.
