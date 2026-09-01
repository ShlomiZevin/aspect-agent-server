# Builder V2 — Triggers (Proactive)

> **Status:** BUILT and verified (2026-08-31) — T1 to T5. The proactive
> turn, the trigger primitive with the Silence type, the clock, the
> Triggers screen, live push, and the Alfred registrations.
>
> **Not yet done:** create the Cloud Scheduler job (one per minute →
> `POST /api/admin/triggers/tick`) and switch the clock on. Until then
> nothing fires by itself — which is the correct default for a feature
> that messages real customers. Locally, set `TRIGGERS_CLOCK_LOCAL_SEC`
> in `.env` instead of deploying anything.
>
> Real behaviour is verified through the builder UI. The only scripts
> left are offline checks that touch nothing: the Silence rule arithmetic,
> the clock, the cross-instance push, and the Alfred wiring.
>
> **Read first:** [BUILDER_V2.md](./BUILDER_V2.md) for the data model,
> [BUILDER_V2_RUNTIME_PLAN.md](./BUILDER_V2_RUNTIME_PLAN.md) for the
> runtime, [BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md) for the addon
> contract this deliberately does **not** use.

---

## What this is

Everything in V2 today is **reactive**: a user message arrives, the
agent cortex runs, the crew's chain runs, a reply streams back. Even
the offline lane and the Live Brain / Profiler panels are turn-driven —
they just run *after* the reply.

**Triggers** make the agent act with no user message at all. A trigger
watches for a condition across an agent's conversations; when it
matches one, it launches a crew's chain on that conversation. The chain
may speak (the customer gets a message) or deliberately stay silent
(think, write memory, hand off) — both are valid outcomes.

The first trigger type is **Silence**: *the customer hasn't said
anything for X.*

---

## The core distinction — a trigger is NOT an addon

This is the load-bearing decision. An earlier draft modelled triggers
as a new addon lane; it was wrong, and the reason is worth stating
plainly because it shapes everything else.

|  | Addon | Trigger |
|---|---|---|
| Scope | one **conversation** | one **agent** |
| Runs | inside a turn | once per clock tick |
| Input | that conversation's memory + history | the agent's conversations |
| Output | text / JSON / a transition | **a set of conversations** |
| Cost | proportional to turns | proportional to **fires**, not conversations |

An addon is handed a conversation. A trigger has to *find* them. Its
output isn't content, it's a selection. Forcing that into
`AddonInstance.run(ctx)` bends the primitive to fit a container it
doesn't belong in.

**What a trigger launches, however, IS ordinary.** The proactive turn
is a normal turn that happens to have no user message — same engine,
same `addon_runs`, same memory writes, same SSE events. All the novelty
lives in the selection half.

---

## Where it sits — the third agent-level surface

There is already a precedent in the codebase for "agent-level, id'd
array in the agent body, own screen, own dispatcher, not an addon":

| Surface | Body key | Screen | Driven by |
|---|---|---|---|
| Live Brain | `agent.liveBrain.panels[]` | Live Brain | a turn |
| Profiler | `agent.profiler.panels[]` | Profiler | a turn |
| **Triggers** | **`agent.triggers[]`** | **Triggers** | **the clock** |

Same pattern, one axis different. Live Brain / Profiler panels reuse
`addonRunner` for their LLM calls without being addons; triggers reuse
the runtime for their proactive turn without being addons.

**Naming:** the screen is **Triggers**, not "Proactive". A trigger is
the primitive (something watches, something fires); *proactive
messaging* is what this first one does with it. A later trigger could
write memory, call a webhook, or escalate to a human without any of
those being "proactive".

---

## The clock

**System level, one instance, not per agent.**

The clock does not know what any trigger means. Every minute it asks
each agent's enabled triggers "who's due?", and fires what comes back.

- **One Cloud Scheduler job**, 1 minute, mirroring the existing
  `data-loader-tick` precedent (`POST /api/admin/scheduler/tick` →
  `services/scheduler-tick.service.js`). New job, new endpoint —
  don't piggyback, so it can be paused independently.
- **Cloud Run runs 1–3 copies** of the server (`deploy.sh`:
  `--min-instances 1 --max-instances 3`). A `setInterval` inside the
  process would fire on every copy. One scheduler job means one call;
  the tick additionally claims a short **DB lease** (one atomic
  conditional upsert) so two copies can't sweep at once.

  *(The plan said `FOR UPDATE SKIP LOCKED` per conversation. Building it
  showed a lease is the right tool: a row lock is session-scoped and
  would have to hold a pooled connection open for a sweep that makes LLM
  calls and can run minutes. A lease needs no held connection and
  expires on its own if a copy dies mid-tick.)*

