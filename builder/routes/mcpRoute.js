/**
 * `/builder/mcp` — the front door for an AI that is not ours.
 *
 * The premise: someone opens any chat, says "read https://…/builder/mcp
 * and help me build an agent", and from that one sentence the assistant
 * can learn the platform, find the agent being talked about, read how it
 * actually behaved in a real conversation, and submit a change.
 *
 * No install, no folder, no bundle download, no connector, no account.
 * Every read is a plain GET, because a URL is the one capability every
 * chat client has.
 *
 * ── On the name ────────────────────────────────────────────────────
 *
 * It is not an MCP server. MCP is a protocol, and a chat handed a URL
 * does not speak it — it fetches. So the mechanism is URLs and the entry
 * page explains itself in prose. The path says `mcp` because that is the
 * word people reach for when they mean "the thing you point an AI at";
 * an actual MCP adapter can be layered over these same handlers later,
 * and would add reach rather than capability.
 *
 * ── Robust to whoever is reading ───────────────────────────────────
 *
 * The callers are not alike: a plain web chat has no filesystem, Codex
 * and Claude Code do, and the person may already have run the Builder's
 * setup wizard and be sitting in the folder it wrote. The entry page
 * makes the assistant establish which of those it is before choosing how
 * to work — because a folder draft is two-way and live, and posting when
 * a draft file is right there would be the worse tool.
 *
 * ── Why there is no body validation on write ───────────────────────
 *
 * `alfred/services/bodyValidator.js` exists and is deliberately NOT used
 * here. It is a hand-maintained mirror of the real spec (`builder/types`,
 * the addon JSONs, the runtime), so gating writes on it would mean the
 * newest thing the platform can do becomes the thing this door rejects —
 * exactly the failure we just fixed in Alfred, rebuilt one level down.
 *
 * The safety is structural instead, and stronger: a write creates a NEW
 * version and makes it active — the editable line the Builder opens. It
 * never touches `published` (what customers get). A bad body is visible
 * in the Builder and undone by switching back a version. Nothing an
 * outside assistant does can reach a customer.
 *
 * Maintaining this file: docs/guides/BUILDER_MCP_MAINTENANCE.md, and run
 * scripts/test-builder-mcp.js after any change.
 *
 * ── The allowlist ──────────────────────────────────────────────────
 *
 * `/code/*` delegates to `alfredTools.readPlatformFile`, which already
 * refuses traversal and everything outside builder/, alfred/, docs/guides/
 * and docs/features/. Reused rather than re-declared so there is one
 * allowlist in the codebase, not two that drift apart.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const builderProjects = require('../services/builderProjects');
const alfredTools = require('../../alfred/services/alfredTools');
const { exportConversation } = require('../services/conversationExport');
const mcpConversations = require('../services/mcpConversations');
const modelsService = require('../../services/models.service');

/**
 * The team's shared knowledge repository (task #893) — notes, recipes and
 * skills every assistant reads before working and adds to as it learns.
 * The server never touches it: this door only GUIDES (where it is, when
 * to pull, when and how to write, when to push). Git is done by the
 * person's own assistant, under the person's own user.
 */
const KNOWLEDGE_REPO = process.env.LYBI_KNOWLEDGE_REPO || 'https://github.com/ShlomiZevin/lybi-knowledge';

// Bodies are whole agent definitions; the default 100kb limit is too
// small. Safe to apply again even if the app already parsed JSON —
// express.json() skips a request whose body it has already read.
router.use(express.json({ limit: '10mb' }));

/** Ids follow the same shape the Builder itself mints. */
function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
function newVersionId() {
  return newId('ver');
}

/**
 * Fill in the keys the Builder's dirty check always emits.
 *
 * The client decides "unsaved changes" by comparing its working copy
 * (`bodyOfAgent` in BuilderContext.tsx) against the saved version body.
 * That function emits `personas`, `domains`, `parameters`, `enums`,
 * `cortex` and `snippets` UNCONDITIONALLY, defaulting each to `[]`, and
 * coerces `spec`/`persona` to `''`. A body written from outside that
 * simply omits them is therefore not equal to the working copy the
 * instant it loads, and the Builder announces "Agent has unsaved changes"
 * on an agent nobody has touched. That is exactly what happened to the
 * first real agent built through this door; pressing Save appeared to fix
 * it, but only by rewriting the body with the complete key set.
 *
 * The keys guarded by the "empty == absent" trick over there — `tags`,
 * `liveBrain`, `profiler`, `triggers` — must NOT be defaulted here: the
 * client omits them when empty, so adding them would cause the very
 * mismatch this prevents.
 *
 * Only ever adds absent keys. Never changes a value it was given.
 */
function normalizeAgentBody(body, agent = {}) {
  return {
    name:    agent.name || agent.slug || '',
    slug:    agent.slug || '',
    spec:    '',
    persona: '',
    fields:     [],
    personas:   [],
    domains:    [],
    parameters: [],
    enums:      [],
    cortex:     [],
    snippets:   [],
    ...body,
  };
}

/** The crew counterpart — mirrors `bodyOfCrew`, which emits all six. */
function normalizeCrewBody(body) {
  return {
    name: '', description: '', spec: '', addons: [], fields: [],
    ...body,
  };
}

/**
 * This router's own base, and the server root (for endpoints outside it).
 *
 * Read from the X-Forwarded-* headers first. The whole point of this page
 * is that every URL on it can be fetched by whoever is reading, and when
 * the request arrives through a proxy — Firebase Hosting rewriting
 * lybi.ai to Cloud Run — `req.protocol` reports "http" and `req.get(host)`
 * can be the Cloud Run hostname. Either one produces a page full of links
 * that fail. `trust proxy` is not set app-wide and turning it on would
 * change behaviour for every other route, so this reads the headers
 * itself and falls back to the direct values.
 */
function urls(req) {
  const first = h => String(req.headers[h] || '').split(',')[0].trim();
  const proto  = first('x-forwarded-proto') || req.protocol;
  const host   = first('x-forwarded-host')  || req.get('host');
  const origin = `${proto}://${host}`;
  return { origin, base: `${origin}${req.baseUrl}` };
}

/**
 * Everything textual goes out as `text/plain`.
 *
 * It is Markdown, and `text/markdown` is the honest label — but browser
 * reader tools in chat clients refuse that content type outright. ChatGPT
 * could reach this page and then declined to display it, which makes the
 * whole idea fail at the first step for the exact audience it is for.
 * Plain text renders the identical Markdown and nothing refuses it.
 */
function sendText(res, body, type = 'text/plain') {
  res.type(`${type}; charset=utf-8`).send(body);
}

// ─── The entry document ────────────────────────────────────────────

/**
 * Everything an assistant needs to start, and pointers to everything
 * else. Deliberately prose rather than a schema dump: the reader is a
 * language model that has just been told "read this", and what makes it
 * behave well is knowing what its job is and that it is allowed to go
 * and look. A machine-readable index would be read no better and would
 * tell it less.
 */
