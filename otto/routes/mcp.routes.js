/**
 * The "build with your own AI" door — task #96.
 *
 * A person in a client pastes ONE url into their own AI tool (Claude Code,
 * Codex, a chat that can fetch) and that tool learns, from the pages below,
 * how to build Intelligence Center apps on that client's data. Modelled on
 * LYBI's builder/routes/mcpRoute.js — read docs/guides/BUILDER_MCP_MAINTENANCE.md
 * for why it looks the way it does (text/plain prose, URLs from the request,
 * errors as sentences). Unlike that door, the SAME URL is also a real MCP
 * server (Streamable HTTP, stateless): a GET returns the guide for tools that
 * fetch (Claude Code, Codex), a JSON-RPC POST serves the MCP tools for chats
 * that connect (Claude.ai, ChatGPT, Claude Desktop, Cursor). Business people
 * use the latter, and those chats cannot POST to a plain URL. Both doors call
 * one set of operations (`ops` below) and share one guide (`entryDoc`).
 *
 * Unlike that door it is authenticated and isolated, because what is behind
 * it is a client's real business data:
 *
 *   /intelligence/:slug/mcp/:token/...
 *
 * - the token is signed over the slug (otto/services/mcp-token.service.js),
 *   so one client's link opens nothing of another's;
 * - every read and write goes through Otto's dataset-scoped store and brief;
 * - the door is open only while BOTH `ai-builder` and `otto` are live.
 *
 * What it can and cannot do, deliberately:
 * - it never runs a model — the client's tool does the thinking;
 * - it never accepts SQL or code — only a screen spec, validated, executed
 *   under Otto's caps and verified by Otto's probes before it is stored;
 * - it grants the person NOTHING they cannot already do in Otto's UI.
 *   Publish, unpublish ("Edit") and delete exist with exactly the builder's
 *   rules (screens.store + otto.routes): creator only; delete only a draft
 *   that was never published (a published app's removal stays super-admin).
 *   The guide tells the AI to get the person's explicit yes before publish
 *   or delete — those are the two that reach other people or cannot be undone.
 *
 *   GET    /                    the guide (entry page) — includes the command list
 *   GET    /setup               slash-command files for Claude Code / Codex
 *   GET    /schema              the client's data: sources, fields, caveats
 *   GET    /apps                apps this person can see
 *   GET    /apps/:id            one app, with its full spec (examples to copy)
 *   POST   /check               dry run: validate + query + verify, saves nothing
 *   POST   /apps                save a new app (draft on the person's shelf)
 *   POST   /apps/:id            change an app that is not published
 *   POST   /apps/:id/publish    "Save to Apps" — visible to the organisation
 *   POST   /apps/:id/unpublish  "Edit" — a published app back to an editable draft
 *   DELETE /apps/:id            delete a never-published draft
 *   POST   /apps/:id/delete     same, for tools that cannot send DELETE
 */

const express = require('express');

const datasetRegistry = require('../../insights/datasets/registry');
const moduleService = require('../../modules/services/module.service');
const tokens = require('../services/mcp-token.service');
const mcp = require('../services/mcp.service');
const screens = require('../services/screens.store');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const {
  BLOCK_KINDS, KPI_AGGS, MEASURE_AGGS, CHART_VARIANTS, ICONS, FORMATS, TONES, ACTION_TYPES, MAX_LIMIT,
} = require('../services/spec.contract');

const router = express.Router();

/** Where a person opens an app. The door runs on the API host, not the UI's. */
const APP_ORIGIN = process.env.CLIENT_APP_ORIGIN || 'https://aspect-agents.web.app';

// ── plumbing (same contract as the LYBI door) ───────────────────────────────

function urls(req) {
  const first = h => String(req.headers[h] || '').split(',')[0].trim();
  const proto = first('x-forwarded-proto') || req.protocol;
  const host = first('x-forwarded-host') || req.get('host');
  const origin = `${proto}://${host}`;
  return { origin, base: `${origin}/intelligence/${req.params.slug}/mcp/${req.params.token}` };
}

