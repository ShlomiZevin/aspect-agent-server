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
 * Anything else (a laptop, a tunnel) is reported as a local server.
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
  },
];

const BOARD_ENV = 'origin';

/** The environment a request reached, or null for a local/unknown server. */
function currentEnvironment(origin) {
  const forced = ENVIRONMENTS.find(e => e.id === process.env.LYBI_ENV);
  if (forced) return forced;
  let host = '';
  try { host = new URL(origin).host; } catch { /* no origin */ }
  return ENVIRONMENTS.find(e => e.hosts.includes(host)) || null;
}

/** The entry page's section: which environment this is, and the others. */
function environmentsSection(origin) {
  const here = currentEnvironment(origin);
  const board = ENVIRONMENTS.find(e => e.id === BOARD_ENV);
  const rows = ENVIRONMENTS.map(e =>
    `| ${e.id === here?.id ? `**${e.name}** ← you are here` : e.name} | ${e.what} | \`${e.mcp}\` | ${e.app} |`).join('\n');
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
  environment's Builder MCP page and use its addresses. Bringing an agent
  over (read it from one, create it on the other) is possible, but only
  when the person asks for it.
- **The task board lives only on ${board.name}.** For tasks, use
  ${board.name}'s addresses (\`${board.mcp}/tasks\`…) whichever
  environment you are building on.
- \`GET <Builder MCP>/environments\` returns this list as JSON.
`;
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

module.exports = { ENVIRONMENTS, currentEnvironment, environmentsSection, environmentsJson };