function entryDoc({ base, origin }) {
  const repo = KNOWLEDGE_REPO;
  const everydayModel = modelsService.EVERYDAY_MODEL;
  return `# Lybi — building agents

You are being asked to help someone build, change and debug an agent on
Lybi. This page is everything you need to start. Read it, then go and
look things up.

## What an agent is

An agent is a JSON body stored on our server — not code. It has fields it
collects, addons that do the work (talker, thinker, field extractor,
knowledge base retrieval, rules, and others), and **crews**: separate
sub-agents that handle different parts of a conversation. In the agent
JSON, crews live at \`agents[0].crews\`.

You change an agent by reading its body, editing it, and saving it back.
Everything else is reading.

## First: work out what you can do

Assistants reading this are not alike, and the right way to work depends
on what you have.

**If you cannot read or write files** — you are a plain chat. That is
fine and nothing here needs a filesystem: every read below is a URL, and
you submit a change by posting one. Skip to "How to work".

**If you can read files, look at your working directory before anything
else.** The Builder has a setup wizard that writes a folder on the
person's machine, and if they have used it you may well be sitting in it.
Look for:

| If you find | It means |
|---|---|
| \`drafts/<agent-slug>.json\` | The agent they are working on, live |
| \`.lybi/config.json\` | Their builder id |
| \`CLAUDE.md\` or \`AGENTS.md\` | Fuller instructions than this page — read them |
| \`aspect-agent-server/\` | Our source, already downloaded for you |

**If a draft file is there you have two ways to change things, and they
are genuinely different — say which you are about to use, or ask.**

| | What it changes |
|---|---|
| Edit \`drafts/<slug>.json\` | Their **draft**, on their machine. Nothing reaches the server. The Builder spots it within seconds and asks whether to load it; they decide, and they save it. |
| POST to the API (below) | The **server**, immediately. A new version, and it becomes the one the Builder opens. Undone by switching back a version, not by declining. |

Prefer the draft file when one exists — it is the more cautious of the
two and the Builder is already watching it — but the choice is theirs,
not yours, so offer it rather than deciding quietly.

Two rules that go with the draft file: edit in place with small targeted
changes rather than rewriting the whole thing, and **re-read it
immediately before you write**, because they may have typed something
while you were thinking.

**If there is no folder, either of these is fine:**

- Work over URLs, exactly like a chat with no files. Nothing is lost.
- Download our source once, if you would rather grep it locally:
  \`GET ${origin}/api/builder/ai-bundle\` returns every Builder V2 file as
  \`{ version, files: [ { path, content } ] }\` — about 90 of them. Worth
  it for a long session, unnecessary for one change.

If you already have a copy, \`GET ${origin}/api/builder/ai-bundle/version\`
returns the current version string. Compare it with the one in
\`.lybi/bundle.json\`; if they differ, the copy is stale and the person
should refresh it from the Builder's 🤖 button.

## How to work

**Look things up as you go. Repeatedly. That is normal here.** Fetch the
agent list, then the agent, then the code for the addon you are unsure
about, then a conversation to see what actually happened. Three or four
fetches to answer one question is the expected shape of this, not a
failure. Do not answer from one page and guess the rest — everything is
one URL away, and a guessed addon name or config key produces an agent
that saves cleanly and then silently does nothing at runtime.

**Finding the right agent is a conversation.** Fetch the list. If they
say "the test one" and you see two, say so and ask which — they can tell
you ("the one with the field called bank_name"), and then you go and
look. Never pick between similar names on your own: several agents here
are near-twins, one live and one a copy.

**When you are told something exists and you believe it does not, go and
read the code before arguing.** You can read our actual source. Use it.

## The shared knowledge — read it first, add to it as you learn

The team keeps what it has learned in one git repository:

**${repo}**

It holds short notes in English — lessons, per-agent notes, step-by-step
recipes and ready-made skills. Every assistant working for anyone on the
team reads it and adds to it, so a thing learned once is not learned
again by the next person. Doing this is part of the job, not an extra.

**If you can run commands on the person's machine** (Claude Code, Codex):

1. **Get it.** Look for a \`lybi-knowledge/\` folder beside your working
   folder. If it is there, \`git pull\` in it. If not, \`git clone ${repo}\`
   next to — not inside — the working folder. If git is missing or asks
   for a login you cannot complete, say so in one sentence and help the
   person set it up once (install git; sign in to GitHub; Shlomi gives
   access to the repository). Then carry on with the task either way.
2. **Read before you work.** Open \`RULES.md\` and \`INDEX.md\`. From the
   index, open every note that touches what you were asked to do — the
   notes under \`agents/<slug>/\` for the agent in question, and anything
   relevant under \`lessons/\` and \`recipes/\`. Tell the person in a line
   what you found that matters.
3. **Write when you have learned something reusable.** The triggers:
   - you found platform behaviour that is not documented;
   - you fixed a problem whose cause could repeat;
   - a prompt pattern clearly worked or clearly failed — and you have the
     conversation that proves it;
   - a decision was made with the person, and why;
   - you did a multi-step job that will be done again.
4. **How to write.** Search first — update an existing note rather than
   adding a near-duplicate. One topic per note, short, with the small
   header \`RULES.md\` describes, and a pointer to the evidence
   (conversation id, run id, file path). Add or fix its line in
   \`INDEX.md\` in the same commit.
5. **Where it goes.** About one agent → \`agents/<slug>/\`. Know-how that
   applies across agents → \`lessons/\`. A repeatable procedure →
   \`recipes/\`. Something an assistant should be able to do on command →
   \`skills/<name>/SKILL.md\`.
6. **Save it for everyone.** \`git pull --rebase\`, commit with a one-line
   message that says what was learned, \`git push\`. If the push is
   refused, pull again and retry; never force.
7. **Always tell the person** — "I added a note: <title>, in <path>" — so
   they can say "remove it". Removing is deleting the file and its index
   line, and pushing.

**Never write** customer data, real people's details, passwords, keys or
tokens. And not the passing state of one agent ("field X is currently
required") — that lives in the agent's own Spec and change log, which
you can already read here.

**A note that is wrong is worse than no note.** If you find one that
contradicts the code or what you just saw happen, fix it and say so; if
you are not sure, add a line at its top saying what you saw and when.

**Skills.** Each folder under \`skills/\` is a ready-made skill. In Claude
Code, copy the folder into \`.claude/skills/\` of the working folder; in
Codex, add one line to \`AGENTS.md\` pointing at its \`SKILL.md\`. Do it
when a skill fits what the person is asking for, and say that you did.

**If you cannot run commands** — a plain web chat — you cannot reach the
repository. Say so once, plainly: knowledge the team has written down is
not visible to you here, and anything you learn in this chat will not be
saved for the others unless the person passes it on.

## Reading

| What | URL |
|---|---|
| Every agent — names and slugs | \`${base}/agents\` |
| One agent, full body and crews | \`${base}/agents/<slug>\` |
| Its recent conversations | \`${base}/agents/<slug>/conversations\` |
| A transcript, with what each addon did per turn | \`${base}/conversations/<id>\` |
| One addon run in full — assembled prompt, raw and parsed output | \`${base}/runs/<id>\` |
| **A whole conversation as JSON, for analysis** — every message, and under each reply the addon runs of that turn with their outputs and field writes. \`include=messages\` for the text only, \`include=full\` to add every assembled prompt (large). Default \`outputs\` | \`${base}/conversations/<id>/export?include=outputs\` |
| **Where a conversation stands right now** — every field's value, the thinking, the summaries, and the crew it is in | \`${base}/conversations/<id>/state\` |
| History of changes to an agent, and why | \`${base}/agents/<slug>/log\` |
| **Its Spec** — project, agent and crew specs, the text of every file attached to the agent's Spec, and the notes & files on each Targeted KB (the author's knowledge map). What the person wants the agent to be; read it before designing anything. Never seen by the running agent | \`${base}/agents/<slug>/spec\` |
| **Every knowledge base** — chunks, files, which agents it is connected to and which KB Retrievers search it, plus any retriever naming a KB that doesn't exist | \`${base}/kbs\` |
| One agent's knowledge bases — connected ones, and each KB Retriever with whether its KB is ok, not connected, or missing | \`${base}/agents/<slug>/kbs\` |
| The files in a knowledge base | \`${base}/kbs/<name>/files\` |
| One file's text, chunk by chunk | \`${base}/kbs/<name>/files/<fileId>\` |
| **Our source code**, any path, directories list | \`${base}/code/<path>\` |

## Learning how the platform actually works

The code is the truth. Good places to start:

| Question | Fetch |
|---|---|
| What shape is an agent or crew body? | \`${base}/code/builder/types/index.ts\` |
| **What addons exist and how is each configured?** | \`${base}/addons\` — all of them, one page |
| What does an addon do at runtime? | \`${base}/code/builder/plugins/\` |
| What \`{{...}}\` tokens can a prompt use? | \`${base}/code/builder/promptPlaceholders.json\` |
| How is a prompt assembled and an agent run? | \`${base}/code/builder/runtime/\` |
| The fullest written description of the builder | \`${base}/code/alfred/services/alfredContext.js\` |
| Guides, with worked examples | \`${base}/code/docs/guides/\` |

## Changing an agent

If they have a folder, this is the second of the two options above and
worth a word with them first. With no folder it is the only way, and
needs no discussion. Either way it is one call — send the whole body
back:

\`\`\`
POST ${base}/agents/<slug>
{ "body": { ...the edited agent body... }, "description": "what you changed" }
\`\`\`

A crew is the same, addressed by its id:

\`\`\`
POST ${base}/agents/<slug>/crews/<crewId>
{ "body": { ...the edited crew body... }, "description": "what you changed" }
\`\`\`

**This creates a new version and makes it the one the Builder opens. It
does not go live.** What customers get is a separate, deliberate publish
step you cannot reach, and it does not move. So the person sees your
change when they look, undoes it by switching back a version, and nothing
you do can affect a real conversation.

Post the **whole** body, not a patch, and change only what you meant to —
they are reading the diff on screen.

**Giving an agent a knowledge base.** Two steps, and people mix them up:

1. **Connect** it, so the Builder shows it for this agent:

   \`\`\`
   POST ${base}/agents/<slug>/kbs
   { "namespace": "<kb name from ${base}/kbs>" }
   \`\`\`

   Only a KB that really exists can be connected — anything else is
   refused and nothing changes. Connecting never removes anything.
2. **Search** it: add a KB Retriever addon (see \`${base}/addons\`) to the
   crew, or the agent cortex, with the KB's name in \`config.kbNamespaces\`,
   and POST the body as above. Without this the agent never reads it.

Creating a knowledge base or uploading files to one is done in the admin
screen, not through this door — say so if they ask.

**A brand-new agent** — ask before making one, it is a bigger thing than
an edit:

\`\`\`
POST ${base}/agents
{ "name": "Card disputes", "body": { ...optional starting body... } }
\`\`\`

Name is all it needs; the slug, the ids and the first crew are made for
you. Use THIS rather than the raw projects endpoint — it fills in the
parts of a body the Builder expects, and an agent created without them
opens showing "unsaved changes" before anyone has touched it.

## Things that are easy to get wrong

- A field's type is exactly one of \`string\`, \`int\`, \`enum\`,
  \`boolean\`. It is \`int\` — never \`integer\` or \`number\`.
- On screen those read String, Integer, Boolean; an \`enum\` shows as a
  Choice or a Targeted KB. Say the screen's words when you talk to the
  person, not the JSON spellings.
- Crews are separate entities with their own versions. Adding one means
  adding to \`crews\`, not a key inside the agent.
- Deleting a crew is not yours to do — say so and let them do it.
- An agent-cortex addon (\`agent.cortex[]\`) runs in every crew unless its
  \`excludedCrewIds\` lists the crews it is switched off for (on screen: the
  "Runs in" ✓/✕ chips). Use the real crew ids from the agent's crews —
  never invent one — and omit the key to mean "all crews", never \`[]\`.
  Crew addons never carry it.

## Testing an agent — talk to it yourself

You can hold a conversation with any agent, as its user, and read back
exactly what it did. This is how you check a change, reproduce a
complaint, or run the same scenarios again after every edit. The person
only has to ask — "simulate a 19-year-old opening a first account" — and
the rest is yours: do it yourself, and ask them only what you cannot
decide.

**Before you start, know two things — ask if they did not say:**

- **Who you are talking to.** A real name from \`${base}/people\`, as on
  the task board. Every simulated conversation records whose it is.
- **Which version.** \`active\` (the default) is the version the Builder
  opens — the latest saved work. \`published\` is what customers get.
  Only saved versions can be tested; if they have unsaved edits, those
  must be saved first.

**1. Start a conversation**

\`\`\`
POST ${base}/agents/<slug>/conversations
{ "name": "Noa", "version": "active", "label": "student, first account" }
→ { "conversationId": 4321, "agent": "<slug>", "version": "active", "crew": null }
\`\`\`

Optional: \`"startCrew"\` (a crew name or id) and \`"fields"\`
(\`{ "age": 19 }\`) start the conversation in the middle of a flow, with
values already known, instead of replaying everything before it.
\`"label"\` becomes the conversation's name in the Builder — make it say
what the scenario is.

**2. Say something — the whole reply comes back**

\`\`\`
POST ${base}/conversations/<conversationId>/messages
{ "text": "hi, I want to open an account" }
→ { "reply": "...", "crew": { "name": "..." }, "fieldsWritten": [ ... ],
    "transition": { ... }, "addons": [ ... ] }
\`\`\`

\`reply\` is what the user would see. The rest is what the turn did:
the crew that answered, the fields it wrote, a crew transition if one
happened, and which addons ran. It is one ordinary request — no stream —
and it returns when the turn is over, which can take half a minute.
Send the next message only after the previous one has returned.

**3. Look at what happened**

| To see | Fetch |
|---|---|
| Every field's value right now, and the current crew | \`${base}/conversations/<id>/state\` |
| The transcript with each addon's part in it | \`${base}/conversations/<id>\` |
| Everything, as JSON | \`${base}/conversations/<id>/export?include=outputs\` |
| One addon's exact prompt and output | \`${base}/runs/<runId>\` |

It is a normal conversation in the system: the person can open it in the
Builder (Admin → Conversations, marked "Simulated") and see the same
trail you do. Tell them its id.

**Three ways to play the user — pick by what they asked for:**

| | How | When |
|---|---|---|
| **You play the user** | Write each message yourself, read the reply, decide the next | Exploring; reproducing one complaint; "talk to it as an angry customer". Simple, and it keeps you busy for the length of the conversation. |
| **A fixed script** | Write the user's lines up front; a small script posts them one by one and saves the replies | The same scenarios after every change. Runs in the background, needs no model at all. |
| **A persona, in a script** | A script asks us for the user's next line (below), posts it, and repeats | Many conversations, or long ones, without you writing each line. |

Scripts are for assistants that can run commands. Run them in the
background and carry on talking to the person; check on them when they
finish. Run a handful of conversations at once, not hundreds.

**The user's next line, written for you**

\`\`\`
POST ${base}/simulate/user-reply
{ "persona": "Dana, 19, student, first bank account, impatient, writes short Hebrew messages",
  "goal": "open an account without paying fees",
  "conversationId": 4321 }
→ { "text": "...", "done": false, "model": "${everydayModel}" }
\`\`\`

It reads the conversation so far and answers with what that person would
say next. \`done\` turns true when they would stop — goal reached, gave
up, or nothing left to say; stop the loop then, and stop anyway after a
sensible number of turns (twelve is plenty for most flows). Instead of
\`conversationId\` you may send \`"transcript"\`:
\`[ { "role": "user" | "assistant", "text": "..." } ]\`.

**Which model plays the user: ask the person.** Pass their choice as
\`"model"\` — any id from \`${origin}/api/models\`. If they have no
preference, leave it out and it uses \`${everydayModel}\`. When you play
the user yourself, no model of ours is involved at all.

**After a run, report what matters:** did it reach the goal, where it
went wrong (quote the turn), which fields ended up wrong or empty — and
the conversation ids, so they can look. If you learned something
reusable, it belongs in the shared knowledge (above).

There is a daily limit on simulated turns and on user-reply calls; if
you hit it the answer says so. Tell the person rather than working
around it. You can only write into conversations you started this way —
real conversations are read-only here.

## Building your own chat for an agent

Any agent built here can be talked to from a chat the person designs
themselves — their own look, their own site or app. It is the same API
Lybi's own live chat uses. Three calls:

**1. Start a conversation**

\`\`\`
POST ${origin}/api/agents/<slug>/conversations
{ "ownerUserId": "<a stable id for the end user>", "source": "live" }
→ { "conversationId": 123 }
\`\`\`

\`ownerUserId\` is any string that stays the same for one end user (their
account id, or a random id kept in their browser). Their conversations and
the agent's memory of them hang off it.

**2. Send a message — the reply streams back**

\`\`\`
POST ${origin}/api/agents/<slug>/conversations/<conversationId>/messages
{ "ownerUserId": "<same id>", "userMessage": "Hi", "version": "published" }
\`\`\`

The response is a Server-Sent Events stream: lines of
\`data: {"type": "...", ...}\`. A chat only needs three of them:

| \`type\` | Meaning | Use |
|---|---|---|
| \`addon.token\` | A piece of the reply (\`token\`) | Append it — this is the typing effect |
| \`assistant.message\` | The complete reply (\`text\`, \`messageId\`) | Replace what you appended with this |
| \`done\` | The turn is over | Re-enable the input |

\`addon.error\` with \`instanceId: null\` means the whole turn failed —
show its \`error.message\`. Every other event type is the agent's inner
workings; ignore it. Use \`fetch\` and read the body stream — the
browser's \`EventSource\` cannot send a POST.

\`version: "published"\` is what customers should get: the published
version, falling back to active if nothing is published yet.

**3. Load the history**

\`\`\`
GET ${origin}/api/agents/<slug>/conversations/<conversationId>/messages
→ { "messages": [ { "id", "role", "content", "createdAt" } ] }
\`\`\`

**From a web page on their own domain, the site must be registered
first** — browsers block calls to other domains unless the server allows
them. A server, a mobile app or a desktop app needs nothing. To register
a site they need the partner secret, which Shlomi hands out:

\`\`\`
POST ${base}/domains
{ "origin": "https://chat.example.com", "secret": "<partner secret>" }
\`\`\`

Only the site address — \`https://\` plus the host, no path.
\`http://localhost:<port>\` works for development. If they do not have the
secret, say so and tell them to ask Shlomi; never try to get around it.

## The task board

You can also read the team's task board, open tasks on it, and edit the
tasks the person opened. This is the **LYBI** board — the one for this
platform.

**Know who you are talking to first.** Every task has an opener, and it
must be a real name from \`${base}/people\`. If they have not told you who
they are, ask — never guess, and never use any other spelling: a task
opened under the wrong name is invisible to its owner.

| What | Call |
|---|---|
| The people on the board | \`GET ${base}/people\` |
| Open tasks (filters: \`assignee\`, \`opener\`, \`status\`, \`type\`, \`priority\`; \`all=1\` includes closed) | \`GET ${base}/tasks\` |
| One task and its whole comment thread | \`GET ${base}/tasks/<id>\` |
| **"Does anything need my attention?"** | \`GET ${base}/tasks/attention?name=<their name>\` |
| Open a task | \`POST ${base}/tasks\` |
| Edit a task they opened | \`PATCH ${base}/tasks/<id>\` |

**Opening a task:**

\`\`\`
POST ${base}/tasks
{ "opener": "Noa", "title": "...", "description": "...",
  "type": "bug", "priority": "medium", "assignee": "Shlomi" }
\`\`\`

Only \`opener\` and \`title\` are required — fill in the rest yourself from
what they told you. The assignee is either Shlomi (the default) or the
opener themself. \`type\` is one of ${TASK_TYPES.join(', ')};
\`priority\` one of ${TASK_PRIORITIES.join(', ')}. Write the description
as plain text; blank lines become paragraphs. Assigning to Shlomi
notifies him, so read the title and description back to them before you
open it.

**Editing** is for the person who opened the task, and covers
${OPENER_EDITABLE.join(', ')}:

\`\`\`
PATCH ${base}/tasks/<id>
{ "name": "Noa", "priority": "high" }
\`\`\`

Status, assignee and release notes are changed on the board itself, not
here. If they want to talk to whoever is working on a task, that is a
comment on the board.

## Talking to the person

They are usually not a developer, and they are looking at the Builder
while you work. Keep the JSON in the call, not in the conversation. When
a request is big, do one piece and let them look before you continue.
When something is ambiguous, ask — a question costs a message, a wrong
agent costs the afternoon.

Say plainly when you have not checked something. "I haven't looked at
that conversation yet" beats a confident guess every time.
`;
}