/** text/plain on purpose: chat reader tools refuse text/markdown outright. */
function sendText(res, body, status = 200) {
  res.status(status).type('text/plain; charset=utf-8').send(body);
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[ai-builder] ${req.method} ${req.path}:`, err);
      res.status(status).json({
        error: status >= 500 ? `Something broke on our side (${err.message}). Try again; if it repeats, tell the person.` : err.message,
        ...(err.detail ? { detail: err.detail } : {}),
      });
    }
  };
}

const appUrl = (slug, id) => `${APP_ORIGIN}/${slug}/intelligence/apps/${id}`;

// ── the gate ────────────────────────────────────────────────────────────────

// A link pasted without its key — Express's own "Cannot GET" HTML would leave
// the assistant guessing.
router.all('/:slug/mcp', (req, res) => sendText(res,
  'This link is missing its personal key. Copy the full link from Intelligence Center > Apps > "Your own AI".', 401));

router.use('/:slug/mcp/:token', async (req, res, next) => {
  try {
    if (await openDoor(req, res)) next();
  } catch (err) {
    console.error('[ai-builder] gate:', err);
    sendText(res, 'Something broke on our side while opening the door. Try again in a minute.', 500);
  }
});

/** @returns {Promise<boolean>} true when req.door is set; otherwise it has answered. */
async function openDoor(req, res) {
  const { slug, token } = req.params;
  const entry = datasetRegistry.get(slug);
  const refuse = (status, text) => { sendText(res, text, status); return false; };
  if (!entry) return refuse(404, `There is no Intelligence Center client called '${slug}'. Check the link you were given.`);
  if (!await tokens.doorOpen(slug)) {
    return refuse(403, 'Building with your own AI is not switched on for this account. Ask your Aspect contact to enable it.');
  }
  const viewerId = await tokens.verify(slug, token);
  if (!viewerId) {
    return refuse(401, 'This link is not valid for this account. Copy a fresh one from Intelligence Center > Apps > "Build with your own AI".');
  }
  const otto = await moduleService.getForDataset(slug, 'otto');
  if (!otto?.binding) return refuse(503, 'This account has no data description yet. Ask your Aspect contact to finish setting up Otto.');

  req.door = {
    viewerId,
    ctx: {
      datasetId: slug,
      brief: otto.binding,
      pool: entry.getPool(),
      schemaName: entry.schemaName,
    },
  };
  return true;
}

// ── the guide ───────────────────────────────────────────────────────────────

/**
 * How the guide names each operation. One text serves two doors — the HTTP
 * page (Claude Code, Codex: they fetch and POST) and the MCP server (Claude.ai,
 * ChatGPT, Desktop, Cursor: they call tools) — so the rules, the format and
 * the traps are written once and cannot drift between them.
 */
function opNames(base, mcp) {
  if (mcp) {
    const t = n => `the \`${n}\` tool`;
    return {
      schema: t('get_schema'), apps: t('list_apps'), app: t('get_app'), check: t('check_app'),
      create: t('create_app'), update: t('update_app'), publish: t('publish_app'),
      unpublish: t('unpublish_app'), remove: t('delete_app'),
    };
  }
  return {
    schema: `GET \`${base}/schema\``,
    apps: `GET \`${base}/apps\``,
    app: `GET \`${base}/apps/<id>\``,
    check: `POST \`${base}/check\` with body \`{"spec": {...}}\``,
    create: `POST \`${base}/apps\``,
    update: `POST \`${base}/apps/<id>\``,
    publish: `POST \`${base}/apps/<id>/publish\``,
    unpublish: `POST \`${base}/apps/<id>/unpublish\``,
    remove: `DELETE \`${base}/apps/<id>\` (or POST \`${base}/apps/<id>/delete\` if your tool cannot send DELETE)`,
  };
}

