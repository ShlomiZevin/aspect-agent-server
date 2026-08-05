# Lybi HQ — decision register

> **The canonical list of what's settled.** Locked 2026-08-05.
> Detail lives in [`LYBI_HQ.md`](./LYBI_HQ.md) (substrate + MVP) and
> [`LYBI_HQ_AGENTS.md`](./LYBI_HQ_AGENTS.md) (Noa's six agents).
>
> A locked decision is not permanent — it's *settled until someone reopens it deliberately*. If one
> gets reversed, edit the row and note the date, don't leave two versions floating.

---

## A · Identity & placement

| # | Decision | Why |
|---|---|---|
| A1 | **Name: Lybi HQ.** Route `/hq`. The AI workers are "the staff". | About *running the company*, not about being a brain. "Live Brain" was already taken twice — the customer side-panel and the pitch deck — and a third would have made every doc ambiguous. |
| A2 | **Internal tier only.** Not a product, not part of the builder, not an agent in the roster. No customer ever sees it. | It's a fourth thing on lybi.ai alongside the tool, the KB and the builder. |
| A3 | **Its own top-level surface**, not a view inside the builder admin. | You go to HQ to run the company; you go to the builder to build agents. |
| A4 | **`lybi.ai/hq` — no separate host or bundle.** | `App.tsx` already lazy-loads routes, so customers never download it anyway. Confirmed at build: HQ is its own 35 kB chunk. The separate-host idea was over-engineering. |

## B · Code structure

| # | Decision | Why |
|---|---|---|
| B1 | **Same repo.** Server `aspect-agent-server/hq/`, client `aspect-react-client/src/hq/`. | HQ needs the engine, Pinecone, transcription, GCS, the task DB and auth. A second repo means duplicating all of it or building an API between — a second pipeline, CI and dependency treadmill for three people. |
| B2 | **Folder convention only** — no worktree, no submodule, no second repo. | Already the house pattern: `builder/`, `bi/`, `alfred/`, `whatsapp/`, `live-chat/`. `hq/` is the next one. |
| B3 | **One-directional imports.** `hq/` may import product code; **nothing in the product may import `hq/`.** | The rule that actually keeps the tiers separate in one repo. |
| B4 | **Wiring commit first.** | HQ touches ~4 core files *ever*; landing them in one commit means every later change is purely under `hq/` and the git view stays clean. Done: only `server.js` and `App.tsx`. |

## C · Architecture

| # | Decision | Why |
|---|---|---|
| C1 | **Same server engine (Builder V2)**, reused as an internal framework. | Buys the prompt runtime, versioning, publish, run logging and cost tracking instead of rewriting them. |
| C2 | **Two tiers of agents.** *Substrate crews* (Scribe · Ask · Knowledge Keeper) = crews of one `hq` builder agent. *Business agents* (Domain Architect, Alfred, Studio, Sales Copilot, Growth Studio) = separate builder agents. | Per-crew versioning + a shared cortex is right for the substrate. The business agents have genuinely divergent KBs and permissions — and Growth Studio is barred from confidential client knowledge, which a shared cortex would leak. *(Revised 2026-08-05 from "one agent, all staff as crews".)* |
| C3 | **One normalised Atom row** for everything indexed. | Retrieval, timeline, dedup and permissions stay one code path; connectors stay thin. |
| C4 | **Storage in three tiers.** Own what's authored in HQ · mirror+index external docs with a pointer and content hash · never copy live data (tasks, builder state, calendar, billing) — expose as tools. | Changes daily → tool. Changes monthly → index. We wrote it here → own it. |
| C5 | **Pinecone `hq` namespace** inside the existing shared `lybi` index. | No new index; the KB workbench and `kb_links` keep working. |
| C6 | **Cost attribution is free** — every call tagged `agentName:'hq'` + `crewMember`. | `llm_usage` already has both columns, so company vs client spend separates with a `WHERE` clause. No migration. A dedicated Cost view can come much later. |
| C7 | **Bilingual retrieval.** Ask retrieves with the question in both Hebrew and English and merges on best score. | Not optional: `text-embedding-3-small` scored a Hebrew question at 0.26 against English content vs 0.43 for the English equivalent — right on the threshold, so Hebrew returned nothing. Would have passed an English-only demo and failed in real use. |

## D · Data scope & safety

| # | Decision | Why |
|---|---|---|
| D1 | **Client data is never ingested.** The line is at their **data**, not at clients. | HQ *should* know about clients — meetings, what we agreed, what we proposed. It must never hold their operational data: Zer4U sales tables, Freeda users' health conversations, banking submissions, end-customer PII. |
| D2 | **The control is an allowlist at the source**, never a filter at query time. | A filter is one bug from leaking; an un-ingested document cannot leak. `hq_atoms.visibility` exists as a backstop only. |
| D3 | ⚠️ **The Drive watcher must take an explicit folder list.** | Our Google Drive **already contains client data** — `drive-to-gcs.service.js` mirrors Zer4U/Hypertoy CSV exports out of Drive folders. "Watch our Drive" must never mean the whole Drive. |
| D4 | **No per-item permissions.** Scoping is a **quality** concern, not security. | Three people who see everything. An agent given only relevant context answers better — so it's retrieval config (`kb_links`, per-addon namespaces), not an auth system. |

## E · Connectors

| # | Decision | Why |
|---|---|---|
| E1 | **Drop is the universal fallback** for every connector, and is built first. | Connector late or broken? Paste it, drag it in. **No connector is ever on the critical path** — which is what lets us build them in any order. |
| E2 | **Notion: a real API connector**, not a one-off export. | ~2 days with `notion-to-md`, and it buys refetch-a-page, incremental sync, comments, and paste-a-link. *(Reversed 2026-08-02 — my export-only recommendation was wrong; the effort estimate was what made it look right.)* |
| E3 | **No OneDrive connector.** Noa moves the content into Google Drive once. | Kills a whole connector and a Microsoft Graph app registration. |
| E4 | **No deep code indexing.** Docs tree + builder state only. | Understanding the product and the builder is the actual ask, not source lines. |
| E5 | **Google Meet for auto-recording + Drive delivery only — we transcribe ourselves.** | ⚠️ **Meet does not transcribe Hebrew** (8 languages, Hebrew not among them). Its recording *is* language-agnostic and can be auto-enabled, which was always the real reliability win. Also gives us one transcription path for everything instead of two. |
| E6 | **Meet recording needs Workspace Business Standard.** We're on Starter — no recording at all today. | ~+$7/user/month. **Not blocking**: a local screen recording produces the same file. Buy it when we want capture to be automatic. |
| E7 | **Transcription must diarise.** Try `gpt-4o-transcribe-diarize` first, **ElevenLabs Scribe v2** as fallback, behind a provider interface. | Our wired `whisper-1` returns **no speaker labels at all** — and without speakers the Scribe can't put an owner on an action item, which is most of its value. The interface keeps the swap a config change. |

## F · The MVP (built, awaiting validation)

| # | Decision | Why |
|---|---|---|
| F1 | **First build = "Meeting Sessions".** Drop a recording → diarised transcript → Scribe → summary + decisions + action items onto the existing task board → held permanently, searchable. | Meetings are the content that is 100% lost today and retrievable no other way. |
| F2 | **The drop pipe is built general; meetings are the only kind taken end-to-end.** | The pipe is reusable for every later connector while the payload stays focused. |
| F3 | **Ask is in**, scoped to what's ingested, **with clickable citations**. | Nearly free — indexing already happens in the pipe. An uncited brain is a liability. |
| F4 | **Everything the Scribe produces is correctable in place.** | It *will* miss an owner or mangle a decision. If you can't fix it, you stop trusting it within a week. |
| F5 | **Keep the recording; the transcript seeks it** (per-segment timestamps). | Verification in one click is what makes people believe a summary. |
| F6 | **Styled as Lybi.** Noa's exact palette (`--mag #E0198A`, `--pur #5B1E8A`, the brand gradient), Assistant + JetBrains Mono, the real logo, light default + dark toggle, the chat's bubble/rail/pill language. | It's our headquarters — it should read as unmistakably Lybi, not as a separate tool. |

## G · Noa's agent deck

| # | Decision | Why |
|---|---|---|
| G1 | **Read the deck as a requirements/content spec, not an architecture spec.** Ignore the structural suggestions; build our own way. | Her strength is the domain thinking — what each role does, needs to know, must produce. That content is genuinely useful. |
| G2 | **No substrate phase. Nothing major is missing.** | *(Corrected 2026-08-05.)* I'd claimed five gaps and ~2 weeks of plumbing. Re-checked: per-agent scoping is already `kb_links` + per-addon namespaces; projects are a metadata field; deliverables are an enum value and a good prompt. The agents build on what exists. |
| G3 | **Phase 1 does not change.** | The deck validates it — Sales Copilot needs exactly the meeting pipeline we built. |
| G4 | **Adopt from the deck:** the source-of-truth ordering (approved decision › current spec › product doc › deck › transcript › draft), the per-agent "not needed by default" exclusion lists, and **her Knowledge Keeper spec in place of our Librarian**. | The first settles "which contradicting doc wins"; the second keeps an agent's context clean; the third is strictly better specified than ours. |
| G5 | **Order: validate MVP → Sales Copilot → Domain Architect → Knowledge Keeper → Studio / Growth.** | Sales Copilot first despite the deck's flow, because it pays back from work already done. Knowledge Keeper once there's enough knowledge for inconsistency to actually hurt. |
| G6 | **Build one agent end-to-end before committing to a pattern for all six.** And write 2–3 deliverables properly rather than schematising thirty. | Six roles on paper is not six roles in use. Let the shape emerge from real output. |

---

## Still open — not decisions, things to find out

| # | Question | Blocks |
|---|---|---|
| O1 | **Hebrew ASR bake-off** — one real full-length meeting through the candidates, scored on the *decision list* not the transcript. Watch for speaker consistency drifting across a long recording. Keep the file as a regression fixture. | Automatic meeting capture. Sets the quality ceiling of the whole company memory. |
| O2 | Does `known_speaker_references` work on Hebrew? Four 2–10s clips would give **real names instead of Speaker A/B/C**. | Decides OpenAI vs ElevenLabs. |
| O3 | When do we actually move to Meet, and do we buy Business Standard? | Nothing — drop-a-recording works from any platform. |
| O4 | Meeting-organiser convention — recordings land in the *organiser's* Drive. One account always, or domain-wide delegation? | Automatic capture. |
| O5 | **Which Drive folders does HQ watch?** Needs an explicit list with client-export folders excluded (D3). | The Drive watcher. |
| O6 | Which 2–3 deliverables to write properly first? *Suggestion: Client Brief, Meeting Summary, Agent Knowledge Pack.* | Sales Copilot. |
| O7 | **Who owns Lybi Core** — the shared context every agent inherits? Needs one owner or it drifts. | Nothing yet, but it's the highest-leverage document in the system. |
| O8 | Are Discount / Maccabi / Bank Jerusalem / Bank Hapoalim real live opportunities? | If yes, Sales Copilot moves up further. |
| O9 | `NOTION_TOKEN` + share the meetings database with the integration. | The Notion import, which is coded but has never run. |