router.get('/', (req, res) => {
  sendText(res, entryDoc(urls(req)));
});

// ─── Reading ───────────────────────────────────────────────────────

router.get('/agents', async (_req, res) => {
  try {
    // The list is where most sessions start; end it with the one reminder
    // that is easy to skip (task #893). Added here, not in alfredTools —
    // Alfred has no git and must not be told to use it.
    const list = await alfredTools.listAgents();
    sendText(res, `${list}\n\n---\nBefore working on an agent: pull the shared knowledge (${KNOWLEDGE_REPO}) and read INDEX.md — the notes under agents/<slug>/ and lessons/. How and when: the entry page, "The shared knowledge".\n`, 'text/plain');
  } catch (err) {
    console.error('[builder-mcp] agents failed:', err);
    res.status(500).type('text/plain').send(`Could not list agents: ${err.message}`);
  }
});

/**
 * The full project — agent body, every crew, every version.
 *
 * JSON rather than a digest, because this is the thing that gets edited
 * and sent back. Alfred's `readAgent` strips version bodies to keep his
 * context small; here the body IS the point.
 */
router.get('/agents/:slug', async (req, res) => {
  try {
    const project = await builderProjects.hydrateProject({ agentSlug: req.params.slug });
    if (!project || !project.agents[0]) {
      return res.status(404).type('text/plain').send(
        `No agent with slug "${req.params.slug}". Fetch ../agents for the list — slugs are stored, not derived from the name.`,
      );
    }
    res.json(project);
  } catch (err) {
    console.error('[builder-mcp] agent failed:', err);
    res.status(500).type('text/plain').send(`Could not read that agent: ${err.message}`);
  }
});