function entryDoc(req, { mcp = false } = {}) {
  const { base } = urls(req);
  const { slug } = req.params;
  const brief = req.door.ctx.brief;
  const name = datasetRegistry.get(slug)?.defaultMeta?.name || slug;
  const sourceList = (brief.sources || []).map(s => `${s.id} (${s.label.en})`).join(', ');
  const o = opNames(base, mcp);

  return `# Aspect Intelligence Center — build apps for ${name}

You are an AI assistant helping a person at "${slug}" build an APP for their
Intelligence Center: an operational screen (KPI cards, a filterable table,
charts, export) over their own live business data. ${mcp ? 'These instructions teach\nyou everything; the tools do the rest.' : 'This page teaches you\neverything. Read it whole before doing anything.'}

This link is personal. It works only for "${slug}" and acts as the person who
copied it. Do not paste it anywhere public.

## How an app works — read this first

You never write SQL, HTML or code. An app is a JSON **screen spec**: a few
declared result sets over the client's data sources, and a list of blocks
from a fixed catalog. Our server compiles the SQL, runs it under safety caps,
verifies the numbers, and the Intelligence Center renders the blocks natively
(client branding, English and Hebrew, right-to-left). So your job is: pick the
right sources and fields, shape them, and lay out the blocks.

Data sources for this account: ${sourceList || '(none)'}.
Get the full field list with ${o.schema} before composing anything.
${mcp ? '' : `
(Using Claude.ai, ChatGPT, Claude Desktop or Cursor? This same link is also an
MCP server — add it as a custom connector, no authentication, and the tools
below appear natively. Plain web chats cannot send the POST requests this
page uses, so a connector is the way to build from them.)
`}
## Commands

The person may type these${mcp ? '' : ' (in Claude Code they become real slash commands\nafter `setup`; anywhere else, treat the words as the same requests)'}:

| Command | What you do |
|---|---|
| help | Explain in two or three sentences what you can build, then suggest three ideas that fit the data. |
| schema | ${o.schema}, then summarise it in plain words: what data exists, what is missing, the caveats. |
| list | ${o.apps}, then show a short table: title, status, whether it is theirs (\`mine\`), link. |
| show <id> | ${o.app}, then describe the app: what it shows, from which data. |
| create <description> | Build a new app — follow "The workflow" below. |
| update <id> <change> | Change an existing app — same workflow, saved with ${o.update}. |
| check <id> | ${o.app}, run its spec through ${o.check}, report the numbers and any failed probe. |
| publish <id> | Confirm with the person, then publish — see "Publishing, changing, deleting". |
| unpublish <id> | Explain what it means, then take a published app back to an editable draft. |
| delete <id> | Confirm with the person, then delete a never-published draft. |
${mcp ? '' : `| setup | GET ${base}/setup and follow it (installs the slash commands). |\n`}
## The workflow

1. **Understand the request.** Ask at most one or two short questions if it is
   genuinely ambiguous (which period? which stores?). Otherwise proceed.
2. **Read the data** with ${o.schema}. Use ONLY the source ids and field ids
   listed there, each field with its own source.
3. **Look at an example** if the account has apps: ${o.apps}, then ${o.app} on
   one — its "spec" is a working spec for this exact data.
4. **Compose the spec** (format below).
5. **Dry-run it** with ${o.check}.
   ${mcp ? 'The result carries `ok` true or false.' : 'The answer is HTTP 200 with `ok` true or false (a 4xx means the request\n   itself was malformed — its `error` says how).'}
   - \`ok: false\` → read \`errors\`; each one names the exact field to fix.
     Fix exactly those and check again. Do not guess at unrelated changes.
   - \`warnings\` (even when ok) → the screen would show something other than
     it seems to (a card wider than its table, a chart cut at 30 points).
     Fix the spec, or tell the person exactly what the card or chart covers.
   - \`ok: true\` → look at \`sample\` and \`kpis\`: are the numbers plausible?
     Tell the person what the screen will show, with one or two real figures.
     Numbers come back raw (617554195.15): round them and add the currency or
     unit when you quote them — the screen formats them itself.
6. **Store it as a draft** with ${o.create}:
   \`{"title": {"en": "...", "he": "..."}, "summary": {"en": "...", "he": "..."}, "icon": "<one of ${ICONS.join('/')}>", "spec": {...}}\`.
   The server runs the same check again and refuses anything that fails
   (${mcp ? 'an error result' : 'HTTP 422'}, the errors in \`detail\`). When the person says "save it", this
   is what they mean — a draft. Publishing is a separate, explicit step.
7. **Hand over:** give the person the \`openUrl\` from the answer. The app is a
   DRAFT on their own shelf, visible only to them until it is published.

## Publishing, changing, deleting

- **Publish** (= "Save to Apps"): makes the app visible to EVERYONE in the
  person's organisation. Only when they explicitly ask, and confirm first:
  "Publish '<title>' for everyone in your organisation?" Then
  ${o.publish}. Only a saved (built) draft publishes.
- **Change:** ${o.app}, edit its spec (change only what was asked), check,
  then ${o.update} with the new spec. Send an updated
  \`summary\` too whenever the change alters what the screen shows (title and
  icon are optional).
  A published app is frozen: first ${o.unpublish} — it goes
  back to an editable draft, disappears from colleagues until published again,
  and the person can still restore the published version from the app page.
  Say that to the person before you do it.
- **Delete:** only a draft that was never published, and only after the person
  confirms ("Delete '<title>'? This cannot be undone."). Then ${o.remove}.
  A published app cannot be deleted from here; tell the person to ask their
  Aspect contact.
- You can only change, publish or delete apps this person created — \`mine: true\`
  in the list. Other people's published apps are there to read and learn from.

## The spec format

\`\`\`json
{
  "specVersion": 1,
  "resultSets": [
    {
      "id": "rows",
      "source": "<source id from the schema>",
      "select": ["<field ids of that source>"],
      "computed": [ { "id": "shortfall", "label": {"en": "Shortfall", "he": "חוסר"}, "expr": "safety_stock - qty_on_hand", "format": "int" } ],
      "where": "shortfall > 0",
      "orderBy": { "field": "shortfall", "dir": "desc" },
      "limit": 500
    },
    {
      "id": "by_store",
      "source": "<source id>",
      "aggregate": {
        "groupBy": ["<field id>"],
        "measures": [
          { "id": "revenue", "agg": "sum", "expr": "qty * unit_price", "label": {"en": "Revenue", "he": "הכנסות"}, "format": "money" },
          { "id": "units", "agg": "sum", "field": "qty", "label": {"en": "Units", "he": "יחידות"}, "format": "int" },
          { "id": "lines", "agg": "count", "label": {"en": "Rows", "he": "שורות"}, "format": "int" }
        ]
      },
      "orderBy": { "field": "revenue", "dir": "desc" },
      "limit": 10
    }
  ],
  "blocks": [
    { "kind": "noteLine", "caveatIds": ["<caveat ids from the schema>"] },
    { "kind": "kpiCards", "from": "rows", "cards": [
        { "id": "below", "label": {"en": "Below safety stock", "he": "מתחת למלאי ביטחון"}, "sub": {"en": "items", "he": "פריטים"},
          "agg": "countWhere", "where": "shortfall > 0", "format": "int", "tone": "alarm" } ] },
    { "kind": "filterBar", "from": "rows", "filters": ["<text column ids>"] },
    { "kind": "dataTable", "from": "rows", "columns": ["<column ids in display order>"], "sortable": true, "pageSize": 50 },
    { "kind": "chart", "from": "by_store", "variant": "bar", "category": "<column id>", "series": ["revenue"], "title": {"en": "Revenue by store", "he": "הכנסות לפי חנות"} },
    { "kind": "actionsBar", "actions": [ { "id": "export", "type": "exportCsv", "from": "rows", "label": {"en": "Export", "he": "ייצוא"} } ] }
  ]
}
\`\`\`

## Rules — the server enforces every one

1. Block kinds: ${BLOCK_KINDS.join(', ')}. Nothing else exists. At most 10 blocks,
   and at least one dataTable, chart or kpiCards.
2. At most 4 result sets. Each reads ONE source. Use "select" for row-level
   data OR "aggregate" (groupBy + measures) for grouped data — never both.
3. Measure aggs: ${MEASURE_AGGS.join(', ')}. A measure aggregates one raw "field", or an
   "expr" over raw fields of the same source (e.g. qty * unit_price) — the expr
   runs per row, before the aggregate. "count" takes no field and counts ROWS
   (not distinct values) — check in the schema what one row of the source is.
4. "computed" columns run AFTER select/aggregate and can only use columns the
   result set already produces (selected fields, groupBy fields, measure ids).
5. Expressions ("expr", "where") are plain arithmetic plus at most one
   comparison over column ids — no functions, no strings, no AND/OR, no
   dates. So:
   - "the last 30 days" = aggregate by the date field, orderBy that date
     desc, limit 30 — good for a TABLE or a LINE chart (it is drawn oldest to
     newest). There is no date filter, so two things follow:
     * a KPI card on that result set does NOT cover those 30 days — cards
       ignore "limit" (rule 6). A "total for the last 30 days" card cannot be
       built; leave it out and tell the person, or label it as all-time.
     * every OTHER result set on the screen covers all history. Say so
       ("the store pie is for all time, not the last 30 days").
   - two conditions at once are not possible: keep the one that matters most
     and tell the person the screen shows that one.
   - filtering on a text value (one store, one category) is the person's job
     on the screen: give them a filterBar on that column.
   - a filterBar narrows ONLY the dataTable (and its export) on the same result
     set. KPI cards and charts never follow it — say so when it matters ("the
     chart always shows all categories").
6. KPI aggs: ${KPI_AGGS.join(', ')}. A card reads the result set in its block's "from":
   sum/avg/min/max take a "field" that is a COLUMN OF THAT RESULT SET (a selected
   field, a groupBy field, a measure id or a computed id); count counts its rows;
   countWhere needs a "where" over its columns. A card IGNORES the result set's
   "limit": it covers every row the "where" keeps (up to ${MAX_LIMIT}), not the rows
   a table shows. The check returns a \`warnings\` entry whenever that differs —
   read it and act on it. A kpiCards block holds 1-6 cards. Tones: ${TONES.join(', ')}.
7. Charts: variant ${CHART_VARIANTS.join(' / ')}; "category" is a column, "series" are NUMERIC
   columns (measures, computed columns or number fields — never text). A pie
   takes ONE non-negative series and at most 10 slices: its result set needs
   an orderBy and a limit of 10 or less. Both are checked. A "top 5" pie shows
   each slice's share OF THOSE FIVE, not of the total — title it that way
   ("Top 5 stores — share among them") or use a bar chart. Any chart draws at
   most 30 points.
8. Formats: ${FORMATS.join(', ')}. Action types: ${ACTION_TYPES.join(', ')} ("stub" = a button that
   shows a notice; it does nothing yet).
9. limit: 1-${MAX_LIMIT}. A source marked [heavy] in the schema is big — aggregate or filter it.
10. Every label is {"en": "...", "he": "..."} — BOTH, always. Write real Hebrew.
11. ids are lowercase identifiers (a-z, 0-9, _), unique in their scope.
12. Never invent a field, a number or a caveat. Open the screen with a noteLine
    carrying every caveat whose subject the screen shows (revenue on screen →
    the revenue caveats; categories → the category caveats). When unsure,
    include it: a missing caveat misleads, an extra one costs a line.
13. Order blocks as the person will read them: noteLine, kpiCards, filterBar,
    then the dataTable(s) and chart(s) in the order that tells the story, then
    actionsBar.

## How the check verifies

Every result set must return rows; no numeric column may be entirely empty;
every KPI is computed twice (in SQL, and again over the delivered rows) and
the two must agree — when a result set hits its limit the second computation
is skipped and the SQL value stands. A failed probe means the screen would show
a wrong or empty number — fix the spec, never work around the probe.

## Talking to the person

Use their language. They are business people, not developers: describe what
the screen shows and what they can do with it, not the JSON. Do not show them
the spec unless they ask.
`;
}

