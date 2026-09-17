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
 * version and moves only `viewingVersionId`. It never touches `active`
 * (what runs) or `published` (what customers get). A bad body is visible
 * in the Builder and undone by switching version. Nothing an outside
 * assistant does can reach a customer.
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

## Reading

| What | URL |
|---|---|
| Every agent — names and slugs | \`${base}/agents\` |
| One agent, full body and crews | \`${base}/agents/<slug>\` |
| Its recent conversations | \`${base}/agents/<slug>/conversations\` |
| A transcript, with what each addon did per turn | \`${base}/conversations/<id>\` |
| One addon run in full — assembled prompt, raw and parsed output | \`${base}/runs/<id>\` |
| History of changes to an agent, and why | \`${base}/agents/<slug>/log\` |
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
    sendText(res, await alfredTools.listAgents(), 'text/plain');
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

module.exports = router;