- **Two guards, and only one is authoritative.** The lease stops
  overlapping *work*. What stops a customer being nudged **twice** is the
  event log: the first fire writes a `trigger_events` row and the
  spacing clause refuses another attempt inside the window — whether the
  second sweep came from the clock, Step once, or Run now. The lease is
  a cost guard; the event log is the correctness guard.
- **Why not per-agent cadence:** the interval doesn't decide when
  anything fires — each trigger does. It only decides how *late* a
  fire can be. A per-agent knob would only configure sloppiness.
  What the author actually wants is visibility ("next fire in 14 min"),
  and that's on the trigger card.
- **The tick interval is the precision floor of every trigger.** State
  this in the admin UI. A 5-minute clock cannot honour "after 1 minute
  of silence."

### Admin surface — built

The V2 admin is **per-agent** at `/:agent/builder/admin`. **There is no
cross-agent admin.** A **Triggers** tab sits next to Conversations:

- the clock control — the same component the Triggers screen uses, so
  the two can never disagree about what the switch says
- a per-rule heartbeat: on/off, when it last looked, whether anyone
  qualified. This exists because *"working, nobody is quiet"* and
  *"broken"* look identical from the outside
- an **agent-wide** activity feed, newest first, filterable by outcome

Agent-wide rather than per-trigger on purpose: one rule firing far more
than expected only stands out when they sit side by side. The
per-trigger history stays on the authoring screen, where you are
thinking about one rule at a time.

Non-sending outcomes are in the list, not hidden — *"it fired 40 times
last night and said nothing every time"* is a bug you can only see if
the quiet outcomes are shown.

The clock control is repeated here rather than linked to. The moment you
notice something wrong is the moment you need to stop it, and making
someone navigate first is a design that only fails when it matters.

**Where the clock is configured:** here, and on the Triggers screen.
It is system-wide, so it is the same switch on every agent — there is no
separate settings page, and a per-agent interval would only let each
agent configure how *late* its own fires may be.

---

## Trigger types — a registry, not a plugin system

Each trigger type ships like an addon ships, without being one:

```
aspect-agent-server/builder/triggers/
  silence.trigger.json                  ← descriptor (id, name, icon, purpose, defaultConfig)
  silence/trigger.silence.js            ← the clause declaration
  index.js                              ← side-effect registration

aspect-react-client/src/builder/triggers/
  silence/trigger.silence.ts            ← hydrates the JSON
  silence/SilenceConfig.tsx             ← the type's own setup UI
  index.ts
```

Three files per type, same shape as an addon, so each type gets its own
setup UI — Silence gets a duration picker, a field-watcher gets the
condition builder, a scheduler gets a time picker.

### The clause contract — one declaration, two consumers

A trigger type does **not** expose an opaque SQL query. It declares a
list of **named clauses**:

```
Silence:
  clause "quiet long enough"    last customer message older than {X}
  clause "spacing"              no event from this trigger for {X}
  clause "under the cap"        events since last customer message < {N}
  clause "after switch-on"      last customer message after {activeSince}
```

Two consumers read the same declaration:

- **The tick** ANDs the clauses into one indexed SQL query across the
  agent's conversations. Returns a handful of rows out of thousands.
- **The explainer** evaluates the same clauses for ONE conversation at
  ONE moment, printing actual numbers.

**Why not two functions.** Writing `findDue()` as SQL and `explain()`
separately means two implementations of one rule, and they drift — you
find out when the explainer confidently lies. This is the same trap the
prompt assembler hit (client preview vs. server assembly), solved there
by making one string the single source. Same solution: one clause list,
no drift possible.

Cost: the contract is a short structured list instead of raw SQL. For
Silence that's four clauses.

---

## Trigger type #1 — Silence

### The card

```
WHEN
  Nudge after    [30] [minutes ▾]  of quiet
  Up to          [3]  times, until they reply

WHEN NOT                                          (both optional)
  Quiet hours    [22:00]–[08:00]  [Asia/Jerusalem ▾]
  Only if…       conditions

THEN
  Run crew       [Re-engagement ▾]
  Brief          optional text (+ {{tokens}})
```

**Two numbers.** *"After 30 minutes of quiet, nudge. Up to 3 times."*

### The mental model — a nudge sequence