router.get('/:slug/mcp/:token', (req, res) => {
  // An MCP client may GET the endpoint asking for a server-sent event stream.
  // This server is stateless and never pushes, so it answers 405 — the spec's
  // way of saying "no stream here" — while a fetch of the page still gets it.
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/event-stream') && !/text\/(plain|html)|\*\/\*/.test(accept)) {
    return res.status(405).set('Allow', 'GET, POST').end();
  }
  sendText(res, entryDoc(req));
});
router.get('/:slug/mcp/:token/help', (req, res) => sendText(res, entryDoc(req)));

// ── slash-command setup ─────────────────────────────────────────────────────

const COMMANDS = [
  ['help', 'What can I build here?', 'help'],
  ['schema', 'What data does this account have?', 'schema'],
  ['list', 'List my Intelligence Center apps', 'list'],
  ['show', 'Describe one app: /ic-show <app id>', 'show $ARGUMENTS'],
  ['create', 'Build a new app: /ic-create <what you want to see>', 'create $ARGUMENTS'],
  ['update', 'Change an app: /ic-update <app id> <the change>', 'update $ARGUMENTS'],
  ['check', 'Re-check an app\'s numbers: /ic-check <app id>', 'check $ARGUMENTS'],
  ['publish', 'Share an app with your organisation: /ic-publish <app id>', 'publish $ARGUMENTS'],
  ['unpublish', 'Take a published app back to an editable draft: /ic-unpublish <app id>', 'unpublish $ARGUMENTS'],
  ['delete', 'Delete a draft: /ic-delete <app id>', 'delete $ARGUMENTS'],
];

