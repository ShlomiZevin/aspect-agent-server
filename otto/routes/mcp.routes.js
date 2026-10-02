/**
 * The "build with your own AI" door — task #96.
 *
 * A person in a client pastes ONE url into their own AI tool (Claude Code,
 * Codex, a chat that can fetch) and that tool learns, from the pages below,
 * how to build Intelligence Center apps on that client's data. Modelled on
 * LYBI's builder/routes/mcpRoute.js — read docs/guides/BUILDER_MCP_MAINTENANCE.md
 * for why it looks the way it does (text/plain prose, URLs from the request,
 * errors as sentences). Like that door it is NOT an MCP server: MCP is a
 * protocol, and a tool handed a URL fetches.
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

function entryDoc(req) {
  const { base } = urls(req);
  const { slug } = req.params;
  const brief = req.door.ctx.brief;
  const name = datasetRegistry.get(slug)?.defaultMeta?.name || slug;
  const sourceList = (brief.sources || []).map(s => `${s.id} (${s.label.en})`).join(', ');

  return `# Aspect Intelligence Center — build apps for ${name}

You are an AI assistant helping a person at "${slug}" build an APP for their
Intelligence Center: an operational screen (KPI cards, a filterable table,
charts, export) over their own live business data. This page teaches you
everything. Read it whole before doing anything.

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
Get the full field list from \`${base}/schema\` before composing anything.

## Commands

The person may type these (in Claude Code they become real slash commands
after \`setup\`; anywhere else, treat the words as the same requests):

| Command | What you do |
|---|---|
| help | Explain in two or three sentences what you can build, then suggest three ideas that fit the data in /schema. |
| schema | GET ${base}/schema and summarise it for the person in plain words: what data exists, what is missing, the caveats. |
| list | GET ${base}/apps and show a short table: title, status, link. |
| show <id> | GET ${base}/apps/<id> and describe the app: what it shows, from which data. |
| create <description> | Build a new app — follow "The workflow" below. |
| update <id> <change> | Change an existing app — same workflow, POST to ${base}/apps/<id>. |
| check <id> | GET the app, POST its spec to ${base}/check, report the numbers and any failed probe. |
| publish <id> | Confirm with the person, then publish — see "Publishing, changing, deleting". |
| unpublish <id> | Explain what it means, then take a published app back to an editable draft. |
| delete <id> | Confirm with the person, then delete a never-published draft. |
| setup | GET ${base}/setup and follow it (installs the slash commands). |

## The workflow

1. **Understand the request.** Ask at most one or two short questions if it is
   genuinely ambiguous (which period? which stores?). Otherwise proceed.
2. **Read the data.** GET \`${base}/schema\`. Use ONLY the source ids and field
   ids listed there, each field with its own source.
3. **Look at an example** if the account has apps: GET \`${base}/apps\`, then
   GET one with \`/apps/<id>\` — its "spec" is a working spec for this exact data.
4. **Compose the spec** (format below).
5. **Dry-run it:** POST \`${base}/check\` with body \`{"spec": {...}}\`.
   - \`ok: false\` → read \`errors\`; each one names the exact field to fix.
     Fix exactly those and check again. Do not guess at unrelated changes.
   - \`ok: true\` → look at \`sample\` and \`kpis\`: are the numbers plausible?
     Tell the person what the screen will show, with one or two real figures.
6. **Save it:** POST \`${base}/apps\` with
   \`{"title": {"en": "...", "he": "..."}, "summary": {"en": "...", "he": "..."}, "icon": "<one of ${ICONS.join('/')}>", "spec": {...}}\`.
   The server runs the same check again and refuses anything that fails.
7. **Hand over:** give the person the \`openUrl\` from the answer. The app is a
   DRAFT on their own shelf, visible only to them until it is published.

## Publishing, changing, deleting

- **Publish** (= "Save to Apps"): makes the app visible to EVERYONE in the
  person's organisation. Only when they explicitly ask, and confirm first:
  "Publish '<title>' for everyone in your organisation?" Then
  POST \`${base}/apps/<id>/publish\`. Only a saved (built) draft publishes.
- **Change:** GET the app, edit its spec (change only what was asked), check,
  then POST \`${base}/apps/<id>\` with \`{"spec": {...}}\` (title/summary/icon optional).
  A published app is frozen: first POST \`${base}/apps/<id>/unpublish\` — it goes
  back to an editable draft, disappears from colleagues until published again,
  and the person can still restore the published version from the app page.
  Say that to the person before you do it.
- **Delete:** only a draft that was never published, and only after the person
  confirms ("Delete '<title>'? This cannot be undone."). Then
  DELETE \`${base}/apps/<id>\` — or POST \`${base}/apps/<id>/delete\` if your tool
  cannot send DELETE. A published app cannot be deleted from here; tell the
  person to ask their Aspect contact.
- You can only change, publish or delete apps this person created.

## The spec format

\`\`\`json
{
  "specVersion": 1,
  "resultSets": [
    {
      "id": "rows",
      "source": "<source id from /schema>",
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
        "measures": [ { "id": "revenue", "agg": "sum", "expr": "qty * unit_price", "label": {"en": "Revenue", "he": "הכנסות"}, "format": "money" } ]
      },
      "orderBy": { "field": "revenue", "dir": "desc" },
      "limit": 10
    }
  ],
  "blocks": [
    { "kind": "noteLine", "caveatIds": ["<caveat ids from /schema>"] },
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
   runs per row, before the aggregate.
4. "computed" columns run AFTER select/aggregate and can only use columns the
   result set already produces (selected fields, groupBy fields, measure ids).
5. Expressions ("expr", "where") are plain arithmetic plus at most one
   comparison over column ids — no functions, no strings, no AND/OR.
6. KPI aggs: ${KPI_AGGS.join(', ')}. sum/avg/min/max need a "field"; countWhere needs
   a "where". A kpiCards block holds 1-6 cards. Tones: ${TONES.join(', ')}.
7. Charts: variant ${CHART_VARIANTS.join(' / ')}; "category" is a column, "series" are numeric
   columns. A pie takes ONE non-negative series and at most 10 categories —
   give its result set an orderBy and a limit of 10 or less.
8. Formats: ${FORMATS.join(', ')}. Action types: ${ACTION_TYPES.join(', ')} ("stub" = a button that
   shows a notice; it does nothing yet).
9. limit: 1-${MAX_LIMIT}. A source marked [heavy] in /schema is big — aggregate or filter it.
10. Every label is {"en": "...", "he": "..."} — BOTH, always. Write real Hebrew.
11. ids are lowercase identifiers (a-z, 0-9, _), unique in their scope.
12. Never invent a field, a number or a caveat. If /schema lists a caveat that
    the screen touches, open the screen with a noteLine block quoting it.
13. Order blocks as the person will read them: noteLine, kpiCards, filterBar,
    dataTable/chart, actionsBar.

## How the check verifies

Every result set must return rows; no numeric column may be entirely empty;
every KPI is computed twice (SQL over the full set and again over the rows
the table shows) and must agree. A failed probe means the screen would show
a wrong or empty number — fix the spec, never work around the probe.

## Talking to the person

Use their language. They are business people, not developers: describe what
the screen shows and what they can do with it, not the JSON. Do not show them
the spec unless they ask.
`;
}

router.get('/:slug/mcp/:token', (req, res) => sendText(res, entryDoc(req)));
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

These files contain the person's personal link. If the folder is a git
repository, add .claude/commands/ic-*.md to .gitignore so the link is never
committed or shared.
`);
});

// ── reading ─────────────────────────────────────────────────────────────────

router.get('/:slug/mcp/:token/schema', (req, res) => {
  const { brief } = req.door.ctx;
  if (req.query.format === 'json') {
    return res.json({ sources: brief.sources, fields: brief.fields, caveats: brief.caveats || [], starters: brief.starters || [] });
  }
  const lines = [`# Data for ${req.params.slug}`, '',
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
  lines.push('', 'Same data as JSON: add ?format=json to this URL.');
  sendText(res, lines.join('\n'));
});

router.get('/:slug/mcp/:token/apps', handle(async (req, res) => {
  const { slug } = req.params;
  const list = await screens.list(slug, { viewerId: req.door.viewerId });
  res.json({
    apps: list.map(s => ({
      id: s.id,
      title: s.title,
      summary: s.summary,
      icon: s.icon,
      // Plain words: the person sees "draft" / "published", never our enum.
      status: s.status === 'active' ? 'published' : 'draft',
      built: s.hasSpec,
      openUrl: appUrl(slug, s.id),
    })),
  });
}));

router.get('/:slug/mcp/:token/apps/:id', handle(async (req, res) => {
  const { slug, id } = req.params;
  const screen = await screens.get(slug, id);
  if (!screen || !screens.canView(screen, req.door.viewerId)) {
    return res.status(404).json({ error: `There is no app '${id}' you can see. GET apps lists the ones you can.` });
  }
  res.json({
    app: {
      id: screen.id,
      title: screen.title,
      summary: screen.summary,
      icon: screen.icon,
      status: screen.status === 'active' ? 'published' : 'draft',
      editable: screen.status !== 'active' && screens.canEdit(screen, req.door.viewerId),
      openUrl: appUrl(slug, screen.id),
      spec: screen.screenSpec,
    },
  });
}));

// ── checking and saving ─────────────────────────────────────────────────────

function readSpec(req) {
  const spec = req.body?.spec;
  if (!spec || typeof spec !== 'object') {
    throw Object.assign(new Error('send the screen spec as {"spec": {...}} — the format is on the guide page'), { status: 400 });
  }
  return spec;
}

router.post('/:slug/mcp/:token/check', handle(async (req, res) => {
  res.json(await mcp.check(readSpec(req), req.door.ctx.brief, req.door.ctx));
}));

router.post('/:slug/mcp/:token/apps', handle(async (req, res) => {
  readSpec(req);
  const { screen, check } = await mcp.create(req.door.ctx, req.door.viewerId, req.body);
  res.status(201).json({
    saved: true,
    id: screen.id,
    status: 'draft',
    openUrl: appUrl(req.params.slug, screen.id),
    next: 'Give the person openUrl. It is a draft only they can see; they press "Save to Apps" there to share it with their organisation.',
    kpis: check.kpis,
  });
}));

router.post('/:slug/mcp/:token/apps/:id', handle(async (req, res) => {
  const { screen, check } = await mcp.update(req.door.ctx, req.door.viewerId, req.params.id, req.body || {});
  res.json({
    saved: true,
    id: screen.id,
    status: screen.status === 'active' ? 'published' : 'draft',
    openUrl: appUrl(req.params.slug, screen.id),
    ...(check ? { kpis: check.kpis } : {}),
  });
}));

// ── lifecycle — the builder's own buttons, same rules ───────────────────────

router.post('/:slug/mcp/:token/apps/:id/publish', handle(async (req, res) => {
  const screen = await mcp.publish(req.door.ctx, req.door.viewerId, req.params.id);
  res.json({
    published: true,
    id: screen.id,
    openUrl: appUrl(req.params.slug, screen.id),
    next: 'It is now on the Apps shelf of everyone in the organisation.',
  });
}));

router.post('/:slug/mcp/:token/apps/:id/unpublish', handle(async (req, res) => {
  const screen = await mcp.unpublish(req.door.ctx, req.door.viewerId, req.params.id);
  res.json({
    published: false,
    id: screen.id,
    status: 'draft',
    openUrl: appUrl(req.params.slug, screen.id),
    next: 'It is an editable draft again and off colleagues\' shelves. Change it, then publish again — or the person can restore the published version from the app page.',
  });
}));

const removeHandler = handle(async (req, res) => {
  res.json(await mcp.remove(req.door.ctx, req.door.viewerId, req.params.id));
});
router.delete('/:slug/mcp/:token/apps/:id', removeHandler);
router.post('/:slug/mcp/:token/apps/:id/delete', removeHandler);

module.exports = router;