router.get('/agents/:slug/conversations', async (req, res) => {
  try {
    sendText(res, await alfredTools.listConversations({
      agentSlug: req.params.slug,
      limit: req.query.limit,
    }), 'text/plain');
  } catch (err) {
    console.error('[builder-mcp] conversations failed:', err);
    res.status(500).type('text/plain').send(`Could not list conversations: ${err.message}`);
  }
});

router.get('/agents/:slug/log', async (req, res) => {
  try {
    const project = await builderProjects.hydrateProject({ agentSlug: req.params.slug });
    const agent = project && project.agents[0];
    if (!agent) {
      return res.status(404).type('text/plain').send(`No agent with slug "${req.params.slug}".`);
    }
    sendText(res, await alfredTools.changeLogText({ agentId: agent.id, limit: req.query.limit }), 'text/plain');
  } catch (err) {
    console.error('[builder-mcp] log failed:', err);
    res.status(500).type('text/plain').send(`Could not read the log: ${err.message}`);
  }
});

router.get('/conversations/:id', async (req, res) => {
  try {
    sendText(res, await alfredTools.readConversation({ conversationId: req.params.id }));
  } catch (err) {
    console.error('[builder-mcp] conversation failed:', err);
    res.status(500).type('text/plain').send(`Could not read that conversation: ${err.message}`);
  }
});

/**
 * The same JSON the Builder Chat "Export" button downloads (task #861) —
 * one function behind both, so what a person hands an AI and what the AI
 * fetches itself never differ. JSON, like /agents/:slug: the structure IS
 * the point, and the digest above is the prose view of the same data.
 */