A sequence starts when the customer goes quiet and ends the moment they
reply. Inside a sequence you get N attempts, spaced X apart. They reply
→ everything resets → a future silence starts a fresh sequence.

- Quiet at 10:00 → attempts at 10:30, 11:00, 11:30 → stop.
- Customer replies at any point → counter resets.
- Never replies → 3 attempts total, then silence for good.

### The two counters read different things

> **Customer messages define the silence. Our own events define our behaviour.**

- **"Quiet for X"** measures from the **last customer message** — so a
  customer silent for 3 days who was nudged 30 minutes ago still reads
  as *3 days*. That true number is what appears in the explainer and in
  any `{{token}}` in the brief.
- **"Up to N times"** counts **trigger events** — attempts, whether or
  not the crew ended up speaking.

### Why "up to N" counts attempts, not messages

An earlier draft counted messages sent. But a crew can deliberately stay
silent, and a silent run sends no message — so the counter never
advanced and the trigger relaunched the chain every tick, forever,
burning tokens invisibly. That draft needed a "give up after 7 days"
fence, which read as redundant on the card because the thing it guarded
wasn't visible there.

Counting **attempts** closes it with no extra knob: worst case on a
dead conversation is N chain runs, ever. It's also more honest — a crew
that stays silent every time is a bug you should *notice*, not one an
unlimited retry loop hides.

**Rail:** the count must be a real number. **No "unlimited" option** —
that's the only way to reopen the hole.

### What the author never sees

Clause 2 (*no event for X*) is pure mechanics — it's what stops a
**silent** attempt from re-matching on the very next tick. Same X, no
second setting.

Clause 4 (*after switch-on*) is what makes backfill impossible: a
trigger only ever applies to conversations that have had a customer
message since it was switched on. Dead conversations stay dead; live
ones adopt it the next time someone speaks. No sweep, no "last N days"
setting, no first-tick blast across your entire history. Displayed on
the card, never edited.

### Quiet hours — evaluated AFTER the match, on purpose

Quiet hours *could* be folded into the SQL, in which case nothing at 3am
would create a row and you'd have no idea the trigger wanted to fire all
night. So it's evaluated **after** the match, deliberately paying for a
few extra rows overnight to buy the visibility.

That also makes "hold until the window opens" free: it's just *skip* —
the conversation is still quiet in the morning, so it matches again and
fires then. No holding mechanism, no queue.

---

## The Filter — the second gate

Optional, per trigger. Reuses the **existing** Filter component and
condition vocabulary (`conditionMatcher.js`), not a new one.

Two gates, and they can't be one thing because they cost different
things:

|  | Gate 1 — clauses | Gate 2 — Filter |
|---|---|---|
| Runs | agent-wide SQL | per matched conversation |
| Loads memory | **no** | **yes** — first time the brain is read |
| Answers | "who's quiet, under the cap" | "is it appropriate for *this* one" |
| Example | quiet 40 min | `opted_out = false`, `phone is empty` |

Gate 1 must scan thousands of rows so it can't load memory; gate 2 reads
a jsonb blob per conversation so it can't be the scan. Splitting them is
what keeps the tick cheap.

