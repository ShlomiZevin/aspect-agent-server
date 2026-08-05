# Lybi HQ — the central company brain

> **Status: 🚀 MVP BUILT 2026-08-03 — live at `/hq`, awaiting review.**
> Phase 0 + the Meeting Sessions MVP (§2b) are built and verified end-to-end against the real DB,
> Pinecone and LLMs: drop → index → Scribe → Ask with citations. **Implementation notes live in
> [`hq/README.md`](../../hq/README.md).** Still to come: the Notion import needs `NOTION_TOKEN`
> before it can run, and everything from §10 Phase 2 onward is unbuilt.
> Supersedes `BRAIN_CENTER.md` (same doc, renamed once the name was settled).

### What shipped (2026-08-03)

| Area | Status |
|---|---|
| `hq_atoms` / `hq_sources` / `hq_links` + migration | ✅ run against the live DB |
| Notion connector (link → page **or database** → markdown) | ✅ built, **needs `NOTION_TOKEN` to run** |
| Ingest: normalise → chunk → embed → Pinecone (`hq` namespace) | ✅ verified |
| Scribe: summary · decisions (with quotes) · actions (with owners) · open questions | ✅ verified on a real transcript |
| Ask with clickable citations | ✅ verified, including correct refusal when it doesn't know |
| Bilingual retrieval (Hebrew question ↔ English content) | ✅ built after the naive version failed the test |
| `/hq` client: Ask · Drop · Library · Atom detail · Sources | ✅ own lazy chunk, 31 kB (10 kB gzip) |
| Cost attribution via `llm_usage` (`agentName:'hq'`) | ✅ free, no migration — as designed in §7 |

Two findings worth keeping:
- **The lazy chunk confirms §8** — HQ builds as its own 31 kB bundle, so no customer route downloads
  it. The separate-host idea really was unnecessary.
- **Cross-lingual retrieval had to be built.** `text-embedding-3-small` scored a Hebrew question at
  0.26 against English content versus 0.43 for the English equivalent — right on the threshold. Ask
  now retrieves in both languages and merges. This would have looked fine in an English-only demo
  and failed in real use.
> Sister docs: [BUILDER_V2.md](./BUILDER_V2.md) (the engine this runs on),
> [KB_V2.md](./KB_V2.md) + [KB_V2_RETRIEVER.md](./KB_V2_RETRIEVER.md) (retrieval),
> [BUILDER_V2_LIVE_BRAIN.md](./BUILDER_V2_LIVE_BRAIN.md) (panel renderers we reuse),
> [ADMIN_V2.md](./ADMIN_V2.md), [task-board.md](../features/task-board.md).

---

## 0. The name

**Lybi HQ.** Route `/hq`, served at `lybi.ai/hq`. Its AI workers are **the staff**.

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

## 2. Decisions locked

> **Canonical list: [`LYBI_HQ_DECISIONS.md`](./LYBI_HQ_DECISIONS.md)** — every settled decision,
> numbered, with the reasoning and the date. The table below is the original 2026-08-01 snapshot,
> kept for context; where the two differ, the register wins.

| # | Decision |
|---|---|
| Name | **Lybi HQ** · `lybi.ai/hq` · workers = "the staff" |
| Placement | Its own top-level surface. **Not** a view inside the builder. |
| Engine | **Same server engine (Builder V2)** — confirmed. Tool is separate, engine is shared. |
| **Shape** | *Superseded 2026-08-05 → decision **C2**: two tiers. Substrate crews (Scribe · Ask · Keeper) stay crews of the one `hq` agent; the business agents from Noa's deck become separate builder agents.* |
| Codebase | **Same repo, hard-separated inside it. One app at `lybi.ai/hq`, lazy-loaded** — no separate host needed. See §8. |
| LLM cost | **Free** — falls out of the agent/crew shape, no schema change. See §7. |
| Mobile | Capture-and-ask from the phone is what keeps HQ fed. *Deferred out of the narrowed MVP (§2b) — thin version only.* |
| OneDrive | **No connector.** Noa moves the content into Google Drive once; we only ever watch Drive. |
| Notion | **API connector** (~2 days with `notion-to-md`) — gives refetch-a-page, incremental sync, comments, and paste-a-link. Shlomi's call; my export-only recommendation was wrong. See §4. |
| Codebase indexing | **Skip deep code indexing.** Index the docs tree + builder state — understanding the *product and builder* is what matters, not source lines. |
| Meetings | **Google Meet for auto-recording + Drive delivery — but we do our own transcription.** See §5. |
| Permissions | No per-item permissions. **Client data is never ingested at all** — an ingestion-time rule, not a query-time filter. See §9. |

