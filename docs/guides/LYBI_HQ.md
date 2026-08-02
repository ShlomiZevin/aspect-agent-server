# Lybi HQ — the central company brain

> **Status: 🔒 LOCKED 2026-08-02 — awaiting Shlomi's GO. Nothing built, do not start.**
> Every open design question is settled (§2). What remains (§12) is small, non-blocking, and
> answerable during the build. On GO, start at §13.
> Supersedes `BRAIN_CENTER.md` (same doc, renamed once the name was settled).
> Sister docs: [BUILDER_V2.md](./BUILDER_V2.md) (the engine this runs on),
> [KB_V2.md](./KB_V2.md) + [KB_V2_RETRIEVER.md](./KB_V2_RETRIEVER.md) (retrieval),
> [BUILDER_V2_LIVE_BRAIN.md](./BUILDER_V2_LIVE_BRAIN.md) (panel renderers we reuse),
> [ADMIN_V2.md](./ADMIN_V2.md), [task-board.md](../features/task-board.md).

---

## 0. The name

**Lybi HQ.** Route `/hq`, deployed at `hq.lybi.ai`. Its AI workers are **the staff**.

Why this one: the thing is about **running the company**, not about being a brain — which is the
exact distinction we drew in §1. It has zero overlap with our product vocabulary (brain · agent ·
crew · addon · KB), which was the actual failure mode: "Live Brain" is already the customer-facing
side panel on `/:agent/live`, and `/lybi/brain` is the "we build brains, not chatbots" pitch deck. A
third "brain" would have made every future doc ambiguous.

It's also two letters — and this is a tool we'll type dozens of times a day. Internal tooling should
be named boringly and unambiguously; save the evocative names for what customers see. It reads right
in every sentence a team actually says: *"it's in HQ"*, *"ask HQ"*, *"did you put it in HQ?"* And it
gives us a coherent metaphor for the workers — HQ has a **staff**: a Scribe, a Librarian, a Chief of
Staff.

