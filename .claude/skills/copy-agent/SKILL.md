---
name: copy-agent
description: Copy a Lybi Builder agent's full setup from one environment to another (production → staging, staging → a customer environment, …) and prove the copy is identical. Use whenever someone asks to copy / move / clone / mirror / "bring" an agent to staging or another environment, refresh a staging copy after the agent changed, or set up a new environment with existing agents — "copy Noa's agent to staging", "put account-opening on staging", "refresh the staging copy".
---

# Copy an agent between environments

Two doors, ONE engine (`aspect-agent-server/builder/services/agentCopy.js`): both read
the source, write the target in one transaction, and verify the result against both
environments' own APIs.

**1. The target's Builder MCP — anyone, no credentials.** The MCP of the environment
you copy INTO reads the source through the source's public Builder API (Origin
included) and writes into its own database. This is the default way:

```
GET  <target MCP>/environments/<from>/agents             the source's agents, marked here / not here
GET  <target MCP>/environments/<from>/agents/<slug>      the plan — changes nothing
POST <target MCP>/environments/<from>/agents/<slug>/copy  { "workspace": "<folder, optional>", "refresh": true? }
```

Staging's MCP: `https://lybi-server-700084613835.me-west1.run.app/builder/mcp`. A copy lands
in the target's `copyInto` folder (staging: the Builder domain "Shlomi") unless
`workspace` names another; a refresh keeps the copy's folder. A copy that has changes
made on the target (versions / crews not on the source, a different published version)
is refreshed only with `"refresh": true` — the 409 lists what would be lost. A
different agent with the slug is never touched. Never into a production environment.

**2. The script — Shlomi's machine, direct DB access** (needed only when an API can't
be used, e.g. the target is production, or to mirror the source's folder chain):

```bash
cd aspect-agent-server
node scripts/copy-agent-to-env.js <slug> --from origin --to staging --dry      # 1. see the plan
node scripts/copy-agent-to-env.js <slug> --from origin --to staging          # 2. copy (new on target)
node scripts/copy-agent-to-env.js <slug> --from origin --to staging --replace  # refresh an existing copy
```

It ends with `VERIFIED — the agent loads identically from <from> and <to>` (exit 0)
or `NOT IDENTICAL` (exit 1). Report that line, the per-crew ✓ list, and the link it
prints (`<site>/<slug>/builder`). `--workspace <id>` puts it in a target folder instead
of mirroring the source's.

Through the API the copy carries what the Builder sees: the KB links and file records
(rows under an old Pinecone index name are folded into the one library, like
migration 075 did), the newest 100
change-history entries, and no legacy `agents` row (the runtime makes it on the first
chat). The script carries the raw rows.

## Environments

`aspect-agent-server/builder/environments.js` — the ONE registry (the MCP, Alfred, the
Builder and the script read it): `id`, `server` (API), `app` (site), `isProduction`,
`copyInto` (default folder for copies into it) and `db` (public IP + which git-ignored
env file holds the credentials — script only, never served).
**A new environment = add an entry there.** No secrets in that file.

## What is copied — and what is not

| Copied (the setup) | Not copied (data) |
|---|---|
| The agent's folder and its parent folders, the project | Conversations, messages, add-on runs |
| The agent and **every** agent version (active / viewing / published pointers as they are) | Memory / fields of conversations |
| Every crew and **every** crew version | Customer users (Admin → Users) |
| Knowledge-base links + their file records (`library_files`) | Feedback, trigger runtime state, error-center rows |
| The change history (`agent_log`) | |
| The legacy `agents` row conversations hang off (only if the target has none) | |

Builder rows keep their text ids, so versions, crews and links line up exactly.
Auto-numbered tables get fresh ids on the target.

**Knowledge bases (since #1014, 2026-11-27):** each environment keeps its KB vectors in
its OWN database (pgvector, table `kb_vectors`). The copy carries every chunk of every
KB the agent is linked to, with its embedding (`kbVectors` in the plan — nothing
re-uploaded or re-embedded; chunks the target already has are kept). The target needs
migration 075. A source that keeps no vectors in its database (Origin, which predates
pgvector) copies links and file records only, and the plan says so — bring its chunks
with `node scripts/kb-copy-from-pinecone.js --env <target> --namespace <ns>` while the
Pinecone key still works.

## Rules

1. **Always `--dry` first** and read the plan back (counts per part).
2. **The source is only read.** The target is all-or-nothing: on any error it rolls
   back and says "the target is unchanged".
3. **Already on the target?** It refuses. `--replace` refreshes the setup — the target's
   own conversations stay. It refuses to replace a *different* agent that happens to
   have the same slug.
4. **Into production: ask Shlomi first.** Writing into an environment marked
   `isProduction` needs `--yes-production`; never pass it on your own.
5. **The script: this machine must reach both databases by IP.** A timeout = this machine's IP
   rotated off an allow-list. Origin: `scripts/cloud-sql/authorize-ip.sh` (it
   appends, never removes; run it again with `aspect-data-db` for the data DB) —
   only with Shlomi's OK. Staging: `gcloud sql instances patch <instance>
   --project=<project> --authorized-networks=<ips>`.
6. **No commit / deploy** comes with a copy — it changes only the target database.

## After copying — check the models

The script verifies the setup, not that it can *run*. A new environment has new
model keys, and new accounts don't get every model:

- `gemini-2.5-flash` is **closed to new Gemini accounts** — any add-on on it fails there.
- A new Anthropic account has **no credit** until billing is set up — every Claude add-on fails.
- Check the models the agent's add-ons use (the hydrated project from
  `<apiUrl>/api/builder/projects?agentSlug=<slug>&ownerUserId=x`) against what the
  target's keys can use, and tell Shlomi which add-ons will fail. **Do not change the
  agent's models to make it run** — the copy must stay identical; that's his call.

## Finding "the agent someone works with"

When the slug isn't known, rank Builder agents by recent activity on the source:

```sql
select a.url_slug, count(distinct m.conversation_id) conversations,
       count(*) filter (where m.role='user') user_msgs, max(m.created_at) last_msg
from messages m join conversations c on c.id=m.conversation_id join agents a on a.id=c.agent_id
join builder_agents ba on ba.slug=a.url_slug
where m.created_at > now() - interval '24 hours'
group by a.url_slug order by user_msgs desc limit 10;
```

## History

- 2026-10-25 — first copy: Noa's `account-opening` (11 crews, 51 crew versions,
  2 KB links) production → `lybi-staging`; verified identical, then refreshed with
  `--replace` and verified again. Full environment build: 
  `aspect-agent-server/docs/setup/lybi-staging-deploy-log.md` (task #913).
