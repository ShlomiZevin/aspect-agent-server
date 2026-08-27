# Smart Replenishment

What to order, how much, and when — the first Aspect Module. See
[modules.md](./modules.md) for the framework it plugs into.

The client's BI already answers *what happened*. It has no concept of how long
a supplier takes to deliver, so it can never answer *when* — that gap is what
this fills.

---

## The one thing to understand first

**Only 2 of ZolStock's 446 suppliers have catalogue coverage you could
actually order against** (`ב.א. זול סטוק והפצה בע"מ` 83.5%, `ארכיון ב.א`
58.3%). Thirteen more have a token handful — often 1 item of 16,648. Measured
by the audit, 2026-08-27.

That is not a defect to fix in code; it is the shape of the delivered data,
and it means this ships as a one- or two-supplier pilot until the client
extends SKU coverage. The full gap list, in plain Hebrew for forwarding:

```bash
node scripts/run-replenishment-audit.js zolstock --format=hebrew
```

---

## Where the numbers come from

```
NIGHTLY (inside the reload that already runs, into the shadow schema)
  27.5M fact rows  ──▶  mv_replenishment_base   one row per SKU (~14.8k)
                        mv_suppliers            one row per supplier

REQUEST TIME
  read ~15k prepared rows  ──▶  engine (pure arithmetic)  ──▶  answer
```

**Aggregate nightly, compute on read.** The heavy scan happens once a night;
request time is a small indexed read plus simple arithmetic. Freezing the
*result* into a daily snapshot instead would mean a buyer editing a supplier's
lead time sees no change until tomorrow — and the lead time is the one input
they own.

(The future proactive-alerts phase *does* want a stored daily digest: one that
is sent and must not be sent twice. That is a different artefact, and the
engine being a plain function over stored settings is what makes it cheap to
add.)

---

## The calculation

```
velocityDaily = qtySold{window} / window
netAvailable  = onHand + onOrder − committed
safetyStock   = catalogue value, else ceil(velocityDaily × safetyDays)
reorderPoint  = velocityDaily × leadTimeDays + safetyStock
daysOfCover   = max(0, netAvailable / velocityDaily)
orderByDate   = dataThrough + (daysOfCover − leadTimeDays)
targetStock   = velocityDaily × (leadTimeDays + reviewDays) + safetyStock
orderQty      = carton-rounded max(0, targetStock − netAvailable)
status        = overdue | due_soon | ok | no_demand
```

`modules/replenishment/engine.js`. **Pure**: `today` is a parameter and
omitting it throws — the feed lags the calendar, so a window measured from
"now" is silently wrong. The stock source is passed in, never hardcoded to
"warehouse", which is what makes the later per-branch grain a new caller
rather than a second implementation.

**Every output row carries its own working**: each input, where each
parameter came from (`supplier` / `dataset_default` / `computed`), and
`notes[]` — the single place every caveat is worded, so the screen, the chat
tool and the report quote the same sentence instead of inventing three.

### Eight named edge cases

Each is a real property of this data and each has a named assertion in
`scripts/test-replenishment-unit.js`:

| Case | Behaviour |
|---|---|
| Zero velocity, stock on hand | `no_demand`, qty 0, described as **idle stock** |
| Zero velocity, zero stock | **excluded** — there is no decision to make |
| Negative availability | **reported, never clamped** (one store carries −802,918 units) |
| No carton size | no rounding, and a note saying so |
| SKU not in the catalogue | included, flagged, **no invented cost** |
| First sale inside the window | pace over days-since-first-sale, thin history flagged |
| Nothing sold recently | `no_demand` even with a non-zero 365-day figure — dormant, not slow |
| Lead time inherited | source recorded and stated **every time** |

**Quantity may be negative; time may not.** Dividing a negative position by a
slow item once produced *"stock covers −5,400 days, this order should have
gone out on 2011-08-15"* on the real screen — implied by the formula, useless
as a statement. Cover is clamped at 0, so the same row reads "already out,
91 days late", which is true and actionable.

---

## Surfaces

All three read the same engine, so the numbers cannot disagree.

**Client page** — `/intelligence/:datasetId/purchasing`. Three tabs sharing
one anatomy: tiles → supplier rows expanding into item rows → a *"How we
calculated this"* trust panel on every leaf. Purchasing is live; Warehouse and
Branches are visible but phase-gated, each saying in plain words what it will
show and what is missing. The nav item appears only when the module is live.
Both locales, RTL verified.

**Chat tool** — `fetch_replenishment`, structured args, **never generated
SQL**. The same question asked five different ways returns identical numbers;
that invariance is the entire reason it is a tool and not a prompt. The result
carries a data contract the talker may rephrase but not drop.

**Intelligence report** — PLAN gains a `replenishment` category, offered only
when the module is live. Its rows come from the engine instead of NL→SQL;
everything downstream is untouched. The `sql` field says *"Not a SQL query"*
and explains where the numbers came from — the detail page renders that field
as "the SQL that produced this", and a fabricated query there would be a lie
in the one place the product exists to be checkable.

---

## Settings and the resolution chain

**supplier override → dataset default → code constant**, every value tagged
with the level it came from. The tags are not bookkeeping: the screen says
"90 days — you set this" versus "90 days — default, set it", and a buyer who
cannot tell those apart cannot judge the recommendation built on them.

Per-supplier overrides live in `supplier_settings` (migration 041) in the
**platform** DB. Every column is nullable on purpose — NULL means "not set"
and falls back, which is how a buyer *un-sets* a lead time. A deliberate `0`
is still a real value.

---

## Limitations to carry into every surface

1. **No goods receipt anywhere in the feed.** Lead time can never be measured,
   only entered; an order placed long ago still looks open, so supply is
   over-counted and the system **under-orders**. The largest correctness
   threat, and it is declared `absent` in the dataset manifest with
   high-precision refusal triggers.
2. **Inventory is an undated snapshot** — demand comes from sales only.
3. **Only ~5% of items carry a SKU** — the rest can be seen in sales but can
   never receive a recommendation.
4. **No money in the fact data** — every value is derived from list prices at
   18% VAT, excluding discounts.
5. **The last delivered day can be partial** — every answer carries a
   data-through date.
6. **No MOQ / order calendar / container constraints** — carton rounding only.

### And one that is not a data limitation

With the 90-day default lead time, **about half the catalogue reads as
overdue** (4,568 of 9,275 at first measurement). That follows from the
default, not from a fault: at 90 days you must order three months ahead, so
anything without a large buffer is already late. It is the feasibility
brief's alert-fatigue risk with a number attached. Real per-supplier lead
times are the condition under which the list means anything, and the eventual
push phase must cap the digest.

---

## Testing

| Script | Needs | Covers |
|---|---|---|
| `test-replenishment-unit.js` | nothing | the engine, all eight edge cases, determinism |
| `test-replenishment-render.js` | nothing | binding validation, identifier safety, the ZS-2 correctness rules in the emitted SQL |
| `test-replenishment-probes.js` | live DB | builds real views, then proves **each probe can fail** against a deliberately mis-mapped binding |
| `test-replenishment-api.js` | live DB | the read path, the live gate, filters, summaries |
| `test-replenishment-chat.js` | live DB | tool registration, the five-ways invariance, refusals in both languages |
| `test-replenishment-insights.js` | live DB | the report seam |
| `run-replenishment-audit.js` | live DB | the A1–A12 measurements + the Hebrew gap report |
| `run-module-init.js` | live DB + LLM | a real init run end to end |

**A probe suite that cannot go red is worse than none** — it manufactures
confidence. `test-replenishment-probes.js` exists to prove these can.
