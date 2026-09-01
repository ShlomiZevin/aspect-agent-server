# Trigger clock (Builder V2 — phase T3)

What was checked: the once-a-minute heartbeat that runs triggers with
nobody watching.

## Reproduce

```bash
cd aspect-agent-server
node scripts/test-trigger-clock.js
```

Runs against the real database. It saves and restores the clock's
settings and any borrowed agent body in a `finally`, so it is safe to
run on a live system.

## Results — 2026-08-31

**17/17 passed.** Raw output in `results.json`.

Most of these assert the clock **refusing** to act, which is the
behaviour that matters for the one component of this feature that runs
unattended:

| Group | What it proves |
|---|---|
| master switch | Off by default and a tick does nothing while off — a deploy can never start nudging customers. "Step once" still works while paused; a dry-run step launches nothing. |
| the lease | Exactly one of three simultaneous claims wins; a further claim while held is refused; after release the next claim succeeds. |
| crash recovery | An expired lease is reclaimed rather than honoured — a copy killed mid-tick cannot wedge the clock. A live lease still blocks. |
| scope | Only agents with at least one enabled trigger are swept. An empty `triggers` array, or a `triggers.enabled: false` block, is excluded **in the database**, so the clock doesn't walk every agent on the platform every minute. |
| health | Reports the switch, lists the agents in scope, and states the precision floor. |

## Two guards, and only one is authoritative

The first version of check [2] raced two real `runTick` calls and saw
both proceed — which looked like a broken lease. It wasn't. With no
agents to sweep, each tick claimed, did nothing, and released in under a
millisecond, so they never overlapped.

That distinction is worth keeping straight:

- **The lease is a cost guard.** It stops two copies doing the same
  expensive sweep *at the same time*. It cannot stop two ticks running
  back to back, and doesn't need to.
- **The event log is the correctness guard.** The first fire writes a
  `trigger_events` row, and the trigger's spacing clause then refuses
  another attempt inside the window — no matter how the second sweep was
  started (the clock, Step once, or "Run now" on a card). Asserted end
  to end in `test-triggers.js` [11].

Anyone tempted to strengthen the lease because it looks like what stands
between a customer and a double message should read that again first.

## Deployment note

The clock needs its own Cloud Scheduler job (every minute) hitting
`POST /api/admin/triggers/tick`. Deliberately **not** folded into the
existing `data-loader-tick`: that job loads customer data, this one
messages customers, and stopping the second must never require stopping
the first. Until the job exists, the clock only runs when somebody
presses Step once — which is the right default for a feature that has
never been armed.