router.get('/conversations/:id/export', async (req, res) => {
  try {
    const data = await exportConversation({ conversationId: req.params.id, include: req.query.include });
    if (!data) {
      return res.status(404).type('text/plain').send(
        `No conversation ${req.params.id}. Fetch ../agents/<slug>/conversations for the ids of an agent's chats.`,
      );
    }
    res.json(data);
  } catch (err) {
    console.error('[builder-mcp] export failed:', err);
    res.status(500).type('text/plain').send(`Could not export that conversation: ${err.message}`);
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    sendText(res, await alfredTools.readRun({ runId: req.params.id }));
  } catch (err) {
    console.error('[builder-mcp] run failed:', err);
    res.status(500).type('text/plain').send(`Could not read that run: ${err.message}`);
  }
});

/**
 * Our source, by its real repo path, so the URL is guessable from any
 * file reference the assistant has already seen. Directories list, which
 * is what makes exploring possible rather than requiring exact knowledge
 * up front.
 */
router.get(/^\/code\/(.+)$/, (req, res) => {
  const out = alfredTools.readPlatformFile(req.params[0]);
  // readPlatformFile reports refusals and misses as prose rather than
  // throwing. Give those a real status so a fetch that went nowhere is
  // not mistaken for a file whose contents happen to start with "Refused".
  const missed = /^(Refused |No such file:)/.test(out);
  sendText(res.status(missed ? 404 : 200), out);
});

router.get('/code', (_req, res) => {
  sendText(res, alfredTools.readPlatformFile('builder/'));
});

/**
 * Every addon descriptor, in full, in one response.
 *
 * The granular routes make an assistant list the directory and then fetch
 * each file — eight round trips to answer the most predictable question
 * in the whole system, and the one where guessing costs the most: a made
 * up config key saves cleanly and then silently does nothing at runtime.
 * ChatGPT hit exactly this, ran out of fetches and asked the person to
 * paste the directory listing by hand. Same content, one fetch.
 *
 * Bundled because it is always wanted together and rarely changes. The
 * long tail — a plugin's runtime, one guide, a transcript — stays
 * granular, where bundling would only waste context.
 */
const ADDONS_DIR = path.join(__dirname, '..', 'addons');

router.get('/addons', (_req, res) => {
  let files;
  try {
    files = fs.readdirSync(ADDONS_DIR).filter(f => f.endsWith('.addon.json')).sort();
  } catch (err) {
    console.error('[builder-mcp] addons failed:', err);
    return res.status(500).type('text/plain').send(`Could not read the addons: ${err.message}`);
  }
  sendText(res, [
    '# Every addon, with its full configuration',
    '',
    `${files.length} addons, complete. Everything you need to configure any of`,
    'them is on this page — you should never have to guess a key name.',
    '',
    ...files.map(f => alfredTools.readPlatformFile(`builder/addons/${f}`)),
  ].join('\n\n'));
});

// ─── Writing ───────────────────────────────────────────────────────

/**
 * Save an edited body as a new version and show it.
 *
 * Shared by the agent and crew routes because the two differ only in
 * which service function they call — the rules, the response and the
 * reason it is safe are identical.
 */
async function saveAsNewVersion({ res, kind, id, body, description, normalize, saveFn, activateFn }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).type('text/plain').send(
      'Send { "body": { ... } } — the whole edited body as an object, not a patch and not a string.',
    );
  }
  const versionId = newVersionId();
  await saveFn({
    versionId,
    body: normalize(body),
    description: description || 'Changed by an AI assistant',
  });

  // Point ACTIVE at the new version, not just viewing.
  //
  // `saveAgentVersionAs` moves `viewingVersionId` by itself, and that
  // looks like it should be enough — but `hydrateProject` rebuilds the
  // working copy from the ACTIVE version and then reports
  // `viewingVersionId` AS active on load (the "working copy == active"
  // invariant the client depends on). So a version that only moved the
  // viewing pointer is invisible: the person opens the Builder, sees
  // their old agent, and nothing indicates their assistant did anything.
  // Caught by the self-test, which is the only reason this is right.
  //
  // Active is the editable line. `publishedVersionId` — what customers
  // actually get — is deliberately left alone, so this can never reach a
  // real conversation.
  await activateFn({ versionId });

  sendText(res, [
    `Saved. ${kind} ${id} now has a new version (${versionId}) and that is what the Builder opens.`,
    '',
    'It is NOT live to customers: publishing is a separate, deliberate step you',
    'cannot reach, and it did not move. Tell them to look at the Builder. To undo,',
    'they switch back to the previous version from the version menu.',
  ].join('\n'), 'text/plain');
}

/**
 * Create a brand-new agent.
 *
 * Exists because the raw projects endpoint makes the caller invent seven
 * ids and does no normalising — an agent created through it opens in the
 * Builder already announcing "unsaved changes" (see normalizeAgentBody),
 * which is what happened to the first agent anyone built through this
 * door. Here the ids are minted and the bodies completed, so a new agent
 * is clean the moment it is opened.
 */
router.post('/agents', async (req, res) => {
  try {
    const { name, slug, body, crew } = req.body || {};
    const agentName = String(name || body?.name || '').trim();
    if (!agentName) {
      return res.status(400).type('text/plain').send(
        'Send { "name": "..." } — at minimum a new agent needs a name.',
      );
    }
    const agentSlug = String(slug || body?.slug || agentName)
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!agentSlug) {
      return res.status(400).type('text/plain').send(
        'That name has no letters or digits to make a slug from. Pass "slug" explicitly.',
      );
    }
    if (await builderProjects.hydrateProject({ agentSlug })) {
      return res.status(409).type('text/plain').send(
        `An agent with slug "${agentSlug}" already exists. Choose a different name, or edit that one.`,
      );
    }

    const ids = {
      projectId:      newId('project'),
      agentId:        newId('agent'),
      agentVersionId: newVersionId(),
      crewId:         newId('crew'),
      crewVersionId:  newVersionId(),
    };
    await builderProjects.createProject({
      ownerUserId: 'mcp',
      projectName: agentName,
      agentSlug,
      ...ids,
      // name/slug/defaultCrewId last: they are decided here, not by the
      // caller, so they override anything that came in the body.
      agentBody: normalizeAgentBody(
        { ...body, name: agentName, slug: agentSlug, defaultCrewId: ids.crewId },
        { name: agentName, slug: agentSlug },
      ),
      crewBody: normalizeCrewBody({ name: 'Main', ...crew }),
    });

    sendText(res, [
      `Created "${agentName}" with slug ${agentSlug} and one crew (${ids.crewId}).`,
      '',
      'It is not live — nothing is published until someone deliberately publishes it.',
      `Read it back at ${urls(req).base}/agents/${agentSlug}, and add fields, addons`,
      'and crews with the update calls.',
    ].join('\n'));
  } catch (err) {
    console.error('[builder-mcp] create agent failed:', err);
    res.status(500).type('text/plain').send(`Could not create that agent: ${err.message}`);
  }
});

router.post('/agents/:slug', async (req, res) => {
  try {
    const project = await builderProjects.hydrateProject({ agentSlug: req.params.slug });
    const agent = project && project.agents[0];
    if (!agent) {
      return res.status(404).type('text/plain').send(
        `No agent with slug "${req.params.slug}". Fetch ../agents for the list.`,
      );
    }
    await saveAsNewVersion({
      res,
      kind: 'Agent',
      id: agent.name || agent.slug,
      body: req.body?.body,
      description: req.body?.description,
      normalize: b => normalizeAgentBody(b, agent),
      saveFn: args => builderProjects.saveAgentVersionAs({ agentId: agent.id, ...args }),
      activateFn: ({ versionId }) => builderProjects.setAgentActive({ agentId: agent.id, versionId }),
    });
  } catch (err) {
    console.error('[builder-mcp] update agent failed:', err);
    res.status(500).type('text/plain').send(`Could not save: ${err.message}`);
  }
});