router.get('/:slug/mcp/:token/setup', (req, res) => {
  const { base } = urls(req);
  const files = COMMANDS.map(([name, description, action]) => `--- file: .claude/commands/ic-${name}.md ---
---
description: ${description}
---
Read ${base} (the Aspect Intelligence Center guide) if you have not read it in this session, then perform its "${action.split(' ')[0]}" command.${action.includes('$ARGUMENTS') ? '\nArguments: $ARGUMENTS' : ''}
--- end ---`).join('\n\n');

  sendText(res, `# Setup — slash commands for the Intelligence Center

Ask the person first: "Shall I add /ic-... commands to this folder?" Then,
if they agree:

## Claude Code

Create these files in the CURRENT project folder, exactly as written (the
part between "--- file:" and "--- end ---"). Then tell the person to restart
the session or type /help to see /ic-help, /ic-list, /ic-create and the rest.

${files}

## Codex

Create the same files under ~/.codex/prompts/ named ic-help.md, ic-list.md and
so on (drop the ".claude/commands/" folder; keep the content). Codex invokes
them as /prompts:ic-list.

## Anywhere else

Nothing to install — the person can just say "list", "create ..." and you
follow the guide.

## Important

These files contain the person's personal link in plain text — tell them so,
in one sentence, after creating them: do not send, share or upload this
folder. If the folder is a git repository, also add .claude/commands/ic-*.md
to .gitignore so the link is never committed.
`);
});

// ── the operations — one implementation behind both doors ──────────────────
//
// The HTTP routes below and the MCP tools further down call these, so a
// person's AI gets the same answer whether it fetched a URL or called a tool.

const NEXT_DRAFT = 'Give the person openUrl. It is a draft only they can see; they press "Save to Apps" there (or ask you to publish) to share it with their organisation.';

function notFound(id) {
  return Object.assign(new Error(`There is no app '${id}' you can see — list_apps / GET apps lists the ones you can.`), { status: 404 });
}

