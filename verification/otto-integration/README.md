# Otto → Intelligence integration — verification record

What was checked when the feature was built (2026-09-14/15, branch
`vl_us_otto_intelligence_integration` on both repos), and how to reproduce
each check. Spec: `tasks/pending/otto-intelligence-integration.md`; feature
doc: `docs/features/otto.md`.

## How to reproduce

```bash
# server repo
node scripts/test-otto-unit.js               # offline battery, no DB/LLM
node scripts/test-modules-unit.js            # framework regression
node scripts/test-insights-unit.js           # neighbor regression
node scripts/test-replenishment-unit.js      # neighbor regression
node scripts/test-otto-knowledge.js zolstock # audit + stored-brief re-validation (DB, no LLM)
node scripts/test-otto-e2e-dry.js zolstock   # FULL pipeline, real data, ZERO writes (3 LLM calls)
node db/migrations/run-054-custom-screens.js # migration (idempotent)

# client repo
npx tsc -b && npx eslint src/components/intelligence/Apps/custom \
  src/services/ottoService.ts src/types/otto.ts
npm run build
```

## Results

| Check | Result |
|---|---|
| `test-otto-unit.js` (grammar, brief/plan/spec validation, compiler SQL, probes, progress monotonicity, descriptor, shelf byte-identity) | **80/80** |
| `test-modules-unit.js` after registering module #5 | **52/52** (unchanged) |
| `test-insights-unit.js` | **53/53** (unchanged) |
| `test-replenishment-unit.js` | **125/125** (unchanged) |
| Migration 054 on the platform DB | applied (additive `CREATE TABLE IF NOT EXISTS` only) |
| `test-otto-knowledge.js zolstock` (audit-only) | 15 relations, manifest present, `facts` (~34.6M rows) correctly flagged heavy |
| Server boot with the new module + routes | clean — registry validated the descriptor, `/api/otto` mounted, no errors |
| Client `tsc -b` | clean |
| Client eslint on all new/touched files | clean (2 pre-existing `IntelligenceShell` errors also present on master) |
| Client `npm run build` (production) | clean, 14s |
| `test-otto-e2e-dry.js zolstock` (knowledge → plan → Opus spec → real queries → probes) | **PASSED**, 138s — brief: 8 matview sources / 38 fields / 9 caveats, round 1, 48/48 probes; plan "Low Stock Alert" (6 cols, 1 filter, 2 KPIs); Opus spec = noteLine + kpiCards + filterBar + dataTable + actionsBar in 9s; execution: 500 rows (capped), KPIs 218,320 below-safety rows / ~8.44M units, 4/4 build probes. Log: `e2e-dry-zolstock.log` |

## What the real runs caught (fixed during verification)

1. **`information_schema.columns` omits materialized views.** The audit
   handed the model matviews with zero columns; it guessed plausible names
   (`qty_sold`, `row_date`) and structural validation rejected three rounds
   straight. Audit and verify now read `pg_attribute` (covers `r`/`v`/`m`).
   This is exactly the class of bug the dry run exists to catch before a
   client does.
2. **Hebrew labels are token-expensive.** Three separate truncation hits on
   real runs: the knowledge pass (6000 → 16000 output tokens), the plan
   (2000 → 5000) and the spec headroom (6000 → 12000) — each showed as
   "invalid JSON" cut mid-array, the exact signature to look for if it
   recurs.
3. **The brief's prompt budget was set too tight.** A real zolstock brief
   renders at ~6.3k chars; the 6k probe failed a perfectly good brief.
   Budget now 9k, and the failure detail names the levers (drop fields,
   shorten descriptions) so a feedback round is actionable.

## Deviations from the spec, stated honestly

- **ProcurementPage was not refactored onto the shared blocks** (task §02.2
  planned an extraction with a pixel-identical gate). The pre-implementation
  survey found its table is a hand-synchronized CSS-grid with no column-def
  abstraction and 15-prop domain rows — an extraction is a redesign, not a
  move, and doing it blind (no visual regression tooling here) risked the
  live Procurement module. The catalog components are NEW, styled on
  Procurement's visual language and the shell's `--ai-*` tokens; Insights'
  `InsightChart` is reused as-is for the chart block. Unifying Procurement
  onto `dataTable`/`kpiCards` remains open as a follow-up task.
- **Catalog-coverage scenario list** (task §09) is folded into the starter
  prompts + the e2e request rather than a separate 15-scenario document —
  to be expanded when the first real client requests land.

## Not verified here (needs the owner / a browser)

- The manual M1→M5 walk in a browser, EN + HE (needs `npm run dev` + the
  local server + the `otto` module enabled for a dataset via the admin tab).
- The init pipeline through the admin Modules tab (enable → init → progress
  polling) — exercised only via its unit-tested pieces and the dry run's
  equivalent calls; no module row was created in the shared platform DB
  without the owner's go-ahead.
- Build-cost realities (Opus spec latency) beyond the dry run's single
  measurement.