**Trim:** the addon Filter carries a `cap` ("run at most N per
conversation"). That doesn't belong here — the nudge cap is the
trigger's own concept with its own meaning. The trigger stores the
`conditions` + `mode` half only; the UI suppresses the cap (the
`hideStandardSections` mechanism already exists for this).

Empty filter → no gate 2 → zero cost.

---

## The proactive turn

A normal turn with no user message.

- **Only the chosen crew's chain runs.** The agent cortex does **not** —
  it is "pre-crew work per user turn", and there is no user turn. Full
  control over what executes.
- **One-off excursion.** Firing does not move
  `conversation.metadata.currentCrewId`. A Transition Router *inside*
  the proactive chain can still move it deliberately.
- **Version:** whatever that conversation already runs — a live customer
  conversation uses `published`, a builder-preview conversation uses
  `viewing`. Derivable from `conversations.metadata.kind`, no new field.
  Consequence: **the clock never runs unsaved edits.** To test a trigger
  against a draft, use Test fire (below).
- **Silence is a first-class outcome.** If no talker produces text, no
  message row is created and the customer sees nothing. Every step is
  still in the run inspector, so *why* it stayed quiet is visible.

### The brief

Optional author text, supports the same `{{tokens}}` as any prompt.

- **Present** → it fills the LLM's message parameter for this turn.
- **Absent** → the crew runs on history alone. Already safe:
  `llm.claude.js` only pushes the current message `if (message)` and
  appends a neutral prod when the array would otherwise end on an
  assistant turn.
  *Build-time check: confirm the same guard on the OpenAI and Gemini
  paths.*

**The brief is NEVER written to the messages table.** Persisting it as a
user message would put words in the customer's mouth — their transcript
would contain an instruction they never typed. It lives on the trigger
event row and its run card (*"the crew was told: …"*): visible in the
log, absent from the transcript.

It doesn't need to persist for later turns, because the assistant's own
message carries the intent forward. If an author wants the reason
available later, the crew writes it to memory — that's what memory is
for. Don't fake a message to carry state.

### One event = one turn = one bubble = one run log

Two proactive messages in a row are **two separate bubbles with two
separate run timelines** — they are two different attempts, at different
times, possibly by different crews, with possibly different outcomes.
Collapsing them would hide exactly what you'd want to inspect.

This already works: `pairMessagesToTurns` in
`aspect-react-client/src/live-chat/useLiveChat.ts` renders a lone
assistant message as its own turn (`turn_a{id}`), and run cards are
fetched per message id. **No client change needed.**

---

## Data model

### Two new columns — the whole schema cost of the feature

**Built — migration 044.** (The plan said one column; building it showed
it has to be two. The Silence clause measures *"the customer went
quiet"*, which is not the same question as *"nothing has happened
here"*, and a single column can only answer one of them.)

```
conversations.last_user_message_at   timestamp    ← what "quiet for X" means
conversations.last_message_at        timestamp    ← any activity, ours included
  index (agent_id, last_user_message_at)
  index (agent_id, last_message_at)
```

`last_user_message_at` is the one the Silence trigger rides. **A
proactive nudge must not move it** — otherwise a customer silent for
three days reads as silent for thirty minutes the moment we nudge them,
the trigger re-arms on its own output and nudges forever, and every
downstream number (the explainer, `{{tokens}}` in a brief) inherits the
lie. `last_message_at` answers the other question and is there for
conversation ordering and for future trigger types that care about any
activity at all.

Together they turn *"who's been quiet for 30 minutes"* into an index
scan instead of a `MAX(messages.created_at)` per conversation, once a
minute, forever.

**Maintained by a DB trigger, not application code.**
`messages_touch_conversation_activity` fires `AFTER INSERT ON messages`.
Messages are inserted from the V2 runtime, the V1 conversation service
and the WhatsApp bridge, and more writers will appear — a derived column
that one of them forgets to stamp is worse than no column, because the
trigger then silently never fires for that channel and nothing errors. A
row-level trigger cannot be forgotten by a future caller, which is
exactly the property these columns need. It uses `GREATEST()` so it is
idempotent and safe against backdated or out-of-order inserts.

### `trigger_events` — one row per (trigger × conversation × attempt)

```
id
agent_id, trigger_id, trigger_type
conversation_id            index — "why did this conversation get a message?"
matched_at                 index with trigger_id — "what did this trigger do today?"
status                     running | done
outcome                    filtered | quiet_hours | spoke | silent | error
match_reason               "quiet for 34 minutes"
filter_result   jsonb      the per-condition trail, whenever gate 2 ran
brief_used      text       what the crew was told (null when blank)
launched_crew_id
message_id                 null unless outcome = spoke
error
started_at, ended_at, duration_ms

on delete cascade with conversations
```

**Named `trigger_events`, not `trigger_fires`** — most rows didn't fire.
Filtered, quiet-hours and silent all land here, and those are the rows
you'll actually go looking for. Matching creates the row; the outcome
column says how far it got.

**Lifecycle:** created at match (`status: running`), updated when the
chain returns. `spoke` vs `silent` is not knowable up front — it depends
on what the crew does. A row stuck on `running` means the server died
mid-chain, which is itself worth seeing. Mirrors `addon_runs`.

### The five outcomes

| Outcome | Meaning | Message? | Counts toward the cap? |
|---|---|---|---|
| `filtered` | Matched, Filter conditions rejected it | no | **yes** — it was an attempt |
| `quiet_hours` | Matched and passed the Filter, outside the window | no | **yes** |
| `spoke` | Crew ran and produced a message | **yes** | yes |
| `silent` | Crew ran and deliberately said nothing | no | yes |
| `error` | Crew threw | no | yes |

Every outcome is an attempt, and every attempt counts. That's what makes
the cap a real bound.

### `trigger_status` — one row per trigger, updated in place

```
agent_id, trigger_id
last_evaluated_at
last_result            matched N / nothing / error
consecutive_empty
last_fired_at
```

One row per trigger, forever, never grows. This is what the card renders:
*"checked 2 min ago · 3 fires today · last 14:02."* Without it, the
author can't tell "working, nobody's quiet" from "broken".

**Not in the agent body** — the body is versioned config, and writing
runtime state into it would leave the agent permanently dirty and spawn
junk versions.

### No per-evaluation log

A trigger checked every minute is ~1,440 rows/day, ~99% of them *"found
nothing"* — storage you'd pay for and then have to prune. The three
questions that table would answer are already covered:

| Question | Answered by |
|---|---|
| Did it run? | `trigger_status` |
| What did it do? | `trigger_events` |
| Why didn't it fire for conversation X at 15:00? | the **explainer** |

**Optional extra:** one summary row per tick (1,440/day for the *entire*
system regardless of trigger count) — *"6 agents, 14 triggers, 3 fires,
240ms"*. That's a health metric for the admin panel, unrelated to the
per-conversation question. Easy to add or skip.

### Retention

**Wire the cascade delete now** — `trigger_events` goes with its
conversation, same as `addon_runs` already does. Free at creation time,
archaeology later.

**Don't build a retention policy.** The table grows one row per real
attempt, not per unit of time. A table that only grows when something
actually happened doesn't become a problem. (Contrast with the
per-evaluation log above — *that* would have needed one on day one,
which is a good part of why we're not building it.)

---

## The explainer

> *Why did conversation #412 get nothing at 15:00?*

Nothing else answers this: events only record attempts, status is
aggregate, "check now" only speaks about now.

`GET /api/agents/:slug/triggers/:id/explain?conversationId=…&at=…`

It **recomputes**, it doesn't read a log — every input is immutable
(message timestamps, this trigger's own event rows, the config):

```
15:00 · conversation #412 · Silence
  ✅ quiet long enough   quiet 40 min, needs 30
  ✅ spacing             last event 2h ago, needs 30 min
  ❌ under the cap       3 attempts since they last spoke, max is 3
  → did not fire
```

**Known ceiling:** it evaluates with the **current** config. Change the
threshold today and asking about yesterday explains it with today's
number. Label it in the UI (*"evaluated with current settings"*).
Resolving the historical config is possible later — agent versions are
timestamped — but out of scope for v1.

The one thing the clause replay can't reconstruct is a Filter that
depended on memory which has since changed. That's why `filter_result`
is stored on the event row whenever gate 2 ran, pass or fail.

---

## Delivery

The message is **written to the conversation first**. That's the source
of truth, and it's there on the next load like any other message.

**Live push** so an open chat sees it without refreshing. This is where
the 1–3 Cloud Run copies bite again: the customer's chat holds a
connection to *one* copy, and the trigger may fire on a *different* one,
which has no connection to push down.

**Bridge: Postgres `LISTEN/NOTIFY`.** The firing copy issues
`NOTIFY conv_<id>`; whichever copy holds that conversation's open
subscription forwards it. No new infrastructure — Cloud SQL supports it
and the `pg` driver is already in use (needs one long-lived client
checked out of the pool and never released; `LISTEN` is per-connection).

**An in-memory pub/sub would silently work in dev and drop ~2/3 of
pushes in production.** Named here so nobody builds it that way.

**Both chats subscribe** — the customer chat and the builder's User
Chat. A proactive message appears live in whichever is open.

**No token streaming for proactive.** There's no client attached when it
runs; the message arrives whole. The client can animate a "typing" beat
locally if we want the feel.

**Channels.** `conversations.channel` already distinguishes `web` from
`whatsapp`. Build the delivery step as a **swappable sink** so WhatsApp
is a plug-in later, not a rewrite. v1 is web only.

---

## UI surfaces

### Triggers screen — `/:agent/builder/triggers`

Sibling to Live Brain / Profiler. Cards (chips), not a lane — triggers
are independent, not a chain. Each card:

- its type's own setup UI (Silence → two numbers)
- the shared block: quiet hours · Filter · target crew · brief
- status line from `trigger_status`
- expandable recent-events feed
- **Test fire** · **Check** · enabled toggle

### Admin → Triggers tab

Clock health line · Pause / Step once · this agent's full event feed
(conversation · when · why it matched · outcome · link into the
conversation) · the explainer.

### In the conversation

- `spoke` → the message renders with a badge:
  *⚡ Silence · quiet for 34 min*. Cheap: stamp
  `messages.metadata = { proactive: true, triggerId, eventId }` so the
  chat needs no join.
- `filtered` / `quiet_hours` / `silent` produce **no message**, so they
  anchor by timestamp as slim cards between turns:

  ```
  15:04  ⚡ Silence matched — quiet 40 min → filtered: opted_out = true
  ```

  **Builder chat and admin conversation view only. Never the customer
  chat**, which shows messages and nothing else.

  This is not a new pattern: `addonRunner` already writes a
  `status: 'skipped'` run row and emits `addon.skipped` with the
  evaluation trail when a chain addon's filter rejects it. Same
  treatment, same visibility.

---

## Testing it without waiting three days

Non-negotiable given the WYSIWYG premise. The clock never runs unsaved
edits, so the test path runs from the browser and carries the working
copy exactly like a builder chat message already does
(`overrideAgentBody` / `overrideCrewBodies`).

| Affordance | Does | Version |
|---|---|---|
| **Test fire** | Runs the target crew's chain now, ignores the trigger entirely. Full run timeline in the builder chat. | **your unsaved working copy** |
| **Check** | Evaluates only the clauses against real state — fire / no-fire **and why**. Sends nothing. | your unsaved working copy |
| **Fire now** | On one conversation row in the admin feed — the real production path. | saved version |
| **Explain** | Retrospective, any conversation, any moment. | current config |

---

## Alfred registrations

Per [ALFRED_UPDATE_PROTOCOL.md](./ALFRED_UPDATE_PROTOCOL.md) §3.1 —
`agent.triggers[]` is a **new top-level body section**, so it owes the
full checklist. This is the same bill `liveBrain` and `profiler` paid.

- [ ] `patchGenerator.js` → `AGENT_SECTION_KEYS` (missing = Alfred
      literally cannot change it; the merge silently ignores it)
- [ ] `patchGenerator.js` → `AGENT_ITEM_SECTIONS` (it's an id'd array,
      so item paths work and the array isn't re-emitted wholesale)
- [ ] Client `BuilderContext.tsx` → `applyAlfredBodies` merge whitelist
      (missing = Alfred's applied change VANISHES between "generated OK"
      and the working copy)
- [ ] Client `bodyOfAgent` → snapshot the key on Save (empty==absent
      pattern so old agents don't read dirty)
- [ ] `bodyValidator.js` → shape checks (use `checkProfiler` as the
      template)
- [ ] `alfredContext.js` `STATIC_SYSTEM_PROMPT` → a `# Triggers`
      section: what it is, when to suggest it, the decision rule vs. an
      offline-lane addon, hard don'ts
- [ ] `patchGenerator.js` `SYSTEM_PROMPT` → generation recipe: id
      formats, required companion pieces, explicit NEVERs
- [ ] Rich doc-comments on the new types in `builder/types/index.ts` —
      **they ARE the patch generator's knowledge** (embedded verbatim)
- [ ] Teach the patch generator to load `builder/triggers/*.trigger.json`
      alongside `builder/addons/*.addon.json`, so every future trigger
      type is Alfred-compatible the moment its JSON lands
- [ ] **Restart the server** — all of this loads at module init

---

## Build phases

Each ends with something testable.

**T1 — the turn (no clock yet). ✅ BUILT — 2026-08-31.**
Migration 044 (both activity stamps + the DB trigger + indexes).
`BuilderRunner.runProactive` — runs one crew's chain on a conversation
with no user message; `runChain` lifted to module level as
`runChainSteps` so the user turn and the proactive turn can never drift
apart. Silence is a real outcome (no message row, stamps untouched, runs
still logged). The brief fills the LLM's message slot and is never
persisted. `POST /api/agents/:slug/conversations/:convId/proactive` —
the Test fire endpoint, accepting working-copy overrides so it runs
unsaved edits.

*Verified:* `node scripts/test-proactive-turn.js` — 20/20, including a
regression check that the ordinary user turn still replies after the
extraction. See `verification/proactive-turn/`.

*Remaining for T1:* the client-side Test fire button (lands with the
Triggers screen in T2, which is where it belongs).

**T2 — the trigger primitive. ✅ BUILT — 2026-08-31.**
`agent.triggers[]` in the agent body (+ `AgentTrigger` /
`SilenceTriggerConfig` / `QuietHours` / `TriggersDef` types) · the
trigger-type registry (`builder/triggers/`) with the two-method contract
· the Silence type and its four clauses · migration 045
(`trigger_events` with five outcomes, `trigger_status`) · the evaluator
(findDue / checkOne / explainAt / quiet hours) · the dispatcher (three
gates, event lifecycle) · `builder/routes/triggersRoute.js` (types,
status, events, check, explain, sweep, candidates, conversation feed).

*Verified:* `node scripts/test-triggers.js` — 46/46 (26 offline clause
arithmetic + 20 end-to-end). See `verification/triggers/`.

Client: the **Triggers screen** at `/:agent/builder/triggers` — cards,
not a chain, because triggers are independent of each other. Plus the
client trigger-type registry (a `@triggers` alias onto the SAME
descriptor JSON the server reads, so the two halves can't drift on
names, icons or defaults), the Silence two-number form, the clock bar,
and an editor carrying **Who's due right now**, **Dry run**, and the
event history — including the outcomes that sent nothing, which are the
ones worth reading.

**T3 — the clock. ✅ BUILT — 2026-08-31.**
`services/trigger-clock.service.js` — master switch (off by default),
DB-lease claim so 1–3 Cloud Run copies can't overlap, jsonb scoping so
only agents with enabled triggers are swept, health payload carrying the
precision caveat. `POST /api/admin/triggers/tick` for Cloud Scheduler,
`GET /api/admin/triggers/clock` for ops, plus clock health / pause /
Step-once under the agent's Triggers routes.

*Verified:* `node scripts/test-trigger-clock.js` — 17/17. See
`verification/trigger-clock/`.

**Running it locally.** There is no Cloud Scheduler on a laptop, so set
`TRIGGERS_CLOCK_LOCAL_SEC=30` in `.env` and the server runs the same
tick on an interval. Opt-in, dev-only (an in-process interval would run
on every Cloud Run copy at once), and still gated by the clock's own
on/off switch — so setting it alone does not start nudging anybody.

*Remaining for T3:* **create the Cloud Scheduler job** (every minute →
`POST /api/admin/triggers/tick`) and switch the clock on. Until then the
clock only runs on Step once, which is the right default for something
that has never been armed.

**T4 — live push. ✅ BUILT — 2026-08-31.**
`services/conversation-push.service.js` — Postgres LISTEN/NOTIFY, one
held connection per server copy, opened lazily. A proactive message
notifies; whichever copy holds that chat forwards it. New endpoint
`GET /api/agents/:slug/conversations/:convId/live` (SSE, heartbeat,
clean unsubscribe). Client: `live-chat/useProactivePush.ts`, wired into
`useLiveChat` and paused while the user's own turn streams.

The stream carries ids only, never message text — the client reloads
through the same path history uses, so a pushed message and a loaded one
can never look different, and a long reply can never exceed the 8KB
NOTIFY limit.

*Verified:* `node scripts/test-conversation-push.js` — 8/8, including a
NOTIFY issued from a genuinely separate node process reaching a
subscriber here. That is the assertion an in-memory channel fails, and
it is the whole reason this is not a Set of response objects.

**T5 — Alfred. ✅ BUILT — 2026-08-31.**
All of §3.1: `triggers` in `AGENT_SECTION_KEYS`, the client merge
whitelist and `bodyOfAgent` snapshot (empty==absent, so agents that
predate the feature never read dirty), `checkTriggers` in the validator,
a `# Triggers` section in brainstorm Alfred, and a trigger-type
catalogue in the patch generator rendered from
`builder/triggers/*.trigger.json` — so a NEW trigger type is
Alfred-compatible the moment its JSON lands, with no prompt edits.

*Verified:* `node scripts/test-alfred-triggers.js` — 19/19, asserting the
wiring rather than the behaviour, because the protocol's failure mode is
silent: a section that never reaches the prompt, or a key the merge drops.

**Remaining:** the Cloud Scheduler job, and turning the clock on.

**Later, not scheduled:** more trigger types (Schedule, Delay,
Field-watch) · the WhatsApp sink · historical-config resolution in the
explainer.

---

## Decisions journal

**1. Triggers are not addons.** Modelled as an addon lane first. An
addon is conversation-scoped and is *handed* a conversation; a trigger
is agent-scoped and has to *find* them, and its output is a selection,
not content. Kept the vocabulary (filters, conditions, run cards) and
dropped the container.

**2. Each trigger type is its own registered type.** The reason for
wanting them as addons was that each type needs its own setup UI. A
type registry gives that without the false inheritance — three files per
type, same as an addon.

**3. Clause declarations, not opaque queries.** So the tick and the
explainer read one source and can't drift. Same principle as the
prompt-assembler byte-equality contract.

**4. The trigger finds its own due conversations; no per-conversation
schedule rows.** The obvious design is a row per (conversation ×
trigger) holding `next_due_at`. Rejected: `next_due_at` is *derived*
data, so changing "30 minutes" to "2 hours" leaves 10k rows wrong and
needs a rewrite or a lazy-recompute hack. With clauses-as-a-query,
changing the number means **the next tick is simply correct** — there
was never anything derived to go stale. Also no backfill rules, no
cleanup on delete/rename, no second lifecycle to keep in sync with the
agent JSON.

**5. The run log IS the state.** The only thing still needed is "when
did this fire for this conversation", which isn't derived config —
it's history, and `trigger_events` is its home. Folded into the same
query as a join. Zero extra state.

**6. "Up to N" counts attempts, not messages sent.** Counting messages
let a silent crew relaunch every tick forever, and needed a "give up
after" fence that read as redundant on the card. Attempts bound it with
no extra knob, and surface a silent-every-time crew as the bug it is.

**7. Silence measures from the customer's last message, not any
message.** An earlier answer said "any", because at that point silence
was also doing the job of spacing attempts. Once the event clause took
that job, measuring from the customer became strictly better: it keeps
the **true** number (3 days stays 3 days after a nudge 30 minutes ago),
which is what the explainer and any `{{token}}` in the brief show.

**8. Quiet hours evaluated after the match, not in the query.** Pays for
a few extra overnight rows to buy the visibility of "it wanted to fire
all night". Also makes "hold until the window opens" free — it's just
*skip*, and it matches again in the morning.

**9. No backfill, ever.** Arming is implicit in clause 4 (*last customer
message after switch-on*), so enabling a trigger can never blast every
conversation in your history on the first tick. No sweep, no "last N
days" setting.

**10. `trigger_events`, not `trigger_fires`.** Most rows didn't fire,
and those are the interesting ones.

**11. No per-evaluation log.** ~99% of the rows would say "found
nothing". The three questions it would answer are covered by the status
row, the events table, and the explainer — the last of which is *better*
than a log, because it shows the arithmetic rather than the verdict.

**12. The brief is never persisted as a message.** It would put words in
the customer's mouth. Lives on the event row; visible in the log, absent
from the transcript. The assistant's own message carries the intent to
the next turn; memory is where state goes.

**13. One event = one bubble = one run log.** Two nudges in a row are
two attempts and stay two of everything. Already the client's behaviour.

**14. Live push via `LISTEN/NOTIFY`, not in-memory.** With 1–3 Cloud Run
copies, an in-memory channel works perfectly in dev and drops most
pushes in production.

---


**15. Test harnesses must name the conversations they mean.** A sweep is
agent-wide by design — that is what a trigger IS. During development a
battery called `sweepTrigger` to check that ITS conversation was picked
up, and the sweep dutifully nudged three real customer conversations
belonging to the same agent. The messages were removed and the stamps
repaired. Two changes came out of it: `sweepTrigger` takes
`onlyConversationIds`, and the two batteries that write to the database
or call real models now do nothing without an explicit `--live`. A test
that can write to production should never be what happens when you type
the obvious command.

**16. Naive `timestamp` columns cannot be compared against JS Dates.**
Migrations 044/045 followed the older tables and used `timestamp` (no
time zone). The database runs UTC, Node runs Israel time, and
node-postgres compares a Date against a naive column as LOCAL wall-clock
— so `now()::timestamp > $1` with $1 an hour ago returned FALSE. Every
trigger clause is that comparison, so the symptom was a trigger that
matched nobody, silently. Migration 046 converts the columns the engine
reads to `timestamptz`; the two remaining reads of the still-naive
`messages.created_at` say `AT TIME ZONE 'UTC'` out loud.

---

## Open notes (deliberately not decided)

- **Consecutive assistant messages in history.** Before proactive, every
  assistant message had a user message in front of it. Two nudges in a
  row break that for the first time. OpenAI and Anthropic tolerate
  consecutive same-role turns; **Gemini is the likely one to object.**
  If it does, the fix belongs in that provider's payload builder — the
  LLM services stay generic and untouched. Display and logs are a
  different layer and are unaffected either way. *Verify at build time,
  don't pre-solve.*
- **Historical config in the explainer** — possible (versions are
  timestamped), out of scope for v1.
- **A lifetime nudge ceiling** — deliberately not a headline knob. If an
  agent needs one it's a Filter condition on a counter field.
- **Per-tick fire cap** — probably wanted eventually so a backlog can't
  spend the LLM budget in one minute. Not specced.
- **WhatsApp sink** — seam only.
