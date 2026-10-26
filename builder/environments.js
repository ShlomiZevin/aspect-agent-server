/**
 * Lybi's environments — the separate installations of the platform, each
 * with its own server, database and Builder.
 *
 * The Builder MCP (`/builder/mcp`) reads this so an outside assistant
 * knows which environment it is talking to and that others exist: agents,
 * conversations, versions and knowledge bases live in ONE environment and
 * never cross on their own. Without it, an assistant pointed at staging
 * would say "there is no such agent" about an agent that lives on Origin.
 *
 * ── The names ──────────────────────────────────────────────────────
 *
 *   origin   The first installation: Boostart's Google Cloud project
 *            `aspect-agents`. Everything built before Lybi had its own
 *            cloud lives here — every agent so far, lybi.ai, the LYBI
 *            task board. Called Origin because it came first, not
 *            because it is going away.
 *   staging  `lybi-staging`, the first environment on Lybi's own cloud
 *            (task #913). Started empty on 2026-10-25.
 *
 * A new environment (lybi-prod, lybi-<customer>) is one more entry here.
 *
 * ── Which one am I ─────────────────────────────────────────────────
 *
 * `LYBI_ENV` (an id below) wins when set. Otherwise the address the
 * request came in on is matched against each entry's hosts, which works
 * with no setting at all — the Cloud Run hostname is fixed per project.
 * Without a request (Alfred's brief), Cloud Run's own `K_SERVICE` names
 * the service. Anything else (a laptop, a tunnel) is a local server.
 *
 * ── Origin is frozen (2026-10-26) ──────────────────────────────────
 *
 * Shlomi: no more deploys to Origin. Its server keeps running exactly as
 * it is — agents, conversations and the LYBI task board all work — but
 * it gets no new features, so its own Builder MCP page is an older
 * version that does not know about the other environments.
 */

const ENVIRONMENTS = [
  {
    id: 'origin',
    name: 'Origin',
    what: 'The first environment (Boostart\'s Google Cloud, Belgium). Every agent built so far, all their conversations, and the LYBI task board live here.',
    app: 'https://lybi.ai',
    mcp: 'https://lybi.ai/builder/mcp',
    server: 'https://aspect-agent-server-1018338671074.europe-west1.run.app',
    hosts: ['lybi.ai', 'aspect-agent-server-1018338671074.europe-west1.run.app'],
    service: 'aspect-agent-server',
    frozen: true,
  },
  {
    id: 'staging',
    name: 'Lybi Staging',
    what: 'The first environment on Lybi\'s own cloud (Tel Aviv), opened 2026-10-25. Starts empty — agents from Origin are not here unless someone brought them over.',
    app: 'https://lybi-staging.web.app',
    // The server's own address. lybi-staging.web.app/builder/mcp is NOT it:
    // that site shares lybi.ai's hosting config, whose /builder/mcp
    // redirect points at Origin's server.
    mcp: 'https://lybi-server-700084613835.me-west1.run.app/builder/mcp',
    server: 'https://lybi-server-700084613835.me-west1.run.app',
    hosts: ['lybi-staging.web.app', 'lybi-staging.firebaseapp.com', 'lybi-server-700084613835.me-west1.run.app'],
    service: 'lybi-server',
  },
];

const BOARD_ENV = 'origin';

/** The environment a request reached, or null for a local/unknown server. */
function currentEnvironment(origin) {
  const forced = ENVIRONMENTS.find(e => e.id === process.env.LYBI_ENV);
  if (forced) return forced;
  let host = '';
  try { host = new URL(origin).host; } catch { /* no origin */ }
  return ENVIRONMENTS.find(e => e.hosts.includes(host))
    || (origin ? null : ENVIRONMENTS.find(e => e.service && e.service === process.env.K_SERVICE))
    || null;
}

const frozenNote = e => (e.frozen
  ? ' **Frozen since 2026-10-26** — no new features are deployed there; it keeps running as it is.'
  : '');