*(Alternative if you want warmth over function: **Atlas**. Good connotation — holds up the world,
knows the whole map — but more generic and it doesn't carry the staff metaphor.)*

---

## 1. What this is — and what it is not

One place that knows everything about the company, and eventually the only place we work.

Three people (Shlomi, Noa, Hila), all-remote, all decisions made on calls. Today the company's memory
is scattered across call recordings nobody re-watches, Notion, our task board, our KB, the builder,
Google Drive, OneDrive, GCS and the codebase. Nothing talks to anything.

**This is an internal tier for running Lybi.** Users: the three of us. Subject matter: *our*
meetings, docs, decisions, files, tasks and product.

**It is not** a product, not a feature of the agent builder, not another agent in the roster, and no
customer ever sees it. It's a fourth thing on lybi.ai alongside the tool, the KB and the builder.

**Its relationship to the builder is engineering reuse, in two places — both confirmed:**

1. **The staff run on the Builder V2 engine.** Same server engine, used as an internal framework. We
   get the prompt runtime, versioning, publish, run logging and cost tracking instead of rewriting
   them. The staff don't appear in the agent roster and have no customer surface.
2. **HQ gets a read-only view of builder state** so it can answer *"what does Freeda's profiler do"*.
   It reads, never writes. **Alfred stays exactly where it is.**

---

## 2. Decisions locked (2026-08-01)

| # | Decision |
|---|---|
| Name | **Lybi HQ** · `/hq` · `hq.lybi.ai` · workers = "the staff" |
| Placement | Its own top-level surface. **Not** a view inside the builder. |
| Engine | **Same server engine (Builder V2)** — confirmed. Tool is separate, engine is shared. |
| **Shape** | **HQ is one builder agent; the staff are its crews.** Shlomi's call, and it's the right one — verified against the code, it needs almost no new engine work. See §7. |
| Codebase | **Same repo, hard-separated inside it. One app at `lybi.ai/hq`, lazy-loaded** — no separate host needed. See §8. |
| LLM cost | **Free** — falls out of the agent/crew shape, no schema change. See §7. |
| Mobile | **First-class, Phase 1.** Capture-and-ask from the phone is what keeps HQ fed. See §4. |
| OneDrive | **No connector.** Noa moves the content into Google Drive once; we only ever watch Drive. |
| Notion | **API connector** (~2 days with `notion-to-md`) — gives refetch-a-page, incremental sync, comments, and paste-a-link. Shlomi's call; my export-only recommendation was wrong. See §4. |
| Codebase indexing | **Skip deep code indexing.** Index the docs tree + builder state — understanding the *product and builder* is what matters, not source lines. |
| Meetings | **Google Meet for auto-recording + Drive delivery — but we do our own transcription.** See §5. |
| Permissions | No per-item permissions. **Client data is never ingested at all** — an ingestion-time rule, not a query-time filter. See §9. |

---

## 3. We already own ~70% of this

Not a greenfield build — mostly assembly, 2 connectors and 1 new surface.

| What we need | What exists | Gap |
|---|---|---|
| chunk → embed → index → query, with tunable knobs | `kb.chunker/embedding/pinecone.service.js`, `library_files`, preview-chunks / preview-embeddings / query endpoints | none |
| retrieval inside a prompt | **KB Retriever addon** (`{{kb:NAME}}`, debug card with hits + scores) | point at HQ namespaces |
| agent engine: prompts, models, chain, versions, publish, logging | **Builder V2** — 9 plugins, `BuilderRunner`, `addon_runs`, `llm_usage`, `agent_log` | none |
| live panels (text/markdown/keyvalue/goals/bars/donut) + run inspector | **Live Brain** Phase 1–3 | reuse renderers |
| Drive folder → our storage, md5 change detection, streams multi-GB | `drive-to-gcs.service.js` | generalise from 2 hardcoded clients to "watch any folder" |
| audio/video → transcript, ffmpeg compression, 2 GB files | `transcription.service.js` | add a Hebrew-grade provider (§5) |
| audio → transcript → summary as a tracked job | `podcast.service.js` + `podcast_episodes` | it *is* the meeting pipeline; generalise |
| background worker on a schedule | `scheduler-tick.service.js` (one Cloud Scheduler job, ticks every minute) | add `hq_sync`, `hq_digest` job types |
| tasks / goals / agenda / assignees / notifications | task board | expose as a **tool** |
| files in GCS, signed URLs, previews | `gcs.service.js`, `gcs-folder.service.js`, `storage.service.js` | none |
| multi-provider LLM routing + cost tracking | `llm.js`, `models.service.js`, `llm_usage` | add the HQ tag (§7) |
| multi-target builds + separate hosting sites | `deploy:aspect` / `deploy:lybi-prod` / `deploy:freeda` | add `deploy:hq` |

**Genuinely new:** the atom model + `hq_*` tables, the connector framework, the Meet/Drive connector,
the `/hq` surface (desktop + mobile), and the four staff agents.

---

## 4. Storage, ingestion, and the mobile capture surface

### Storage — three tiers, chosen per kind of content

1. **Own it (canonical).** Anything authored in HQ: notes, decisions, meeting summaries, wiki pages,
   entity records, and the atom index. Our Postgres + GCS. Must survive Notion being cancelled.
2. **Mirror + index (connected).** Drive files. We pull, normalise, chunk, embed, cache the blob in
   GCS, and keep a **pointer + content hash** back to source. Source stays authoritative until we
   migrate; a scheduled re-check detects drift.
3. **Never copy, always ask (live).** Task board, builder state, calendar, usage/billing. Exposed as
   **tools HQ calls at answer time.** *"What is Hila working on?"* must be a live query.

> **Rule:** changes daily → tool. Changes monthly → index. We wrote it here → own it.

### The Atom — one row for everything indexed

```
hq_atoms
  id, kind ('meeting'|'decision'|'doc'|'note'|'file'|'task'|'page'|'entity'|'transcript'|'voice')
  title, body (normalised markdown — the thing we chunk), summary
  source_id → hq_sources, external_id, external_url   -- deep link, always shown in citations
  content_hash                                        -- drift + dedup
  authors[], occurred_at, ingested_at                 -- when it HAPPENED ≠ when we ingested it
  projects[]      -- reuse the task board's `domain` vocabulary
  entities[]      -- people / clients / agents / features
  confidence      -- classifier confidence; low → review queue
  visibility      'company' | 'client'                -- §9
  status          'pending'|'indexed'|'failed'|'superseded'

hq_sources   id, kind ('drive_folder'|'gcs_prefix'|'meet'|'upload'|'url'|'import'),
             label, config, sync_mode ('once'|'watch'), cadence, last_sync_at, last_status, atom_count, error
hq_links     from_atom, to_atom, rel ('mentions'|'supersedes'|'derived_from'|'decided_in')
```

Vectors go to the existing **`lybi` Pinecone index** under an `hq-*` namespace family, so the KB
workbench, `kb_links` and the KB Retriever addon keep working unchanged. Chunk metadata carries
`atom_id`, `kind`, `occurred_at`, `projects` → **hybrid retrieval** (metadata filter narrows, vector
ranks). That's what makes *"the call three weeks ago"* answerable — a date filter, not a semantic hope.

### Ingestion — one pipe, three permanent rungs

**Drop** (paste a link, paste text, drag a file, record a voice note — zero auth, ships week one) →
**Watch** (point at a Drive folder / Notion / the Meet calendar — recurring sync on the existing
tick) → **Native** (created in HQ). The "initiation phase" is just Rung 2 applied to our sources in
one sitting.

> **Drop is the universal fallback for every connector — that's the point of building it first.**
> Notion connector late or broken? Paste the ten pages that actually matter. Meet recording didn't
> sync? Drag the file in. Drive watcher pointed at the wrong folder? Drop the folder. **No connector
> is ever on the critical path**, which is what lets us build them in whatever order suits us and
> ship value before any of them exist.
>
> Two small requirements that make paste-in a *real* fallback rather than a toy: Capture must accept
> **pasted rich text / markdown with its structure intact** (headings are our chunk boundaries — a
> flattened wall of plain text retrieves badly), and it must offer an optional **"source URL"** field
> so a pasted page still carries a citation link back to where it came from.
>
> Scope honestly: pasting is right for *the handful of pages that matter*. It is not a workspace
> migration — you'd lose titles, hierarchy and the link graph, and it's manual per page. Fallback,
> not plan.

```
capture → fetch → extract → normalise → classify → chunk → embed → index → link
```

Per [project_kb_playable_atoms], **every stage is individually inspectable and adjustable** in the
Sources UI — raw source, extracted text, the classifier's call + confidence, the chunks, the
embeddings, a test query with hits + scores. No black box. Dedup by content hash, then near-dupe by
embedding distance → a `supersedes` link rather than two competing answers. *(That's how "what's our
palette colour" stops returning three different hexes.)*

### Notion — how the migration actually works

> *"How would the Notion migration go? Or the copy-links method? We need a connector, right?"*

**First, the trap: "copy the links" is not a third option.** A Notion page URL is not publicly
fetchable — paste one into anything without credentials and you get a login wall, not the page. It
only works in two cases: the page was explicitly *Published to web*, or **we already have an API
token and the page is shared with our integration** — in which case it *is* the connector, with a
paste-a-link UX on top. So the real choice is two options, not three.

### ✅ Decision: build the API connector

I first recommended the one-off workspace export. **That was wrong, and the estimate is what made it
look right.** I costed the connector at ~a week on the assumption we'd hand-write Notion's block tree
→ markdown conversion. We wouldn't — **`notion-to-md`** does exactly that, including nesting. With
it, the connector is auth + `search` to enumerate + convert per page + pagination + rate limiting +
attachment download: **~2 days**, against ~1 day for the export.

Three of my arguments for the export were also backwards:

| I claimed | Actually |
|---|---|
| the export preserves the internal link graph | the **API is better** — page mentions and links come back as clean page **IDs**, not URL-encoded relative file paths we'd have to resolve |
| databases come out clean as CSV | the **API is better** — `databases.query` returns **typed properties** directly; no CSV parsing and re-attaching |
| comments are lost, so check them by hand first | the **API has a comments endpoint** (`comments.list`, needs read-comment capability on the integration) — it *solves* the gap instead of leaving it open |

So for ~1 extra day the API gives us everything the export gives, plus:

- **Refetch one page on demand** — "this looks stale, re-pull it."
- **Incremental sync** — filter `search` by `last_edited_time` on the existing scheduler tick; only
  changed pages move.
- **Paste a Notion link → HQ pulls it.** The UX that doesn't work without a token now works.
- **Comments**, which is where decisions often actually live.
- **It stays correct if we don't fully retire Notion.** The decision was *"migrate, then rethink"* —
  if "rethink" lands on *"actually Notion is still good for X"*, the connector already covers it.
  The export path would strand us.

**And it isn't throwaway work even if Notion dies.** It's the **second** connector after Drive — and
the second implementation is exactly when you find out whether the connector interface is right.
Better to learn that on Notion than on something we can't afford to get wrong.

### The real remaining tradeoffs (small, but know them)

- **Attachments are expiring signed URLs.** Unlike the export, files aren't inline — the API hands
  back time-limited links, so the sync must **download to GCS during the run**, not store the URL.
  Easy to get wrong, easy to fix: store the blob, never the link.
- **`notion-to-md` is thinly maintained** — v3.1.9, last publish ~Aug 2025. It works and it's the
  standard choice, but treat it as a vendored dependency we may end up patching, not as something
  that will keep pace with new Notion block types.
- **Per-page sharing.** Pages must be shared with the integration. Sharing the top-level pages
  cascades, so for our workspace it's a few clicks once — not the obstacle it looks like.
- **Initial load respects ~3 req/s.** A few hundred pages ≈ 10–15 minutes. Fine; just don't expect
  it to be instant.

*(Databases: skip the task ones — tasks live on our board.)*

**"Paste a link" also stays as general capture for public URLs** — an article, a competitor page.
Phase 1, and now consistent with how Notion links behave rather than a special case.

### 📱 Mobile — first-class, Phase 1

**This is the answer to the "a brain nobody feeds dies" risk, and it's why it can't wait for Phase 5.**
Feeding has to be faster than not feeding. Two things only on the phone: **ADD** and **ASK**.

- **A PWA, not a native app.** Installable to the home screen, no app store, ships on the hosting we
  already use. For 3 users this is the whole answer.
- **One-tap capture** — voice note · photo (whiteboard, receipt, a screen) · file · text. Lands in
  the Inbox, gets classified, becomes a note/task/decision automatically.
- **Voice note is the highest-value capture we have.** Thinking out loud in the car becomes a
  filed, searchable, actioned atom. We already own the transcription for it.
- **Share-sheet target** — share a link or file from *any* app straight into HQ. On Android that's a
  PWA `share_target` manifest entry. **On iOS, PWA share targets aren't supported** — the fallback is
  an Apple Shortcut that POSTs to the capture endpoint (works fine, one-time setup per phone).
  Worth knowing before we promise it.
- **Ask** — the same chat, mobile-shaped. Answers with citations.

Everything else (Pulse, Timeline, Sources, Constellation) is desktop-first and can lag.

---

## 5. Meetings — the recommendation, revised

> *"Why not Google Meet and that's it? What are the downsides?"*

Fair question, and researching it properly turned up **one fact that changes the answer** — worth
catching now rather than after we'd migrated.

### ⚠️ The finding: Google Meet does not transcribe Hebrew

Meet's native saved transcript supports **8 languages — English, French, German, Italian, Japanese,
Korean, Portuguese, Spanish.** Hebrew is not among them. So for a Hebrew-speaking team, the single
strongest argument I made for Meet — *"free speaker-attributed structured transcripts"* — **does not
apply to us.** Same limitation hits "Take notes for me". The Workspace Business Standard upgrade
would buy us a feature we can't use.

### The revised recommendation: **Meet for delivery, our own ASR for transcription**

Still Google Meet — but for **auto-recording and Drive delivery**, not for its AI:

1. **Meet auto-records** (configurable on the meeting space, so it doesn't depend on anyone pressing
   a button — this was always the biggest reliability win, and it's language-agnostic).
2. The recording lands in **Drive** → our **existing Drive watcher** picks it up.
3. **We transcribe it ourselves** with a Hebrew-grade provider (below).
4. The **Scribe** turns the transcript into summary + decisions + tasks.

This is honestly a *better* architecture than depending on Meet's AI: **one transcription path for
everything** — Meet recordings, dropped Zoom mp4s, phone voice notes, in-person recordings — instead
of two code paths with different quality profiles. And it makes the platform choice low-stakes: we
depend on Meet only for file delivery, so switching back costs us almost nothing.

### Hebrew ASR — needs a one-day bake-off before Phase 2

Reported accuracy, worth verifying on *our* audio rather than trusting benchmarks:

| Option | Note |
|---|---|
| **ElevenLabs Scribe** | Best reported WER (~3.1% FLEURS), does diarization — speaker labels are what a decision log needs |
| **Speechmatics** | Claims ~96% word accuracy on Hebrew specifically |
| **ivrit.ai Whisper** | Israeli open project, 3,300+ hrs of Hebrew; Hebrew-tuned Whisper beats vanilla Whisper |
| **Whisper / Gemini** | **What we already have wired.** Weaker on Hebrew but zero integration cost — the baseline to beat |

**Action: run one real recording through all four, compare, pick.** One day of work that determines
the quality ceiling of the entire company memory — worth doing properly. Note that mixed Hebrew/
English (how we actually talk) is the real test case, not clean Hebrew.

### The remaining downsides of switching to Meet, honestly

1. **Migration is on us** — recurring meetings move, and external parties (clients, candidates) have
   to join Meet. Zoom is the default in Israeli business; some enterprises prefer it.
2. **Explicit consent prompts** (Google, Apr 2026) for recording — trivial internally, small friction
   on a client call.
3. **Artifacts are per-organiser** — the recording lands in *whoever organised the meeting's* Drive.
   Needs domain-wide delegation or a convention (same organiser always). A real operational gotcha.
4. **API setup** — Google Cloud project + service account with Meet/Drive scopes. Moderate, and we've
   done exactly this before (note the existing gotcha: gcloud ADC Drive scopes are blocked, so
   `drive-to-gcs` authenticates with a service-account key file — same pattern applies).
5. **You still need the file-drop path** for anything not on Meet — which we're building anyway.

**Net: yes, basically just Google Meet — but for recording, not transcription.** The Business
Standard upgrade is no longer required for HQ's sake. And since Phase 1's drop-a-recording path works
regardless of platform, **this decision doesn't block anything** — we can stay on Zoom through Phase
1 and switch whenever convenient.

---

## 6. Surfaces

Its own app (§1), reusing our shell *components* but with its own navigation and its own bundle.

| Screen | What | Phase |
|---|---|---|
| **Ask** | the chat. Every answer cites atoms; every citation clicks through to source. An uncited HQ is a liability. | 1 |
| **Capture / Inbox** | drop zone, quick-note, voice note, plus the low-confidence review queue. **Mobile-first.** | 1 |
| **Sources** | connector health + the playable pipeline inspector. Boring; it's what keeps trust. | 1 |
| **Pulse** (home) | the wow. Live Brain panels: what happened today, decisions this week, goals, who's on what, what's stale, what's unanswered. | 5 |
| **Timeline** | chronological river of meetings · decisions · docs · tasks, filterable by person/project/kind. Makes *"what did we decide in March"* two clicks without asking. | 5 |
| **Cost** | what running the company on AI costs, by worker and by source. §7. | 5 |
| **Constellation** | the entity graph. Prettiest, least load-bearing — build last. | 5 |

---

## 7. The staff — HQ is one builder agent, the staff are its crews

> *"We can have an HQ agent on our builder and have the crew as crews in our infra, then all the LLM
> usage is free and you use the same API."*

**Yes — and this is better than what I had.** I'd proposed four separate agents. One agent with the
staff as crews is the stronger shape, and I checked it against the code rather than assuming:

- **Per-crew versioning already exists** (`builder_crew_versions`). This was my only real objection to
  crews — that iterating on the Scribe would force a republish of the Chief of Staff. It doesn't.
  Each crew versions and publishes independently.
- **The agent-level cortex is shared across crews** — so *"you work for Lybi, here is the company,
  here are the people, here is how we talk"* is written **once** and every worker inherits it. Four
  separate agents would have meant four copies drifting apart. This is the real win.
- **Agent-level fields, enums and dynamic contexts are shared too** — one company vocabulary.
- **Cost attribution is free, with no schema change.** `llm_usage` already has both `agent_name` and
  `crew_member`. With `agent_name='hq'`, HQ spend is one `WHERE` clause away, broken down per worker
  by `crew_member`. **This deletes the "tier tag" task from Phase 0 entirely** — I'd budgeted a
  migration for something your shape gives us for nothing.

| Crew | Runs | Does |
|---|---|---|
| **Ask** | on demand | retrieval + answer, with citations. The only genuinely conversational one. |
| **Scribe** | every new transcript | meeting → summary + one atom per decision (with the quote) + **real tasks on our existing board** + open questions → the Agenda sidebar |
| **Librarian** | every new atom | classify, dedup, link, **flag contradictions** — *"the brand doc says #7C3AED, the Figma export says #6D28D9"* |
| **Chief of Staff** | daily tick + on demand | the Pulse and the morning brief: what slipped, what's blocked, *"you decided X two weeks ago and nothing moved"* |

### The one honest gap — and it's already solved

Crews are normally **conversation phases**: a user talks, the dispatcher routes to the current crew,
transitions move between them. But three of our four staff aren't conversational at all — they're
**background jobs triggered by events** (a transcript landed · an atom was created · it's 08:00).
Nobody is talking to them.

So the question was whether the engine can invoke a *specific* crew, headlessly, with a payload.
**It can, today, with no new engine work:**

- `POST /:slug/conversations/:convId/messages` already accepts **`overrideCrewId`** — pin the exact
  crew for a run. (`runtimeRoute.js:743`)
- `BuilderRunner.runOnce({...})` is a directly callable single-turn function — no HTTP needed.
- **There's already a precedent for exactly this pattern**: the **Profiler** runs a background LLM
  pass decoupled from the conversation, with its own `.../profiler/refresh` endpoint and its own run
  log. The staff are the same shape.

**All that's missing is thin glue:** a small job runner that keeps one long-lived conversation per
worker, posts the payload with `overrideCrewId`, and reads the output — driven by the existing
`scheduler-tick` for time-based runs and by our own ingestion events for the rest. That's a day, not
a phase, and it's the single highest-leverage piece of plumbing in this plan: it's what turns
"AI worker" into "a crew you can edit in the builder plus a trigger".

### The Cost page

Since attribution is free, the only thing left is the *view* — and it can wait to Phase 5. It should
be its own page rather than a filter on the admin usage screen, because the question differs in kind.
Admin asks *"which model cost what for which client"*. HQ's Cost page asks:

- what does running the company cost per week, and is it trending up?
- **which crew is the pig?** (usually whichever runs on every atom — the Librarian)
- ingestion vs answering — embeddings are noise; the daily Scribe / Chief-of-Staff passes are the
  real line item
- cost per meeting ingested, cost per question answered

---

## 8. Same repo, one app at `lybi.ai/hq`

> *"The tool is a whole different tool (should it be a different codebase even?) but the engine to
> run things on the server should be the same for sure."*

Agreed on the engine. On the repo, my recommendation is **one repo with a hard internal boundary and
a separate build target + separate host** — which gets you nearly all the benefit of a second repo
without the cost.

**Why not a second repo:** HQ needs the V2 engine, the Pinecone services, transcription, Drive sync,
GCS, the task board DB, `llm_usage` and auth. Split the repo and you either duplicate all of that or
build an API surface between the two — for a 3-person team that's a second deploy pipeline, second CI,
second env-var set and a second dependency-upgrade treadmill, forever. HQ also needs **read access to
builder state and the task DB**; same repo and same process makes that a function call instead of an
authenticated cross-service API.

**How we get the separation anyway:**

- **Server** — HQ code in its own `hq/` folder with its own route mount, consuming shared services
  and the V2 engine **as libraries**. Dependency is strictly one-directional: `hq/` may import from
  `services/` and `builder/`; **nothing in the product ever imports from `hq/`.** That's a rule a
  lint check can enforce, and it's what actually keeps the tiers clean.
- **Client** — `src/hq/`, mounted at **`lybi.ai/hq`**, lazy-loaded.
- **Auth** — `/hq` locked to our three Google accounts. Day one, not later.

### On the separate host — you were right to push back; drop it

I'd recommended a separate build target at `hq.lybi.ai`. **Checking the code, the argument for it
collapses.** `App.tsx` already lazy-loads every heavy route (`lazy()` + `Suspense`, lines 2–22), so
mounting HQ as a lazy route means **customers never download a byte of it anyway** — which was the
entire benefit I was claiming. The remaining concern (exposure) is solved by an auth guard, not by a
hostname.

So: **`lybi.ai/hq`**, zero new infra — no second Firebase site, no DNS, no extra deploy script. The
`src/hq/` folder boundary still gives us the clean separation, and if it ever *does* want its own
host or its own repo, that's a move rather than a rewrite. This was over-engineering on my part.

---

## 9. Permissions — the plain-language version

> *"I don't understand the question."*

Fair — I asked it badly. Here it is properly.

**The question was:** does HQ need to control who can see what? **Answer: no.** Three people who
already see everything — building per-item permissions would be real work for zero benefit. Everyone
sees everything. That's a genuine simplification and we should take it.

**Client data simply never enters HQ** — agreed, and that's a cleaner rule than what I first wrote.
I'd proposed ingesting it with a `client` flag and filtering it out at query time. Not ingesting it
at all is strictly safer: a filter is one bug away from leaking, an un-ingested document cannot leak
at all.

**Draw the line at *data*, not at *clients*.** HQ absolutely should know **about** our clients — who
they are, what we agreed, what was said on the call, contract terms, what we're building for them.
That's our business and it's exactly what HQ is for. What never comes in is **their data**: client
sales tables, end-user conversations, Freeda users' health records, banking onboarding submissions.

**So the control is an allowlist at the source, not a flag on the atom.** A source has to be
explicitly connected; nothing is watched by default.

> ⚠️ **The realistic failure mode, and it's concrete.** Our Google Drive **already contains client
> data** — `drive-to-gcs.service.js` mirrors client CSV exports out of Drive folders (zer4u,
> hypertoy) into GCS. So *"watch our Drive"* must never mean the whole Drive. The Drive watcher takes
> an **explicit list of folder IDs**, and the client-export folders are not on it. Same for GCS
> prefixes. The other realistic path is someone dropping a client export into HQ by hand — worth a
> cheap guard in the Librarian (spot an obvious client data dump → quarantine, don't index).

We keep a `visibility` column on the atom anyway as a cheap backstop for when something slips
through, but it is **not** the primary control. The primary control is that we never point HQ at it.

---

## 10. Phasing

| Phase | Scope | Est. |
|---|---|---|
| **0 · Skeleton** | `hq_atoms`/`hq_sources`/`hq_links`, Pinecone namespaces, `/hq` route + auth guard, capture endpoint, the **`hq` builder agent** + its crews, the **headless job runner** (§7) | ~3 days |
| **1 · Drop & Ask + 📱Mobile** | file/URL/text/**voice** capture → normalise → classify → index. Ask **with citations**. Sources health. **PWA capture on the phone.** | 2 wks |
| **2 · Meetings** | Hebrew ASR bake-off → Meet/Drive recording connector → **Scribe** → decisions + tasks | 1–2 wks |
| **3 · Watchers + connectors** | generalise the Drive watcher · **Notion API connector** (~2d) · one-time OneDrive→Drive dump (Noa) · docs tree + builder state | ~2 wks |
| **4 · Live tools** | task board · builder state · calendar · usage as tools | ~1 wk |
| **5 · Surfaces** | Pulse · Timeline · **Cost** · Constellation | ~2 wks |
| **6 · HQ-first** | authoring in HQ, write-back where cheap, retire Notion | ongoing |

**Order is deliberate: read everything → capture meetings → then ask people to write here.**

---

## 11. The risk, and the answer to it

**A brain nobody feeds dies — and you cannot decree three people out of Drive and Notion.**

HQ has to become the *fastest* path: it answers what nothing else can, **capture is one tap from the
phone**, and anything made elsewhere still shows up within minutes so slipping costs nothing.
Answering is the habit-forming loop; writing follows it.

So the build is weighted toward what's **automatic** (auto-recorded meetings, watched folders) over
what needs **discipline** (writing notes here) — Phases 1–3 are all automatic — and the mobile
capture surface is pulled all the way forward into Phase 1 because that's the one piece that makes
constant feeding effortless rather than virtuous.

---

## 12. Still open

1. **Hebrew ASR bake-off** — one day, four providers, one real recording. Determines the quality
   ceiling of the whole company memory. Blocks Phase 2 only.
2. **When do we actually move to Meet?** Not blocking — Phase 1 ingests a dropped recording from any
   platform. Can happen whenever it's convenient.
3. **Meeting-organiser convention** — recordings land in the organiser's Drive (§5.4). Do we always
   organise from one account, or set up domain-wide delegation?
4. **Which Drive folders does HQ watch?** (§9) — needs an explicit list, and the client-export
   folders must not be on it. A 10-minute conversation, but it has to happen before Phase 3.
*Settled 2026-08-02: Notion gets a real API connector, not a one-off export (§4).*

**None of these block a start.** #1 is needed before Phase 2, #4 before Phase 3, #2 and #3 whenever.

---

## 13. On GO — the first day

So a green light turns into motion immediately, Phase 0 in order. Nothing here depends on an
unanswered question.

1. **Migration** — `hq_atoms`, `hq_sources`, `hq_links` (§4). Include `visibility` now even though
   the real control is source allowlisting (§9) — retrofitting it later is the painful path.
2. **Pinecone** — create the `hq-*` namespace family in the existing `lybi` index. No new index.
3. **The `hq` builder agent** — created in the builder like any other, with four crews: Ask, Scribe,
   Librarian, Chief of Staff (§7). Company context goes in the **agent-level cortex**, once.
4. **The headless job runner** (§7) — one long-lived conversation per worker crew, invoked with
   `overrideCrewId`, driven by `scheduler-tick` for time triggers and ingestion events for the rest.
   This is the keystone; build it before any worker logic.
5. **`/hq` route + auth guard** — three Google accounts, lazy-loaded (§8). `src/hq/` on the client,
   `hq/` on the server, one-directional imports.
6. **Capture endpoint** — text/paste (structure preserved + optional source URL), file, URL. The
   normalise → classify → chunk → embed path, wired straight through to Ask so the loop closes on
   day one even with three atoms in it.

**First real proof it works:** drop the brand doc into Capture, ask HQ *"what's our main palette
colour"*, get the right hex **with a citation** back to the file. That's Phase 0/1 done.

### Before writing any code, re-read

`BUILDER_V2_PHASE_B_ALFRED_HANDOFF.md` (BUILDER_V2.md is stale — trust the code), `KB_V2_RETRIEVER.md`,
`BUILDER_V2_LIVE_BRAIN.md`. And two standing gotchas: builder types are **server-owned**
(`aspect-agent-server/builder/types/index.ts`) — the client copy is generated and must never be
hand-edited; and Pinecone namespaces are **global** within the shared `lybi` index.

*Settled 2026-08-02: `lybi.ai/hq`, no separate host · HQ is one builder agent with the staff as crews ·
client data is never ingested.*