function badSpec() {
  return Object.assign(new Error('send the screen spec as {"spec": {...}} — the format is in the guide'), { status: 400 });
}

const ops = {
  schemaText(slug, brief) {
    const lines = [`# Data for ${slug}`, '',
      'Every source below is one table you can read. Use the ids exactly as written,',
      'each field only with its own source. Labels are what the person calls it.', ''];
    for (const s of brief.sources || []) {
      lines.push(`## source: ${s.id} — ${s.label.en} / ${s.label.he}${s.heavy ? '  [heavy: aggregate or filter it]' : ''}`);
      if (s.description?.en) lines.push(s.description.en);
      for (const f of (brief.fields || []).filter(x => x.sourceId === s.id)) {
        lines.push(`- ${f.id}  (${f.type}${f.format ? `, ${f.format}` : ''})  "${f.label.en}" / "${f.label.he}"${f.description?.en ? ` — ${f.description.en}` : ''}`);
      }
      lines.push('');
    }
    if (brief.caveats?.length) {
      lines.push('## caveats — quote these in a noteLine block on any screen they touch');
      for (const c of brief.caveats) lines.push(`- [${c.id}] ${c.text?.en || ''}`);
      lines.push('');
    }
    if (brief.starters?.length) {
      lines.push('## ideas that fit this data');
      for (const s of brief.starters) lines.push(`- ${s.text?.en || ''}`);
    }
    return lines.join('\n');
  },

  async listApps(door, slug) {
    const list = await screens.list(slug, { viewerId: door.viewerId });
    return {
      apps: list.map(s => ({
        id: s.id,
        title: s.title,
        summary: s.summary,
        icon: s.icon,
        // Plain words: the person sees "draft" / "published", never our enum.
        status: s.status === 'active' ? 'published' : 'draft',
        built: s.hasSpec,
        // Same test the writes apply (screens.canEdit) — what this person may
        // change, publish or delete. Without it the assistant had to GET each
        // app to find out (first door test, 2026-10-03).
        mine: screens.canEdit(s, door.viewerId),
        openUrl: appUrl(slug, s.id),
      })),
    };
  },

  async getApp(door, slug, id) {
    const screen = await screens.get(slug, id);
    if (!screen || !screens.canView(screen, door.viewerId)) throw notFound(id);
    return {
      app: {
        id: screen.id,
        title: screen.title,
        summary: screen.summary,
        icon: screen.icon,
        status: screen.status === 'active' ? 'published' : 'draft',
        mine: screens.canEdit(screen, door.viewerId),
        editable: screen.status !== 'active' && screens.canEdit(screen, door.viewerId),
        openUrl: appUrl(slug, screen.id),
        spec: screen.screenSpec,
      },
    };
  },

  async check(door, body) {
    if (!body?.spec || typeof body.spec !== 'object') throw badSpec();
    return mcp.check(body.spec, door.ctx.brief, door.ctx);
  },

  async createApp(door, slug, body) {
    if (!body?.spec || typeof body.spec !== 'object') throw badSpec();
    const { screen, check } = await mcp.create(door.ctx, door.viewerId, body);
    return {
      saved: true,
      id: screen.id,
      status: 'draft',
      openUrl: appUrl(slug, screen.id),
      next: NEXT_DRAFT,
      kpis: check.kpis,
      ...(check.warnings?.length ? { warnings: check.warnings } : {}),
    };
  },

  async updateApp(door, slug, id, body) {
    const { screen, check } = await mcp.update(door.ctx, door.viewerId, id, body || {});
    return {
      saved: true,
      id: screen.id,
      status: screen.status === 'active' ? 'published' : 'draft',
      openUrl: appUrl(slug, screen.id),
      ...(check ? { kpis: check.kpis } : {}),
      ...(check?.warnings?.length ? { warnings: check.warnings } : {}),
      ...(body?.spec && !body?.summary ? { reminder: 'The summary was not changed — if this change alters what the screen shows, send an updated "summary" too.' } : {}),
    };
  },

  async publishApp(door, slug, id) {
    const screen = await mcp.publish(door.ctx, door.viewerId, id);
    return { published: true, id: screen.id, openUrl: appUrl(slug, screen.id), next: 'It is now on the Apps shelf of everyone in the organisation.' };
  },

  async unpublishApp(door, slug, id) {
    const screen = await mcp.unpublish(door.ctx, door.viewerId, id);
    return {
      published: false,
      id: screen.id,
      status: 'draft',
      openUrl: appUrl(slug, screen.id),
      next: 'It is an editable draft again and off colleagues\' shelves. Change it, then publish again — or the person can restore the published version from the app page.',
    };
  },

  async deleteApp(door, slug, id) {
    return mcp.remove(door.ctx, door.viewerId, id);
  },
};