---

## 2b. 🎯 THE MVP — "Meeting Sessions", the first HQ drop surface

> **Locked with Shlomi 2026-08-02.** Narrower than the earlier version of this section, deliberately.

**The loop: drop a call recording into HQ → minutes later you have a summary, a decision list, action
items already on the task board, and the meeting is held there permanently — speaker-labelled,
searchable, and playable back to the exact moment anything was said.**

**We build the drop pipe as general infrastructure, but meetings are the only content type we take
end-to-end in the MVP.** That's the right shape: the pipe is reusable for every later connector, the
payload stays focused, and meetings are the content that is **100% lost today** and retrievable no
other way — so it's the only piece obviously worth the build on day one.

> ### 🔄 UNCONFIRMED — 2026-08-02: meetings may already be transcribed into Notion
>
> Noa reports our meetings are **already being transcribed into Notion**. If that holds, it changes
> the MVP's *source*, not its shape — the atom model, drop pipe, Scribe crew and holder are all
> identical; only where transcripts come from moves. It would also mean **HQ launches with months of
> history instead of accumulating from zero**, which is the difference between useful on day one and
> useful in three months.
>
> **Seven questions for Noa — one of them decides everything:**
>
> 1. **⭐ Full transcripts, or only summaries?** *This is the decisive one.* Full transcripts let us
>    re-derive decisions with our own prompts and **re-run the whole archive whenever the Scribe
>    improves**. Summaries are lossy and permanently freeze someone else's judgement about what
>    mattered — you can never get the detail back.
> 2. **Are speakers labelled?** No speakers → no owner on an action item, which is most of the
>    Scribe's value. Still fine for *"what did we discuss/decide"*, not for *"who owns it"*.
> 3. **What tool produces them?** Determines quality, Hebrew handling, whether it has its own API,
>    and whether we depend on a third party whose Notion output format can change under us.
> 4. **Hebrew, English, or mixed — and how good?** If it already handles our Hebrew well, that
>    answers the ASR bake-off for free.
> 5. **How far back does it go?** That's the size of the free head start.
> 6. **Every meeting, or only some?** A partial archive with *unknown* gaps is a trust problem — HQ
>    would answer confidently from an incomplete record.
> 7. **Automatic, or does someone paste it in?** Decides whether it keeps working without us.
>
> **Branch A — full transcripts with speakers:** the MVP becomes *Notion connector → pull the archive
> → Scribe → hold + Ask*. Transcription work defers entirely while the existing tool keeps feeding.
> Faster, and far more useful on day one.
>
> **Branch B — summaries only, or no speakers:** ingest the archive anyway as **history** (genuinely
> valuable), **and** still build the recording → transcript path for going forward. The archive is a
> free head start either way.
>
> **Either way the archive gets ingested.** The only open question is whether we still build capture.
> Note this also vindicates choosing the **Notion API connector over a one-off export** (§4): if
> transcripts are actively landing there, we need incremental sync, not a snapshot.
>
> *Do not rewrite the MVP until Noa confirms. The section below is Branch B, the safe assumption.*
>
> ---
>
> ### 🧪 PROPOSED Phase 1 (Shlomi, 2026-08-02): the drop-off accepts **Notion links**
>
> Smallest possible first phase — paste a Notion link into HQ, HQ pulls it in. **~2–3 days** instead
> of the 2-week recording MVP, and it validates the archive's real quality before we commit to
> anything.
>
> **Correction to the framing:** a Notion link is *not* publicly fetchable (§4). Pulling a page from
> a link needs the API token **and** that page shared with our integration — so "drop a link" is not
> a lighter-weight alternative to the connector, it's **the same setup with a smaller UI**. That's
> fine, and actually the point: once the setup exists, full sync is a small increment on top.
>
> **⭐ The upgrade: accept a link to a *database*, not just a page.** The transcripts almost certainly
> live in a Notion **database** ("Meetings"), one page per meeting with date/attendee properties. So
> instead of pasting a link per meeting, paste the **database** link **once** and we pull every row.
> Same code path (`databases.query` instead of `blocks.children`), roughly half a day more, and **one
> paste ingests the entire archive**.
>
> **What Shlomi does in Notion — ~10 minutes, once:**
>
> 1. **Create an internal integration** — notion.so → Settings → Connections → *Develop or manage
>    integrations* → **New integration**. Name it `Lybi HQ`, associate it with our workspace, type
>    **Internal**.
> 2. **Capabilities — tick these now**, because adding them later means editing the integration and
>    re-sharing: **Read content** · **Read comments** (§4 — comments are where decisions often hide) ·
>    **Read user information**. No insert/update capability needed; keep it read-only.
> 3. **Copy the Internal Integration Secret** (starts `ntn_`; older ones `secret_`) → server env as
>    `NOTION_TOKEN`.
> 4. **Share the content with it** — open the Meetings database (or the top-level page above it) →
>    `⋯` menu → **Connections** → **Add connection** → `Lybi HQ`. **This cascades to child pages**, so
>    sharing one top-level parent covers everything under it.
> 5. **Grab the link** — the 32-char hex in the URL is the ID. For a database it's the part *before*
>    `?v=`.
>
> **What we build:** token config + resolve a pasted URL to page-or-database + `notion-to-md` +
> normalise → atoms + index → Ask over them. ~2–3 days total.
>
> **What it does and doesn't get us.** It gets the whole archive in, indexed and askable, and proves
> the content quality immediately. It doesn't yet sync automatically — but that's a small increment
> (the `search` + `last_edited_time` filter on the scheduler tick we already run). And if the tool
> keeps writing new meetings into Notion, **that increment means we may never build transcription at
> all** — that's Branch A, reached cheaply.
>
> **One reassurance worth stating:** ingesting means **we own a copy**. The atoms live in our
> Postgres + Pinecone. If the transcription tool dies or Notion goes away, everything ingested up to
> that point is still ours. The dependency is on *future* capture, never on the archive we've already
> taken.