router.post('/agents/:slug/crews/:crewId', async (req, res) => {
  try {
    const project = await builderProjects.hydrateProject({ agentSlug: req.params.slug });
    const agent = project && project.agents[0];
    if (!agent) {
      return res.status(404).type('text/plain').send(`No agent with slug "${req.params.slug}".`);
    }
    const crew = (agent.crews || []).find(c => c.id === req.params.crewId);
    if (!crew) {
      const have = (agent.crews || []).map(c => `${c.id} (${c.name || 'unnamed'})`).join(', ') || 'none';
      return res.status(404).type('text/plain').send(
        `No crew "${req.params.crewId}" on ${agent.name || agent.slug}. Its crews are: ${have}`,
      );
    }
    await saveAsNewVersion({
      res,
      kind: 'Crew',
      id: crew.name || crew.id,
      body: req.body?.body,
      description: req.body?.description,
      normalize: normalizeCrewBody,
      saveFn: args => builderProjects.saveCrewVersionAs({ crewId: crew.id, ...args }),
      activateFn: ({ versionId }) => builderProjects.setCrewActive({ crewId: crew.id, versionId }),
    });
  } catch (err) {
    console.error('[builder-mcp] update crew failed:', err);
    res.status(500).type('text/plain').send(`Could not save: ${err.message}`);
  }
});

/**
 * The Spec (task #870): the project spec, the agent and crew specs, and
 * the text of every file attached to the agent's Spec. Guidance for
 * whoever builds the agent — the running agent never sees any of it.
 */
router.get('/agents/:slug/spec', async (req, res) => {
  try {
    const project = await builderProjects.hydrateProject({ agentSlug: req.params.slug });
    const agent = project && project.agents[0];
    if (!agent) {
      return res.status(404).type('text/plain').send(`No agent with slug "${req.params.slug}". Fetch ../agents for the list.`);
    }
    const { listSpecFiles, renderSpecFiles, renderTkbNotes } = require('../services/specFiles');
    const files = await listSpecFiles(agent.id);
    const tkbNotes = await renderTkbNotes(agent.id, agent.enums);
    const crewSpecs = (agent.crews || []).filter(c => (c.spec || '').trim());
    sendText(res, [
      `Spec of "${agent.name || agent.slug}" — what it should be, for the people and assistants building it.`,
      'The running agent never sees this.',
      '',
      '## Project spec', (project.spec || '').trim() || '(empty)',
      '',
      '## Agent spec', (agent.spec || '').trim() || '(empty)',
      ...(crewSpecs.length ? ['', '## Crew specs', ...crewSpecs.map(c => `### ${c.name}\n${c.spec.trim()}`)] : []),
      '',
      `## Attached files (${files.length})`,
      files.length ? renderSpecFiles(files) : '(none)',
      '',
      '## Targeted KB notes & files — the author\'s knowledge map (sources, overlaps)',
      tkbNotes || '(none)',
    ].join('\n'));
  } catch (err) {
    console.error('[builder-mcp] spec failed:', err);
    res.status(500).type('text/plain').send(`Could not read the spec: ${err.message}`);
  }
});

// ─── Knowledge bases (task #868) ───────────────────────────────────
//
// Reads are the same functions Alfred's KB tools call, so what the
// assistant sees here and what Alfred sees can't disagree. The one write
// — connecting a KB to an agent — is add-only and refuses anything that
// isn't a real KB in the active index: an assistant must never be able to
// wire an agent to a KB that doesn't exist (that is exactly how a
// retriever ends up "MISSING" and silently finding nothing).

router.get('/kbs', async (req, res) => {
  try {
    sendText(res, await alfredTools.listKnowledgeBases());
  } catch (err) {
    console.error('[builder-mcp] kbs failed:', err);
    res.status(500).type('text/plain').send(`Could not list knowledge bases: ${err.message}`);
  }
});

router.get('/agents/:slug/kbs', async (req, res) => {
  try {
    const out = await alfredTools.agentKnowledgeBases(req.params.slug);
    if (out.startsWith('No agent with slug')) return res.status(404).type('text/plain').send(`${out} Fetch ../agents for the list.`);
    sendText(res, out);
  } catch (err) {
    console.error('[builder-mcp] agent kbs failed:', err);
    res.status(500).type('text/plain').send(`Could not read that agent's knowledge bases: ${err.message}`);
  }
});

router.get('/kbs/:namespace/files', async (req, res) => {
  try {
    const out = await alfredTools.listKbFiles(req.params.namespace);
    if (!out.startsWith('Files in KB')) return res.status(404).type('text/plain').send(`${out} Fetch ../kbs for the list.`);
    sendText(res, out);
  } catch (err) {
    console.error('[builder-mcp] kb files failed:', err);
    res.status(500).type('text/plain').send(`Could not list that KB's files: ${err.message}`);
  }
});

router.get('/kbs/:namespace/files/:fileId', async (req, res) => {
  try {
    const out = await alfredTools.readKbFile(req.params.namespace, req.params.fileId);
    if (!out.startsWith('"')) return res.status(404).type('text/plain').send(out);
    sendText(res, out);
  } catch (err) {
    console.error('[builder-mcp] kb file failed:', err);
    res.status(500).type('text/plain').send(`Could not read that file: ${err.message}`);
  }
});

router.post('/agents/:slug/kbs', async (req, res) => {
  try {
    const namespace = String(req.body?.namespace || '').trim();
    if (!namespace) {
      return res.status(400).type('text/plain').send('Send { "namespace": "<kb name>" }. Fetch ../kbs for the names.');
    }
    const project = await builderProjects.hydrateProject({ agentSlug: req.params.slug });
    const agent = project && project.agents[0];
    if (!agent) {
      return res.status(404).type('text/plain').send(`No agent with slug "${req.params.slug}". Fetch ../agents for the list.`);
    }
    if (!(await alfredTools.kbExists(namespace))) {
      return res.status(404).type('text/plain').send(
        `There is no knowledge base "${namespace}" to connect — nothing was changed. ` +
        'Fetch ../kbs for the ones that exist. A KB is created by uploading files in the admin screen, not here.',
      );
    }
    const { kbLinks } = require('../../db/schema');
    const inserted = await require('../../services/db.pg').getDrizzle()
      .insert(kbLinks)
      .values({ indexName: alfredTools.KB_INDEX(), namespace, agentId: agent.id })
      .onConflictDoNothing()
      .returning({ id: kbLinks.id });
    const name = agent.name || agent.slug;
    sendText(res, [
      inserted.length
        ? `Connected "${namespace}" to ${name}. It now shows in the Builder for this agent.`
        : `"${namespace}" was already connected to ${name} — nothing changed.`,
      'Connecting only makes it visible. To make the agent actually search it, a KB Retriever addon must list it',
      'in config.kbNamespaces — edit the crew (or the agent cortex) and POST it back as usual.',
    ].join('\n'));
  } catch (err) {
    console.error('[builder-mcp] connect kb failed:', err);
    res.status(500).type('text/plain').send(`Could not connect that knowledge base: ${err.message}`);
  }
});

// ─── Partner domains ───────────────────────────────────────────────
//
// A design partner building their own chat face in a browser needs their
// site allowed by CORS. They register it here with a secret Shlomi hands
// out (`PARTNER_DOMAIN_SECRET`, set on the server). No secret configured
// means registration is off — the safe default for a deploy that precedes
// setting it.

const crypto = require('crypto');
const partnerOrigins = require('../../services/partner-origins.service');

