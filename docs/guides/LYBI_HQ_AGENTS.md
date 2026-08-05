# Lybi HQ × Noa's Agent System — how they fit

> **Status: PLAN / for review. Nothing built from this doc.**
> Source: Noa's *Lybi Agents Deck* (31 slides, 2026-08-05) — archived alongside this file as
> `_noa-agents-deck.html`. Read with [`LYBI_HQ.md`](./LYBI_HQ.md) (the substrate, MVP built),
> [`LYBI_HQ_DECISIONS.md`](./LYBI_HQ_DECISIONS.md) (**the canonical decision list**) and
> [`BUILDER_V2_ALFRED.md`](./BUILDER_V2_ALFRED.md) (Alfred already exists).

> ## ⚠️ How to read the deck (Shlomi, 2026-08-05)
>
> **Take the deck as a requirements/content spec, not an architecture spec.** Noa is a product
> designer — her strength here is the *domain* thinking: what each role does, what it needs to know,
> what it must produce, what it should be kept away from. That content is good and worth keeping.
>
> **The structural suggestions — projects, workspaces, permission models, deliverable hierarchies —
> we ignore and build our own way.** An earlier version of §4 below mapped her structure 1:1 onto our
> schema and concluded we had "five real gaps" needing a ~2-week substrate phase. **That was wrong**,
> and §4 has been rewritten. The corrected read: there is no major gap.

---

## 1. The headline: these are two layers, not two plans

Noa's deck specifies **six internal agents**. What we built is **the knowledge substrate underneath
them**. They don't compete — the deck is largely *what HQ is for*.

```
┌── Noa's six agents ─────────────────────────────────────────────┐
│  Domain Architect · Alfred · Lybi Studio ·                      │  ← produce business deliverables
│  Sales Copilot · Growth Studio · Knowledge Keeper               │
└────────────────────────────┬────────────────────────────────────┘
                             │ reads / writes
┌────────────────────────────┴────────────────────────────────────┐
│  LYBI HQ (built)                                                │  ← holds + serves the knowledge
│  atoms · ingest · Pinecone · Scribe · Ask-with-citations        │
│  Drop · Library · Sources                                       │
└─────────────────────────────────────────────────────────────────┘
```

**Why that matters practically:** every one of her six agents needs the same plumbing — somewhere
knowledge lives, ingestion, meeting capture, retrieval, governance. Build that six times and three
people can't afford it. Build it once — which we've done — and each agent becomes mostly a prompt, a
scope and an output format. **HQ is what makes a six-agent system affordable at our size.**

So the answer to *"how does it fit what we started"* is: **it doesn't change the foundation and it
doesn't change phase 1.** It's a list of agents to build next, on what already exists (§4).

---

## 2. The single best thing in the deck

**The Operating Model (slide 29).** Every agent = four parts:

| Part | What it is | Maps to, on the engine we already have |
|---|---|---|
| **Permanent Knowledge** | the agent's methodology, always loaded | agent-level **cortex** (Builder V2) |
| **Active Project** | where it's working and allowed to write | conversation/project scope + memory |
| **Referenced Libraries** | what it may *read*, per task | **KB Retriever** addon + the agent's `kb_links` — already how the platform works |
| **Deliverable** | the defined artifact it must produce | a well-prompted document, saved as an atom |

**This maps almost 1:1 onto Builder V2.** That's a bigger deal than it looks: it means Noa's model is
implementable on the engine we already run, with no new runtime. The four-part contract is also a
much cleaner way to specify an agent than "here's a prompt" — worth adopting as our house standard
for every agent, not just these six.

Two more ideas from the deck we should adopt outright:

- **The source-of-truth hierarchy** (slide 26): approved decision › current spec › official product
  doc › official deck › meeting transcript › draft. Ordered, unambiguous, and directly implementable
  as a numeric `authority` on an atom. This is more concrete than anything in `LYBI_HQ.md` and
  settles the "which of these two contradicting docs wins" problem we hadn't solved.
- **"Not needed by default"** — every agent has an explicit *exclusion* list. That's a sharper idea
  than our single visibility flag, and it's about **context hygiene**, not security: an agent that
  can't see marketing drafts gives better answers about business rules.

---

## 3. Where each agent lands against what exists