// ── the HTTP door (Claude Code, Codex: fetch + POST) ────────────────────────

router.get('/:slug/mcp/:token/schema', (req, res) => {
  const { brief } = req.door.ctx;
  if (req.query.format === 'json') {
    return res.json({ sources: brief.sources, fields: brief.fields, caveats: brief.caveats || [], starters: brief.starters || [] });
  }
  sendText(res, `${ops.schemaText(req.params.slug, brief)}\n\nSame data as JSON: add ?format=json to this URL.`);
});

router.get('/:slug/mcp/:token/apps', handle(async (req, res) => {
  res.json(await ops.listApps(req.door, req.params.slug));
}));

router.get('/:slug/mcp/:token/apps/:id', handle(async (req, res) => {
  res.json(await ops.getApp(req.door, req.params.slug, req.params.id));
}));

router.post('/:slug/mcp/:token/check', handle(async (req, res) => {
  res.json(await ops.check(req.door, req.body));
}));

router.post('/:slug/mcp/:token/apps', handle(async (req, res) => {
  res.status(201).json(await ops.createApp(req.door, req.params.slug, req.body));
}));

router.post('/:slug/mcp/:token/apps/:id', handle(async (req, res) => {
  res.json(await ops.updateApp(req.door, req.params.slug, req.params.id, req.body));
}));

router.post('/:slug/mcp/:token/apps/:id/publish', handle(async (req, res) => {
  res.json(await ops.publishApp(req.door, req.params.slug, req.params.id));
}));

router.post('/:slug/mcp/:token/apps/:id/unpublish', handle(async (req, res) => {
  res.json(await ops.unpublishApp(req.door, req.params.slug, req.params.id));
}));

const removeHandler = handle(async (req, res) => {
  res.json(await ops.deleteApp(req.door, req.params.slug, req.params.id));
});
router.delete('/:slug/mcp/:token/apps/:id', removeHandler);
router.post('/:slug/mcp/:token/apps/:id/delete', removeHandler);

// ── the MCP door (Claude.ai, ChatGPT, Claude Desktop, Cursor: tools) ────────
//
// Same URL as the guide page. A POST of a JSON-RPC message is the MCP
// Streamable HTTP transport, stateless: a fresh server per request, nothing
// held between calls, so it scales with Cloud Run like any other route and
// the per-request gate (token, live modules) still decides everything.
// Business people live in ChatGPT and Claude.ai, not Claude Code, and those
// chats cannot POST to a URL — a connector is how they can build at all.

const ANY_SPEC = z.object({}).passthrough()
  .describe('The screen spec — the JSON object described in the instructions (specVersion, resultSets, blocks).');
const BILINGUAL = z.object({ en: z.string(), he: z.string() });
const APP_ID = z.string().describe('The app id, e.g. cm-1a2b3c4d5e6f7a8b (from list_apps).');