function secretOk(given) {
  const expected = process.env.PARTNER_DOMAIN_SECRET || '';
  if (!expected) return null;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function guard(res, secret) {
  const ok = secretOk(secret);
  if (ok === null) {
    res.status(503).type('text/plain').send('Adding domains is not switched on for this server.');
    return false;
  }
  if (!ok) {
    res.status(403).type('text/plain').send('That secret is not right. Ask Shlomi for the partner secret.');
    return false;
  }
  return true;
}

router.get('/domains', async (req, res) => {
  if (!guard(res, req.query.secret)) return;
  try {
    const list = await partnerOrigins.list();
    sendText(res, list.length ? ['Partner domains allowed:', '', ...list.map(o => `- ${o}`)].join('\n') : 'No partner domains yet.');
  } catch (err) {
    res.status(500).type('text/plain').send(`Could not read the domains: ${err.message}`);
  }
});

router.post('/domains', async (req, res) => {
  const b = req.body || {};
  if (!guard(res, b.secret)) return;
  const origin = partnerOrigins.normalize(b.origin);
  if (!origin) {
    return res.status(400).type('text/plain').send(
      'Send "origin" as the site address only, e.g. "https://chat.example.com" — https, no path. (http://localhost is fine for development.)',
    );
  }
  try {
    const { added } = await partnerOrigins.add(origin);
    sendText(res, added
      ? `Added ${origin}. A page on that site can now call this server from the browser — allow up to a minute to take effect everywhere.`
      : `${origin} was already allowed.`);
  } catch (err) {
    console.error('[builder-mcp] add domain failed:', err);
    res.status(500).type('text/plain').send(`Could not add the domain: ${err.message}`);
  }
});

router.delete('/domains', async (req, res) => {
  const b = req.body || {};
  if (!guard(res, b.secret)) return;
  const origin = partnerOrigins.normalize(b.origin);
  if (!origin) return res.status(400).type('text/plain').send('Send the "origin" to remove.');
  try {
    const removed = await partnerOrigins.remove(origin);
    sendText(res, removed ? `Removed ${origin}.` : `${origin} was not on the list.`);
  } catch (err) {
    res.status(500).type('text/plain').send(`Could not remove the domain: ${err.message}`);
  }
});

// ─── The LYBI task board ───────────────────────────────────────────
//
// The LYBI board only — `task.service` over the platform DB, the same
// board as /api/tasks. NOT the Aspect/IC board (`/api/taskboard`,
// aspect_tasks_db), which is a different product with its own people.
//
// Identity is a name the person gives their assistant, exactly as on the
// board itself (which takes it from a "who are you?" picker). There is no
// auth anywhere on the board, so "only edit what you opened" prevents
// mistakes rather than impersonation — the same trust model as the board.
//
// Names are resolved against the roster (`task_assignees`) and stored in
// the roster's own spelling. That matters more than it looks: attention,
// notifications and the digest email all match on the opener's name, so a
// task opened under any other string is silently invisible to its owner.
// The Quick Bug button already does this by storing a browser id.

const taskService = require('../../services/task.service');
const commentsService = require('../../services/comments.service');

const TASK_TYPES = ['bug', 'feature', 'task', 'idea', 'test', 'read'];
const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'];
/** Sidebar items that live on the board table but are not work. */
const NON_WORK_TYPES = new Set(['goal', 'agenda']);
/**
 * What an opener may change on their own task. Status, assignee and the
 * release notes are deliberately absent: in the board's flow, moving to
 * Done and writing What changed belong to the assignee, and releasing to
 * Shlomi.
 */
const OPENER_EDITABLE = ['title', 'description', 'priority', 'type', 'dueDate'];

async function rosterNames() {
  return (await taskService.getAssignees()).map(a => a.name);
}

/** The roster's exact spelling for a claimed name, or null. */
async function resolvePerson(name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return (await rosterNames()).find(n => n.toLowerCase() === wanted) || null;
}

async function unknownPerson(res, name) {
  const names = await rosterNames();
  return res.status(400).type('text/plain').send(
    `"${name || ''}" is not on the board. Ask the person which of these they are: ${names.join(', ')}.`,
  );
}

/** Board descriptions are rich-text HTML; show the words. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Plain text in, the board's HTML out — otherwise every line break an
 * assistant writes collapses into one paragraph in the board's editor.
 * Text that already contains tags is trusted as HTML.
 */
function textToHtml(text) {
  const s = String(text || '').trim();
  if (!s || /<[a-z][\s\S]*>/i.test(s)) return s;
  const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function taskLine(t) {
  const bits = [`#${t.id} ${t.title}`, t.status, t.type, t.priority];
  if (t.assignee) bits.push(`assignee ${t.assignee}`);
  if (t.opener) bits.push(`opened by ${t.opener}`);
  if (t.isCompleted) bits.push('closed');
  return `- ${bits.join(' · ')}`;
}

router.get('/people', async (_req, res) => {
  try {
    sendText(res, [
      'People on the LYBI board — use these exact names:',
      '',
      ...(await rosterNames()).map(n => `- ${n}`),
    ].join('\n'));
  } catch (err) {
    console.error('[builder-mcp] people failed:', err);
    res.status(500).type('text/plain').send(`Could not read the roster: ${err.message}`);
  }
});

/**
 * The board, compact. Closed tasks and sidebar items (goals, agenda) are
 * left out unless asked for — the live board is several hundred rows, and
 * almost every question is about open work.
 */
router.get('/tasks', async (req, res) => {
  try {
    const { assignee, status, type, priority, opener, all } = req.query;
    const openerName = opener ? await resolvePerson(opener) : null;
    if (opener && !openerName) return unknownPerson(res, opener);
    const assigneeName = assignee ? (await resolvePerson(assignee)) || assignee : undefined;

    let rows = await taskService.getTasks({ assignee: assigneeName, status, type, priority });
    rows = rows.filter(t => !NON_WORK_TYPES.has(t.type));
    if (!all) rows = rows.filter(t => !t.isCompleted);
    if (openerName) rows = rows.filter(t => (t.opener || '').toLowerCase() === openerName.toLowerCase());

    const shown = rows.slice(0, 150);
    sendText(res, [
      `${rows.length} task${rows.length === 1 ? '' : 's'}${all ? '' : ' (closed ones hidden — add all=1)'}, newest first.`,
      rows.length > shown.length ? `Showing the first ${shown.length}; narrow with assignee, status, type, priority or opener.` : '',
      '',
      ...shown.map(taskLine),
    ].filter(l => l !== null).join('\n'));
  } catch (err) {
    console.error('[builder-mcp] tasks failed:', err);
    res.status(500).type('text/plain').send(`Could not read the board: ${err.message}`);
  }
});

/**
 * "Does anything need my attention?"
 *
 * Delegates to the board's own definition (`getTasksNeedingAttention`) —
 * the same one behind the board's badge and the digest email — rather
 * than a second copy that would drift. Registered before `/tasks/:id` so
 * "attention" is not read as a task id.
 */
router.get('/tasks/attention', async (req, res) => {
  try {
    const name = await resolvePerson(req.query.name);
    if (!name) return unknownPerson(res, req.query.name);

    const ids = await commentsService.getTasksNeedingAttention(name);
    if (!ids.length) return sendText(res, `Nothing needs ${name}'s attention right now.`);

    const out = [`${ids.length} task${ids.length === 1 ? '' : 's'} need${ids.length === 1 ? 's' : ''} ${name}'s attention:`, ''];
    for (const id of ids) {
      const t = await taskService.getTask(id);
      if (!t) continue;
      const comments = await commentsService.getComments(id);
      const last = comments[comments.length - 1];
      out.push(taskLine(t));
      out.push(last
        ? `    last comment by ${last.author}: ${htmlToText(last.content).slice(0, 240)}`
        : '    a "read" task assigned to them, not yet marked read');
    }
    out.push('', `Open any of them with ${urls(req).base}/tasks/<id> for the full thread.`);
    sendText(res, out.join('\n'));
  } catch (err) {
    console.error('[builder-mcp] attention failed:', err);
    res.status(500).type('text/plain').send(`Could not work out attention: ${err.message}`);
  }
});

router.get('/tasks/:id', async (req, res) => {
  try {
    const t = await taskService.getTask(Number(req.params.id));
    if (!t) return res.status(404).type('text/plain').send(`No task #${req.params.id} on the LYBI board.`);
    const comments = await commentsService.getComments(t.id);
    sendText(res, [
      `# #${t.id} ${t.title}`,
      '',
      `Status ${t.status} · ${t.type} · ${t.priority} priority · assignee ${t.assignee || 'nobody'} · opened by ${t.opener || 'unknown'}${t.isCompleted ? ' · closed' : ''}`,
      t.dueDate ? `Due ${String(t.dueDate).slice(0, 10)}` : '',
      '',
      '## Description',
      '',
      htmlToText(t.description) || '(none)',
      ...(t.whatChanged ? ['', '## What changed', '', t.whatChanged] : []),
      '',
      `## Comments (${comments.length})`,
      '',
      ...(comments.length ? comments.map(c => {
        const likes = (c.likedBy || []).length ? `  [liked by ${c.likedBy.join(', ')}]` : '';
        return `**${c.author}** — ${new Date(c.createdAt).toISOString().slice(0, 16).replace('T', ' ')}${likes}\n${htmlToText(c.content)}\n`;
      }) : ['(none)']),
    ].join('\n'));
  } catch (err) {
    console.error('[builder-mcp] task failed:', err);
    res.status(500).type('text/plain').send(`Could not read that task: ${err.message}`);
  }
});

/**
 * Open a task. `opener` is required and must be on the roster; the
 * assignee is Shlomi or the opener themself, Shlomi by default. Assigning
 * to someone other than the opener notifies them, exactly as the board
 * does.
 */
router.post('/tasks', async (req, res) => {
  try {
    const b = req.body || {};
    const opener = await resolvePerson(b.opener);
    if (!opener) return unknownPerson(res, b.opener);

    const title = String(b.title || '').trim();
    if (!title) return res.status(400).type('text/plain').send('A task needs a "title".');

    const shlomi = (await resolvePerson('Shlomi')) || 'Shlomi';
    const assignee = b.assignee ? await resolvePerson(b.assignee) : shlomi;
    if (!assignee || ![shlomi, opener].includes(assignee)) {
      return res.status(400).type('text/plain').send(
        `A task opened here is assigned either to ${shlomi} or to the opener (${opener}). Anything else is arranged on the board itself.`,
      );
    }

    const type = b.type ? String(b.type).toLowerCase() : 'task';
    if (!TASK_TYPES.includes(type)) {
      return res.status(400).type('text/plain').send(`"type" is one of: ${TASK_TYPES.join(', ')}.`);
    }
    const priority = b.priority ? String(b.priority).toLowerCase() : 'medium';
    if (!TASK_PRIORITIES.includes(priority)) {
      return res.status(400).type('text/plain').send(`"priority" is one of: ${TASK_PRIORITIES.join(', ')}.`);
    }

    const task = await taskService.createTask({
      title,
      description: textToHtml(b.description),
      type,
      priority,
      status: 'todo',
      domain: 'general',
      assignee,
      opener,
      dueDate: b.dueDate || null,
    });

    sendText(res, [
      `Opened #${task.id} "${task.title}" — ${type}, ${priority} priority, assigned to ${assignee}.`,
      assignee !== opener ? `${assignee} has been notified.` : '',
      `${urls(req).base}/tasks/${task.id}`,
    ].filter(Boolean).join('\n'));
  } catch (err) {
    console.error('[builder-mcp] create task failed:', err);
    res.status(500).type('text/plain').send(`Could not open the task: ${err.message}`);
  }
});

/**
 * Edit a task — only its opener, only the fields in OPENER_EDITABLE.
 * Anything else in the body is refused by name rather than ignored, so an
 * assistant that tried to move a task to Done learns that it can't instead
 * of reporting success.
 */
router.patch('/tasks/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const name = await resolvePerson(b.name);
    if (!name) return unknownPerson(res, b.name);

    const t = await taskService.getTask(Number(req.params.id));
    if (!t) return res.status(404).type('text/plain').send(`No task #${req.params.id} on the LYBI board.`);
    if ((t.opener || '').toLowerCase() !== name.toLowerCase()) {
      return res.status(403).type('text/plain').send(
        `#${t.id} was opened by ${t.opener || 'someone else'}, not ${name}. Only the person who opened a task can edit it here — ${name} can still comment on it on the board.`,
      );
    }

    const refused = Object.keys(b).filter(k => k !== 'name' && !OPENER_EDITABLE.includes(k));
    if (refused.length) {
      return res.status(400).type('text/plain').send(
        `Can't change ${refused.join(', ')} from here — only ${OPENER_EDITABLE.join(', ')}. Status, assignee and release notes are changed on the board.`,
      );
    }

    const updates = {};
    for (const k of OPENER_EDITABLE) if (b[k] !== undefined) updates[k] = b[k];
    if (!Object.keys(updates).length) {
      return res.status(400).type('text/plain').send(`Nothing to change. Send any of: ${OPENER_EDITABLE.join(', ')}.`);
    }
    if (updates.title !== undefined && !String(updates.title).trim()) {
      return res.status(400).type('text/plain').send('A title cannot be empty.');
    }
    if (updates.type !== undefined) {
      updates.type = String(updates.type).toLowerCase();
      if (!TASK_TYPES.includes(updates.type)) {
        return res.status(400).type('text/plain').send(`"type" is one of: ${TASK_TYPES.join(', ')}.`);
      }
    }
    if (updates.priority !== undefined) {
      updates.priority = String(updates.priority).toLowerCase();
      if (!TASK_PRIORITIES.includes(updates.priority)) {
        return res.status(400).type('text/plain').send(`"priority" is one of: ${TASK_PRIORITIES.join(', ')}.`);
      }
    }
    if (updates.description !== undefined) updates.description = textToHtml(updates.description);

    const saved = await taskService.updateTask(t.id, { ...updates, updatedBy: name });
    sendText(res, `Updated #${saved.id} "${saved.title}" — changed ${Object.keys(updates).join(', ')}.`);
  } catch (err) {
    console.error('[builder-mcp] edit task failed:', err);
    res.status(500).type('text/plain').send(`Could not edit the task: ${err.message}`);
  }
});

