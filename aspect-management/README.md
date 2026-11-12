# Aspect Management

Itzik's internal tool for running Aspect's own operations: developer hour
reporting, projects, clients, quotes. Task #115, version 0. It replaces Monday
and the like. **It is not related to any customer**, so it has no dataset, no
customer schema and no agent.

The UI is at `/aspect/management` (under `/aspect/` like every Aspect page — the client is shared with Lybi), in `aspect-agent-client-react/src/aspect-management/`.
It is Hebrew only, and so are the messages this server sends back to it.

## Layout

| Path | What it is |
|---|---|
| `routes/management.routes.js` | `/api/management/*`, mounted with one line in `server.js`. |
| `services/rules.js` | The alert rules and date logic. Pure; `scripts/test-aspect-management-unit.js` pins them. |
| `services/management.service.js` | People, clients, projects, the daily report, quotes. |
| `services/ask.service.js` | The "ask the system" screen. |

Tables are `am_*` in the platform DB: `db/migrations/066_aspect_management.sql`,
applied with `node db/migrations/run-066-aspect-management.js`. Run it before
deploying the server.

## Who gets in

Sign-in is the normal Sign-In flow on the `aspect` project, so an account is
needed on that project's Access page. The role comes from `am_people`, matched by
email:

- **owner** sees everything.
- **developer** sees only the report screen.
- An admin of the `aspect` project with no row yet becomes an owner on first
  arrival. That is how the first person gets in.
- Anyone else who signs in sees a "not on the list" message.

So adding a developer takes two steps: an account on the Access page, and a row
under הגדרות.

**Known gap:** like the platform's other data APIs, these routes do not check who
is calling. The owner/developer split is enforced in the UI only, so anyone who
knows the API can read and change this data. Kosta deferred this on 2026-11-05.
For the same reason, adding a person here deliberately does not grant sign-in: an
open route that creates accounts would widen the gap to the rest of the platform.

## Decisions the spec left open

- A time entry with no client is internal work ("פנימי" in the report).
- The monthly package counts billable hours only. A project's budget counts all
  hours reported on it.
- "Open items" on the client card = active projects + open quotes.
- The report row has a project picker although the concept image does not show
  one: without it no hours would reach a project, and the projects screen would
  stay at 0%. It appears only when the client has active projects, and is
  preselected when there is exactly one.
- "Since yesterday" for blockers means since the previous workday, so Sunday
  morning still shows Thursday's.
- A project has an `amount` column, because a won quote's conversion carries one.
- Screen 6 hands the model the V0 data as facts code already computed, instead of
  the task's preferred route of pointing the NL->SQL engine at these tables. That
  engine would run generated SQL on the platform DB, where nothing stops a question
  reaching `users` or conversations, and these routes are open. It also answers
  on the last 45 days of time entries only.
- The look is the "Smart Ledger" Itzik chose, built to the concept images
  (`public/aspect-management/look/ledger-1..6.jpg`); a switch to the platform's
  own look on 2026-11-12 was undone the same day. Screens with no concept
  (sign-in, clients, team, settings) were drawn with GPT Image 2.5 flare /
  sunburst on Leonardo first (`ledger-7..10`, prompts beside them).
- Handwriting is Playpen Sans Hebrew. The spec's example, Amatic SC, was barely
  legible in Hebrew at button size.
- The nav has a seventh item, שואלים את המערכת, since the spec's nav list gives
  screen 6 no way in.

## Next, not in V0

Holidays in the "did not report" rule, deleting clients or projects, logo upload,
notes history, reminders that actually send something.