| Noa's agent | Status | Notes |
|---|---|---|
| **Alfred** | ✅ **Built** | Already in the platform. The deck's spec is richer than what's shipped (Test Suite, Profiler Schema, Guardrails as named deliverables) — a gap list for Alfred, not new work for HQ. |
| **Knowledge Keeper** | 🟡 **≈ our Librarian, promoted** | We planned a Librarian (classify · dedup · flag contradictions). Noa's version is the same job, far better specified: catalog, source-of-truth map, versions, taxonomy, access rules, change impact, health report. **Adopt her spec and drop ours** — it's strictly better. |
| **Sales Copilot** | 🔵 New — **best first candidate** | Sits directly on the meeting pipeline we already built: transcript → Scribe → client brief, meeting prep, opportunity map. Nearest thing to free value from work already done. |
| **Domain Architect** | 🔵 New | Heaviest knowledge-authoring agent — most of its work is authoring good prompts and knowledge templates, not platform work. |
| **Lybi Studio** | 🔵 New | Produces interactive HTML demos. Barely touches HQ at all (its input is a knowledge pack, its output is HTML) — buildable independently, whenever. |
| **Growth Studio** | 🔵 New | Needs a brand/approved-content KB to exist first — that's content to write, not a system to build. |
| *(no equivalent)* | — | **Scribe** and **Ask** are ours and stay. They're substrate: Scribe feeds Sales Copilot and Knowledge Keeper; Ask is the human way into all of it. The deck assumes agents query knowledge but never names a general "ask the company" surface — we have one and should keep it. |
| *(no equivalent)* | — | **Chief of Staff** (we planned it) has no counterpart in the deck. Still useful, now lower priority. |

---

## 4. What the deck actually changes — very little

**Corrected 2026-08-05.** My first pass listed "five real gaps" and a ~2-week substrate phase before
any agent could be built. Re-checked against what Builder V2 already does, that was inflated. I had
mapped Noa's structure onto our schema one-for-one instead of asking what we actually need. Honest
version:

| I claimed was a gap | Reality |
|---|---|
| **Scoped retrieval per agent** — "the biggest gap" | **Not a gap.** Each agent already gets its own KB wiring: `kb_links` (agent↔KB m2m, already built) plus per-addon namespace selection in the KB Retriever. Different agents having different tools and different knowledge is *what building separate agents already means* — it's config, not architecture. |
| **Projects / Workspaces as a first-class table** | **Over-engineered.** "Which client / which use case is this about" is a metadata field plus a filter. `builder_projects` already exists for the build side. A dedicated container table buys us little at three people. |
| **Typed deliverables with templates** | **Much smaller than stated.** A Client Brief is an atom with `kind='client_brief'` — an enum value and a prompt that produces a consistent shape. Not a type system. |
| **Source-of-truth authority + `supersedes`** | **Real, and small.** One integer column and the link table we already designed. Worth doing when contradictions actually start biting, not before. |
| **Richer metadata** | **Real, and small.** A few columns on `hq_atoms`. |

**Net: no substrate phase.** What's left is a handful of columns we add when a specific agent needs
them. The agents can be built on what exists.

### The one thing that genuinely needs *some* shape

Her closing claim is that the value comes from the **structured handoff** between agents — Domain
Architect's pack becomes Alfred's input, Studio's demo becomes Sales Copilot's asset. That's the real
idea in the deck and it's correct.

But it needs far less machinery than I implied: a deliverable is a well-prompted markdown document
stored as an atom, and the next agent retrieves it. Alfred already consumes specs as text. Consistency
comes from the prompt, not from a schema. If that proves too loose after a couple of real handoffs,
*then* tighten it.

## 5. The client-data question — resolved, not a conflict

Sales Copilot's **Client Workspace** (profile, contacts, meetings, transcripts, needs, objections,
proposals) *looks* like it violates the rule in `LYBI_HQ.md` §9 that client data is never ingested.
**It doesn't** — but the distinction needs restating, because it will come up every time.

- **In scope, always was:** *our record of our relationship with a client.* Meeting transcripts,
  what they need, what we proposed, who decides. That is Lybi's own business information and it is
  exactly what HQ is for.
- **Out of scope, still:** *the client's own operational data.* Zer4U's sales tables, Freeda users'
  health conversations, banking onboarding submissions, any end-customer PII.

The fence stays where it was, and the control stays the same: **an allowlist at the source**, never a
filter at query time. Her per-client Workspace isolation actually *strengthens* this — it gives us a
natural boundary to enforce, and it means "Discount's workspace" and "Bank Hapoalim's workspace" don't
bleed into each other either.