// ─── Talking to an agent (task #894) ───────────────────────────────

/**
 * The building blocks an outside assistant uses to simulate conversations
 * by itself. Logic and the reasons behind it: services/mcpConversations.js.
 * A refusal the caller can fix carries `err.status` and a sentence.
 */
function simFail(res, err, what) {
  if (err && err.status) return res.status(err.status).type('text/plain').send(err.message);
  console.error(`[builder-mcp] ${what} failed:`, err);
  return res.status(500).type('text/plain').send(`Could not ${what}: ${err.message}`);
}

router.post('/agents/:slug/conversations', async (req, res) => {
  try {
    const b = req.body || {};
    const by = await resolvePerson(b.name);
    if (!by) return unknownPerson(res, b.name);
    res.status(201).json(await mcpConversations.startConversation({
      slug: req.params.slug,
      by,
      version: b.version,
      label: b.label,
      startCrew: b.startCrew,
      fields: b.fields,
    }));
  } catch (err) {
    simFail(res, err, 'start the conversation');
  }
});

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await mcpConversations.sendMessage({
      conversationId: req.params.id,
      text: b.text ?? b.userMessage ?? b.message,
    }));
  } catch (err) {
    simFail(res, err, 'send the message');
  }
});

router.get('/conversations/:id/state', async (req, res) => {
  try {
    res.json(await mcpConversations.readState({ conversationId: req.params.id }));
  } catch (err) {
    simFail(res, err, 'read the conversation state');
  }
});

router.post('/simulate/user-reply', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await mcpConversations.userReply({
      persona: b.persona,
      goal: b.goal,
      conversationId: b.conversationId,
      transcript: b.transcript,
      model: b.model,
    }));
  } catch (err) {
    simFail(res, err, 'write the user reply');
  }
});

module.exports = router;