function buildMcpServer(req) {
  const door = req.door;
  const { slug } = req.params;
  const name = datasetRegistry.get(slug)?.defaultMeta?.name || slug;
  const server = new McpServer(
    { name: `aspect-intelligence-${slug}`, title: `${name} — Intelligence Center apps`, version: '1.0.0' },
    { instructions: entryDoc(req, { mcp: true }) },
  );

  const asResult = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
  // Tool errors go back as results, not protocol errors: the model must read
  // the sentence and act on it, exactly like a 4xx body over HTTP.
  const run = (fn) => async (args) => {
    try {
      return asResult(await fn(args || {}));
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[ai-builder] mcp ${slug}:`, err);
      return {
        isError: true,
        ...asResult({ error: status >= 500 ? 'Something broke on our side. Try again; if it repeats, tell the person.' : err.message, ...(err.detail ? { detail: err.detail } : {}) }),
      };
    }
  };
  const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  server.registerTool('get_guide', {
    title: 'How to build apps here',
    description: 'The full guide: how an app works, the workflow, the spec format and every rule. Read it before building if you have not seen the server instructions.',
    annotations: RO,
  }, run(() => entryDoc(req, { mcp: true })));

  server.registerTool('get_schema', {
    title: 'The company data',
    description: 'Every data source you can build on, with its fields (ids, types, labels in English and Hebrew), the caveats screens must state, and ideas that fit the data. Call this before composing any spec.',
    annotations: RO,
  }, run(() => ops.schemaText(slug, door.ctx.brief)));

  server.registerTool('list_apps', {
    title: 'List apps',
    description: 'The apps this person can see: their own drafts and the organisation\'s published apps. `mine: true` = they may change, publish or delete it.',
    annotations: RO,
  }, run(() => ops.listApps(door, slug)));

  server.registerTool('get_app', {
    title: 'Open an app',
    description: 'One app with its full spec — also the best example of a working spec for this data.',
    inputSchema: { id: APP_ID },
    annotations: RO,
  }, run(({ id }) => ops.getApp(door, slug, id)));

  server.registerTool('check_app', {
    title: 'Check a spec (dry run)',
    description: 'Validate a spec, run its queries on the live data and verify the numbers. Saves nothing. Returns ok, errors naming the exact field to fix, warnings, KPI values and sample rows.',
    inputSchema: { spec: ANY_SPEC },
    annotations: RO,
  }, run(({ spec }) => ops.check(door, { spec })));

  server.registerTool('create_app', {
    title: 'Save a new app (draft)',
    description: 'Store a checked spec as a new DRAFT app, visible only to this person. Re-checks it and refuses anything that fails. Returns openUrl to give the person.',
    inputSchema: {
      title: BILINGUAL.describe('App name in English and Hebrew, at most 60 characters each.'),
      summary: BILINGUAL.optional().describe('One sentence on what the screen shows, in English and Hebrew.'),
      icon: z.enum(ICONS).optional(),
      spec: ANY_SPEC,
    },
    annotations: WRITE,
  }, run(args => ops.createApp(door, slug, args)));

  server.registerTool('update_app', {
    title: 'Change an app',
    description: 'Replace the spec and/or title, summary, icon of one of this person\'s unpublished apps. A new spec is re-checked first. A published app must be unpublished first.',
    inputSchema: {
      id: APP_ID,
      spec: ANY_SPEC.optional(),
      title: BILINGUAL.optional(),
      summary: BILINGUAL.optional(),
      icon: z.enum(ICONS).optional(),
    },
    annotations: { ...WRITE, idempotentHint: true },
  }, run(({ id, ...body }) => ops.updateApp(door, slug, id, body)));

  server.registerTool('publish_app', {
    title: 'Publish to everyone (Save to Apps)',
    description: 'Make one of this person\'s built drafts visible to EVERYONE in the organisation. Only after the person explicitly confirms.',
    inputSchema: { id: APP_ID },
    annotations: { ...WRITE, idempotentHint: true },
  }, run(({ id }) => ops.publishApp(door, slug, id)));

  server.registerTool('unpublish_app', {
    title: 'Take back to draft (Edit)',
    description: 'Turn one of this person\'s published apps back into an editable draft. It leaves colleagues\' shelves until published again; the published version stays restorable. Tell the person before doing it.',
    inputSchema: { id: APP_ID },
    annotations: { ...WRITE, idempotentHint: true },
  }, run(({ id }) => ops.unpublishApp(door, slug, id)));

  server.registerTool('delete_app', {
    title: 'Delete a draft',
    description: 'Permanently delete one of this person\'s drafts that was never published. Cannot be undone — only after the person explicitly confirms.',
    inputSchema: { id: APP_ID },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, run(({ id }) => ops.deleteApp(door, slug, id)));

  return server;
}

router.post('/:slug/mcp/:token', async (req, res) => {
  const server = buildMcpServer(req);
  // Stateless: no session id, plain JSON answers (no SSE stream to hold open).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[ai-builder] mcp transport:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// A stateless server keeps no session to stream or end.
router.delete('/:slug/mcp/:token', (req, res) => {
  res.status(405).set('Allow', 'GET, POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server is stateless.' }, id: null });
});

// Anything else behind a valid key: a wrong path or a wrong verb. Answer with
// the map, not Express's HTML — an assistant handed "Cannot GET" guesses.
router.all('/:slug/mcp/:token/{*rest}', (req, res) => {
  res.status(404).json({
    error: `There is no ${req.method} ${req.path.replace(/^\/[^/]+\/mcp\/[^/]+/, '') || '/'} here. `
      + 'Reads are GET: /, /setup, /schema, /apps, /apps/<id>. Writes are POST: /check, /apps, /apps/<id>, '
      + '/apps/<id>/publish, /apps/<id>/unpublish, /apps/<id>/delete (or DELETE /apps/<id>). The guide at the link itself explains each.',
  });
});

/**
 * Errors thrown before the router runs — above all a JSON body that does not
 * parse (body-parser, app-wide). Mounted by server.js right after the router,
 * so it only ever sees /intelligence requests.
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: `the request body is not valid JSON (${err.message}). Send {"spec": {...}} as JSON with content-type: application/json — write it to a file and send the file if quoting gets in the way.` });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'the request body is too large. A screen spec is a few kilobytes — send only {"spec": {...}} and the title fields.' });
  }
  console.error('[ai-builder] unhandled:', err);
  res.status(500).json({ error: 'Something broke on our side. Try again; if it repeats, tell the person.' });
}

module.exports = router;
module.exports.errorHandler = errorHandler;