### What's in

1. **Drop** — the capture page. Accepts files generally; audio/video is what we process end-to-end.
2. **Transcribe — with speakers.** Provider decided by the bake-off (§5): **try OpenAI
   `gpt-4o-transcribe-diarize` first, fall back to ElevenLabs Scribe v2 if it isn't good enough.**
   Build it behind a small provider interface — `transcription.service.js` is already two-provider
   shaped, so a swap stays a config change, never a rewrite.
3. **Scribe** — summary · one atom per decision · **action items → real tasks on the existing board**
   · open questions.
4. **Hold** — the Meetings library. List + detail: date, participants, duration, summary, decisions,
   actions, and the full speaker-labelled transcript.
5. **Index as it lands** — everything embedded into the `hq-meetings` namespace during ingestion.
   Free, since it's in the pipe anyway, and it makes Ask a wiring job rather than a build.

### Two details that decide whether it gets trusted

- **Keep the recording, and make the transcript seek it.** Per-segment timestamps → click any line
  (or any decision) and jump to that moment in the audio. This is what earns the word "holder", and
  it's what makes people believe a summary: verification is one click, not a re-listen.
- **Everything must be correctable.** The Scribe *will* miss an owner or mangle a decision. If you
  can't fix it in place, you stop trusting it within a week. Editable summary/decisions/actions, and
  editable speaker names (which also covers us if reference-clip name-mapping doesn't pan out).

### What's out

Meet connector (you drag the file in) · Drive watcher · Notion · mobile · Pulse · Timeline ·
Constellation · Librarian · Chief of Staff · Cost page.

**Ask is the one judgement call.** It's *nearly free* — indexing already happens in the pipe, and the
Ask crew is a KB Retriever pointed at `hq-meetings`. Recommendation: **include it, scoped to meetings
only** (~3 days), because without it this is a meeting-notes tool rather than the start of a brain.
It's also the clean line to cut if we want the first ship smaller.

**Effort: ~2 weeks** for the meetings pipeline + holder, **+~3 days** if Ask is in.

**The test that says it worked:** *finish a real call, drop the recording, and get a decision list
you'd actually send to Noa and Hila — with the tasks already on the board and each decision clickable
back to the moment it was said.* If that lands, the rest of the plan is worth building. If it
doesn't, we found out in two weeks.

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

### ⚠️ Speakers: our currently-wired path gives NONE

I said we could start on the transcription we already have. **That was wrong, and it matters.**
`transcription.service.js` calls **`whisper-1`**, and **Whisper does not output speaker labels at
all** — not names, not even "Speaker 1". It returns one undifferentiated wall of text. (It's also
now legacy — on OpenAI/Azure retirement schedules.)

That's disqualifying rather than inconvenient, because **the Scribe's output depends on it.** Action
items need an owner: *"Noa will redo the pricing page"* is useful, *"it was decided the pricing page
will be redone"* is not. So **diarization is MVP-critical, not a Phase-2 refinement**, and the MVP
must start on a diarizing provider — not on what's wired today.

| Option | Speakers? | Hebrew? | Note |
|---|---|---|---|
| **`gpt-4o-transcribe-diarize`** | ✅ built-in, `diarized_json`, labels `A:`/`B:` | 100+ languages (Hebrew not explicitly confirmed — **verify**) | Same OpenAI SDK we already call → smallest integration change. **Plus the feature below.** |
| **ElevenLabs Scribe** | ✅ up to 32 speakers | ✅ Hebrew, among 99 languages | Best reported WER (~3.1% FLEURS), char-level timestamps. Strongest *confirmed* pairing of both needs. |
| **Gemini** | ⚠️ prompted, not a formal feature — steerable ("Speaker A is Alice") | ✅ | An LLM doing diarization; can drift over long audio. Fine as a fallback, not as the spine. |
| **ivrit.ai Whisper** | ❌ — it's a Whisper fine-tune, so it inherits "no diarization" | ✅ best-in-class Hebrew | Would need pairing with a separate step (pyannote / WhisperX). *Reasoned, not directly verified.* |
| **Speechmatics** | likely ✅ (core feature) — **verify** | ✅ claims ~96% | Verify both together before counting on it. |
| **`whisper-1`** *(what we have)* | ❌ **none** | weak | **Not viable for the MVP.** |

### 🎯 The bit that's better than you asked for — real names, not "Speaker 1"

`gpt-4o-transcribe-diarize` accepts **`known_speaker_names[]` + `known_speaker_references[]`** — up to
**four** reference clips of **2–10 seconds each**, mapping segments onto known people.

We are three people. **Record five seconds of Shlomi, Noa and Hila once, and every meeting from then
on comes back labelled with real names** — no "Speaker A", no manual mapping, no LLM guessing from
context. Ten minutes of setup, permanently. That also closes the Meet tradeoff from earlier: Meet's
native transcript knows real names but can't do Hebrew; this gives us both.

*(Even without it, three known participants makes `A/B/C` → names trivially inferable by the Scribe.
The reference clips just remove the guesswork.)*

### The bake-off — what to actually score

*Status: Shlomi hands-on tested **ElevenLabs Scribe v2** (2026-08-02) — looks great. OpenAI in progress.*

One real recording, ideally a full-length one, through both. **Score the end output, not the
transcript** — a transcript with 8% WER can still yield a perfect decision list, while one with 3% WER
but broken speaker mapping yields a confidently wrong one. So run each transcript through a
Scribe-style prompt and compare **the decision lists**.

Ranked by how often they're what actually breaks:

1. **Speaker consistency across the *whole* recording.** Does Speaker A at 00:05 stay Speaker A at
   45:00, or silently get re-labelled halfway? This is the classic failure, it's invisible in a
   30-second sample, and it corrupts a decision log without ever looking wrong.
2. **Overlapping speech and interruptions.** Clean turn-taking is easy; three people talking over
   each other on a call is where diarization actually falls apart.
3. **Hebrew/English code-switching mid-sentence** — how we really talk. Not clean Hebrew.
4. **Our vocabulary** — Lybi, Freeda, Alfred, Aspect, crew, addon, Pinecone, Zer4U. Both support
   keyterm prompting (Scribe takes up to 1000 terms); test whether feeding our glossary fixes mangled
   product names, because it'll appear in every meeting we ever record.
5. **Long-file handling.** A 90-minute call. Note our existing service compresses >24 MB for OpenAI;
   provider limits differ.
6. **Per-segment timestamps** — needed later for *"jump to where this was decided"*.
7. **Cost per hour** at our volume. Probably trivial for 3 people, but worth knowing.

> **Keep the test recording.** It becomes our regression fixture — every future provider swap re-runs
> the same file, so quality changes are measured rather than guessed.

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

**Net: yes, basically just Google Meet — but for recording, not transcription.** And since the MVP's
drop-a-recording path works regardless of platform, **this decision blocks nothing** — we can stay on
Zoom (or on a local screen recording) through the MVP and switch whenever convenient.

> ⚠️ **Correction (2026-08-02).** An earlier version of this section said *"the Business Standard
> upgrade is no longer required."* **Wrong.** Establishing that Meet can't transcribe Hebrew removed
> the need for Business Standard's *transcription* — but **native Meet recording is itself a Business
> Standard+ feature.** Business Starter and free Gmail have **no recording at all**. Confirmed live:
> Shlomi has no recording option in Meet, which means boostart.io is on Starter (or an admin has the
> toggle off).
>
> So the Meet auto-record story — the reliability win this whole section rests on — **has a
> prerequisite: upgrading to Business Standard** (roughly +$7/user/month; about +$21/month for the
> three of us). Small, but it is a real dependency and it was not previously written down.
>
> **It does not block the MVP.** A local screen recording produces exactly the file we need. The
> upgrade buys *automatic* capture, which is what stops recording from depending on someone
> remembering — worth doing before we rely on meetings being captured by default, not before we start
> building.

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

### Keeping it separate in practice — folder convention only (decided 2026-08-03)

No worktree, no submodule, no second repo. **Folder naming is the whole mechanism**, and it's already
the house pattern: the server has `builder/`, `bi/`, `alfred/`, `whatsapp/`; the client has `builder/`,
`live-chat/`. `hq/` is simply the next one. Everything HQ lives in those two folders and commits are
prefixed `hq:`, so HQ files sort together and stay legible in the SCM view.

**Pair it with one habit: land the wiring commit first.** HQ touches ~4 core files *ever* — the route
in `App.tsx`, the router mount in `server.js`, the schema export, and deps. Do those as a single small
commit up front and merge it. Every change afterwards is then purely under `hq/`, and the git view
stays clean on its own. Skip this and those touches trickle in over weeks — which is exactly the
core-vs-HQ mixing we're trying to avoid.

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
| **1 · 🎯 MVP — Meeting Sessions** | drop a recording → diarised transcript → **Scribe** → summary/decisions/tasks → the Meetings holder (seekable audio, editable). Ask scoped to meetings. **§2b** | ~2 wks (+3d Ask) |
| **2 · Widen the drop** | text/paste/URL/file through the same pipe · 📱 mobile PWA capture · Sources health | 1–2 wks |
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
6. **Capture endpoint** — general file drop, with audio/video as the first type taken end-to-end
   (§2b). Normalise → classify → chunk → embed.
7. **Transcription provider interface** — `gpt-4o-transcribe-diarize` first, ElevenLabs Scribe v2
   behind the same interface as the fallback. Decide with the bake-off (§5), not by guessing.

**First real proof it works:** drop a real call recording, get back a decision list you'd send to Noa
and Hila, with the tasks on the board. That's the MVP (§2b).

### Before writing any code, re-read

`BUILDER_V2_PHASE_B_ALFRED_HANDOFF.md` (BUILDER_V2.md is stale — trust the code), `KB_V2_RETRIEVER.md`,
`BUILDER_V2_LIVE_BRAIN.md`. And two standing gotchas: builder types are **server-owned**
(`aspect-agent-server/builder/types/index.ts`) — the client copy is generated and must never be
hand-edited; and Pinecone namespaces are **global** within the shared `lybi` index.

*Settled 2026-08-02: `lybi.ai/hq`, no separate host · HQ is one builder agent with the staff as crews ·
client data is never ingested.*