---

## 6. Revised staffing model — two tiers

`LYBI_HQ.md` §7 says *"one `hq` builder agent, the staff are its crews."* **That call needs
splitting**, because the deck's agents have genuinely divergent knowledge scopes and Growth Studio is
explicitly barred from confidential client knowledge — which a shared agent-level cortex would leak.

| Tier | Who | Shape | Why |
|---|---|---|---|
| **Substrate crews** | Scribe · Ask · Librarian/Keeper | **one `hq` agent, crews** — as built | Shared company context written once; per-crew versioning; free cost attribution. The original reasoning holds. |
| **Business agents** | Domain Architect · Alfred · Studio · Sales Copilot · Growth Studio | **separate builder agents** | Divergent KBs, divergent permissions, independent publish cadence. Alfred is already separate — this just makes it the pattern. |

**Lybi Core** (slide 28 — "the shared constitution": what Lybi is, the differentiation, what it is
*not*, approved terminology, confidentiality rules) becomes a **shared snippet/addon every agent
imports**, so it's authored once and can't drift. That's the piece that makes separate agents safe.

---

## 7. Sequencing — one agent at a time, on what exists

**Build them one at a time, not as a set.** Not because anything is missing (§4 — nothing is), but
because a half-built six-agent system for three people is exactly the "elaborate scaffolding nobody
fills" failure `LYBI_HQ.md` §11 warns about. One agent used daily beats six specified on paper.

| Phase | What | Est. |
|---|---|---|
| **A · Validate what exists** | Shlomi reviews the HQ MVP; connect `NOTION_TOKEN`; pull the real meeting archive. **Blocking — don't build on an unvalidated base.** | — |
| **B · Sales Copilot** | First business agent, built on what exists. Rides the meeting pipeline that already works: Client Brief, Meeting Prep, Meeting Summary, Opportunity Map. Add columns only where it actually needs them. | ~2 wks |
| **C · Domain Architect** | The knowledge-authoring engine. Its Agent Knowledge Pack is what feeds Alfred. | ~2 wks |
| **D · Knowledge Keeper** | Governance — catalog, source-of-truth, contradictions. Build it once there is enough knowledge for inconsistency to actually hurt, not before. | ~1 wk |
| **F · Lybi Studio / Growth Studio** | Studio is semi-independent (input is a Demo Knowledge Pack). Growth needs a Brand library built first. | later |

**Why Sales Copilot first**, despite the deck's flow starting with Domain Architect: it's the one that pays back from work already done. The meeting archive we're ingesting
becomes client briefs and meeting prep immediately. Domain Architect produces value only once
something consumes its packs.

---

## 8. My honest reservations

1. **Build one agent end-to-end before committing to a pattern for all six.** This is the piece of
   my earlier analysis that survives — and it's a product judgement, independent of anything
   structural in the deck. Six roles specified on paper is not six roles proven in use.
2. **The deck assumes discipline we haven't demonstrated yet.** Project structures with twelve
   sections only work if someone fills them. Same argument as `LYBI_HQ.md` §11: weight the build
   toward what fills itself (Scribe writing meeting summaries into a Client Workspace) over what
   needs a human to maintain it.
3. **Don't specify thirty deliverables up front.** "Domain Research Pack" is a name until something
   produces one. Write the prompt for two or three, use them, and let the shape emerge from real
   output rather than from the deck's list.
4. **Alfred's gap list is separate work.** The deck specifies Alfred more richly than what's shipped
   (Test Suite, Profiler Schema, Guardrails as named deliverables). Worth a diff pass — but it's a
   builder task, not an HQ task, and shouldn't be folded into this.

---

## 9. Open questions for Shlomi and Noa

1. **Which deliverables matter first?** Rather than schematise all ~30, pick 2–3 to specify properly
   in phase B. My suggestion: Client Brief, Meeting Summary, Agent Knowledge Pack.
2. **Who owns Lybi Core?** It's the shared context every agent inherits (§6). It needs a single owner
   or it drifts — and it's the highest-leverage document in the whole system.
3. **Is the client list in the deck real?** Discount, Maccabi, Bank Jerusalem, Bank Hapoalim appear
   as examples. If those are live opportunities, Sales Copilot's priority goes up further.