/** The entry page's section: which environment this is, and the others. */
function environmentsSection(origin) {
  const here = currentEnvironment(origin);
  const board = ENVIRONMENTS.find(e => e.id === BOARD_ENV);
  const rows = ENVIRONMENTS.map(e =>
    `| ${e.id === here?.id ? `**${e.name}** ← you are here` : e.name} | ${e.what}${frozenNote(e)} | \`${e.mcp}\` | ${e.app} |`).join('\n');
  const frozen = ENVIRONMENTS.filter(e => e.frozen && e.id !== here?.id);
  const aboutFrozen = frozen.map(e => `- **Talking about ${e.name} from here is normal.** Its server is frozen, not
  gone: read its agents, versions and conversations through its Builder
  MCP (\`${e.mcp}\` + \`/agents\`, \`/agents/<slug>\`,
  \`/conversations/<id>\`…) and compare them with this environment freely.
  Its own entry page is an OLDER version of this one (no environments, no
  "Max output", an older model list) — for how the platform works, trust
  THIS page. A change you post there lands on ${e.name}'s agents, which
  run the older code — say so before writing there.
`).join('');
  const youAre = here
    ? `You are on **${here.name}**.`
    : `You are on **a local server** (${origin}) — not one of the environments below. It has its own database.`;
  return `## Environments — which Lybi you are on

Lybi runs as separate environments. Each has its own server, database and
Builder. ${youAre}

| Environment | What it is | Builder MCP | Builder app |
|---|---|---|---|
${rows}

What this means for you:

- **Everything on this page acts on this environment only.** Agents,
  versions, conversations, simulations and knowledge bases are separate
  per environment and nothing copies between them on its own. The same
  slug in two environments is two different agents.
- **The person may mean another environment.** If they name an agent
  that is not in this environment's list, read the other environment's
  agent list (its Builder MCP above + \`/agents\`) before saying it does
  not exist, and tell them where you found it.
- **Say which environment** whenever you report on an agent or change
  one ("saved on Lybi Staging"). When it is not clear which one they
  mean, ask — a change on the wrong environment is a change nobody sees.
- **Work in another environment by switching URLs**: read that
  environment's Builder MCP page and use its addresses.
- **Never copy an agent between environments yourself.** Re-creating it
  through these addresses loses its crews, versions and knowledge links
  and gives new ids. Copies are made by Shlomi with a copy tool that moves
  everything exactly — when the person needs an agent here (or a fresh
  copy of one), tell them to ask Shlomi.
${aboutFrozen}- **The task board lives only on ${board.name}.** For tasks, use
  ${board.name}'s addresses (\`${board.mcp}/tasks\`…) whichever
  environment you are building on.
- \`GET <Builder MCP>/environments\` returns this list as JSON.
`;
}

/**
 * For Alfred (no request at hand): which environment this server is and
 * the others, in his words. Alfred's tools read only this environment.
 */
function environmentsBrief() {
  const here = currentEnvironment(null);
  const lines = ENVIRONMENTS.map(e =>
    `- ${e.name}${e.id === here?.id ? ' (THIS one — where you run)' : ''}: ${e.what}${frozenNote(e).replace(/\*\*/g, '')} Builder: ${e.app}`);
  return [
    '# Environments — which Lybi this is',
    'Lybi runs as separate environments, each with its own server, database',
    'and Builder. Agents, versions, conversations and knowledge bases never',
    'cross between them on their own; the same slug in two environments is',
    'two different agents.',
    ...lines,
    ...(here ? [] : ['- You are running on a local / unknown server, not one of the above.']),
    '- Your tools (list_agents, read_agent, conversations…) see ONLY the',
    '  environment you run on. If the person asks about an agent you cannot',
    '  find, it may live in the other environment — say so instead of',
    '  "it doesn\'t exist", and point them to that environment\'s Builder.',
    '- Copying an agent from one environment to another is done by Shlomi',
    '  (a copy tool that moves every crew, version and KB link exactly) —',
    '  not by you and not by their connected AI. When someone wants a new',
    '  feature on an agent that lives on a frozen environment, tell them to',
    '  ask Shlomi for a copy (or a refresh, if a copy already exists).',
  ].join('\n');
}

/** The list as data, for `/builder/mcp/environments`. */
function environmentsJson(origin) {
  const here = currentEnvironment(origin);
  return {
    current: here ? here.id : 'local',
    board: BOARD_ENV,
    environments: ENVIRONMENTS.map(({ hosts, ...e }) => ({ ...e, current: e.id === here?.id })),
  };
}

module.exports = { ENVIRONMENTS, currentEnvironment, environmentsSection, environmentsJson, environmentsBrief };
