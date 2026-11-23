---
name: new-environment
description: Stand up a whole new Lybi environment on Google Cloud — its own project, database, server, site, model keys — for a customer (lybi-<customer>), a future Lybi production, or another test environment. Use whenever someone says "new environment", "set up an environment for <customer>", "a customer needs their own installation / cloud / server", "spin up another staging", or asks what it takes to give a customer their own Lybi.
---

# New Lybi environment

The recipe that built **staging** on 2026-10-25 (task #913), generalized. Every gotcha
below happened once. The full first-time log with the reasoning:
`aspect-agent-server/docs/setup/lybi-staging-deploy-log.md`.

**Names.** "origin" = the existing environment (lybi.ai, Noa, customers; Boostart's
`aspect-agents`). "staging" = `lybi-staging`. A new one is `<env>`, its Google project
`lybi-<env>` — e.g. env `acme`, project `lybi-acme`. Below: `$P` = project id,
`$N` = project number, `$BILL` = Lybi billing account `017787-4464F3-55E08C`,
`$ORG` = `909142814999`, region `me-west1` (Tel Aviv) unless the customer needs another.

**Ask Shlomi before starting:** the env name · region · machine size (default = origin's:
2 CPU / 4 GiB, DB `db-g1-small`) · whether it may scale to zero (staging: yes) · budget
(staging: ₪750/month) · which agents to copy in. Creating a project costs money from day
one (~₪100+/month for the DB alone) — it's his call.

## Who does what

| Shlomi (browser — no API for these) | Claude (CLI) |
|---|---|
| Once ever: `gcloud auth login shlomi@lybi.ai` on this machine (done 2026-10-25) | Everything else |
| OpenAI: a new key `lybi-<env>` in the **Lybi** project (one project, one key per environment) | |
| Anthropic: a new key `lybi-<env>` in Lybi's console, Default workspace | |
| Google sign-in client: 3 console clicks (step 10) | |
| Make the server public if Claude's account lacks owner (step 8) | |

Keys go straight into the env file. **Never print a key**, never paste one into a
commit, a doc or a task.

## gcloud accounts

`shlomi@boostart.io` stays the **default** account (origin's deploys rely on it) — never
`gcloud config set account`. Owner-level commands pass `--account=shlomi@lybi.ai`; every
command passes `--project=$P`.

## Steps

### 1. Project, billing, access
```bash
gcloud projects create $P --name="Lybi <Env>" --organization=$ORG --account=shlomi@lybi.ai
gcloud billing projects link $P --billing-account=$BILL --account=shlomi@lybi.ai
N=$(gcloud projects describe $P --format='value(projectNumber)')
# shlomi@boostart.io — NOT roles/owner: an outside owner fails with ORG_MUST_INVITE_EXTERNAL_OWNERS
for r in editor resourcemanager.projectIamAdmin iam.serviceAccountUser run.admin; do
  gcloud projects add-iam-policy-binding $P --member=user:shlomi@boostart.io --role=roles/$r --account=shlomi@lybi.ai
done
```

### 2. APIs + budget
```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com \
  cloudresourcemanager.googleapis.com firebase.googleapis.com firebasehosting.googleapis.com \
  billingbudgets.googleapis.com generativelanguage.googleapis.com apikeys.googleapis.com \
  serviceusage.googleapis.com --project=$P
# the billing account is in ILS — a USD amount fails with a bare INVALID_ARGUMENT
gcloud billing budgets create --billing-account=$BILL --display-name="Lybi <env> monthly" \
  --budget-amount=<n>ILS --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 --billing-project=$P
```

### 3. Database
```bash
gcloud sql instances create $P-db --project=$P --database-version=POSTGRES_15 \
  --edition=ENTERPRISE --tier=db-g1-small --region=me-west1 --storage-type=SSD \
  --storage-size=10GB --storage-auto-increase --backup-start-time=01:00 --availability-type=zonal
gcloud sql databases create agents_platform_db --instance=$P-db --project=$P
```
`--edition=ENTERPRISE` is required for the shared-core tier. Same version/size as origin
(`max_connections` 50).

### 4. Gemini key (no human needed)
```bash
gcloud services api-keys create --project=$P --display-name="Lybi <env> - Gemini" \
  --api-target=service=generativelanguage.googleapis.com
GEMINI_KEY=$(gcloud services api-keys get-key-string <uid> --format='value(keyString)')   # never echo it
```

### 5. Server settings file
```bash
cd aspect-agent-server
GEMINI_KEY=… OPENAI_KEY=… ANTHROPIC_KEY=… node scripts/make-env-file.js <env> \
  --project $P --instance $P-db --site https://$P.web.app --billing $BILL
gcloud sql users create lybi_app --instance=$P-db --project=$P --password=<DB_PASSWORD from that file>
```
Writes the git-ignored `.env.production.<env>`; prints only names. Keys not ready yet →
`PENDING`; re-run later with them (password and other keys are kept). Shared with origin
**on purpose**: Gmail, Pinecone (free plan; KBs aren't re-uploaded), Leonardo (the one
Lybi key).

### 6. Database structure — origin's, no data
PostgreSQL client tools are in `C:\tools\pgsql\bin` (unpacked zip, no installer).
```bash
# this machine onto both allow-lists (origin: scripts/cloud-sql/authorize-ip.sh — with Shlomi's OK)
gcloud sql instances patch $P-db --project=$P --authorized-networks=<this machine's IPs>
# origin's public schema only (not zer4u / agents); strip what PG15 rejects
pg_dump --schema-only --no-owner --no-privileges --schema=public -f origin-schema.sql   # PGHOST etc. from .env
grep -vE "^(SET transaction_timeout|CREATE SCHEMA public;|ALTER SCHEMA public OWNER)" origin-schema.sql > env-schema.sql
PGHOST=<new DB public IP> PGUSER=lybi_app PGSSLMODE=require PGDATABASE=agents_platform_db \
  psql -v ON_ERROR_STOP=1 -q -f env-schema.sql
```
Loaded as `lybi_app` so it owns every table (no grants). Staging: 76 tables, 0 rows.
The dump files go in the scratchpad, never the repo. The machine's IP **rotates** —
a timeout means it fell off an allow-list.

### 7. Code wiring (one entry each — copy staging's)
| File | Add |
|---|---|
| `aspect-agent-server/deploy.sh` | a `<env>)` target: PROJECT_ID, SERVICE_NAME `lybi-server`, REGION, CLOUD_SQL_INSTANCES `$P:me-west1:$P-db`, ENV_FILE, MIN_INSTANCES, SERVICE_ACCOUNT `lybi-server@$P.iam.gserviceaccount.com`. Every non-origin target automatically passes `--project` and never touches gcloud config |
| `aspect-agent-server/server.js` | CORS allowlist: `https://$P.web.app`, `https://$P.firebaseapp.com` |
| `aspect-agent-server/builder/environments.js` | the one registry entry: Builder MCP + copy door + copy script (`server`, `app`, `hosts`, `isProduction`, `copyInto`, `db` = public IP + credentialsFrom) — BUILDER_MCP_MAINTENANCE §3.10 |
| `aspect-react-client/.firebaserc` | alias `<env>: $P` |
| `aspect-react-client/.env.<env>` | `VITE_API_URL=https://lybi-server-$N.me-west1.run.app` (predictable: `<service>-<number>.<region>.run.app`) |
| `aspect-react-client/package.json` | `deploy:<env>`: `npm run sync-types && vite build --mode <env> && firebase deploy --only hosting --project <env>` |
| `.claude/skills/deploy/SKILL.md` | a column in the environments table |

### 8. Server identities + first deploy
The org grants Google's default accounts **nothing** — without these the build fails
with `…-compute@developer.gserviceaccount.com does not have storage.objects.get`.
```bash
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$N-compute@developer.gserviceaccount.com --role=roles/run.builder
gcloud iam service-accounts create lybi-server --project=$P
sleep 15   # a brand-new service account "does not exist" for a moment
for r in cloudsql.client logging.logWriter monitoring.metricWriter cloudtrace.agent; do
  gcloud projects add-iam-policy-binding $P --member=serviceAccount:lybi-server@$P.iam.gserviceaccount.com --role=roles/$r
done
CLOUDSDK_CORE_DISABLE_PROMPTS=1 ./deploy.sh <env>
# public access needs run.services.setIamPolicy (owner / run.admin):
gcloud run services add-iam-policy-binding lybi-server --region=me-west1 --project=$P \
  --member=allUsers --role=roles/run.invoker --account=shlomi@lybi.ai
```

### 9. Site
```bash
firebase projects:addfirebase $P      # site $P → https://$P.web.app
cd aspect-react-client && npm run deploy:<env>
```

### 10. Google sign-in client (Shlomi, console only)
Guards the *Aspect* screens; Lybi customers sign in with name + phone and need nothing.
1. Firebase → Authentication → Get started → Google → Enable (name Lybi, support
   shlomi@lybi.ai) → Web SDK configuration → copy the **Web client ID**.
2. Cloud console → Credentials → "Web client (auto created…)" → Authorized JavaScript
   origins → add `https://$P.web.app` (Firebase adds only `firebaseapp.com` + localhost).
3. Google Auth Platform → Audience → **In production**, External.
Then: put the id in `GOOGLE_OAUTH_CLIENT_ID` of the env file and redeploy the server.

### 11. Scheduler — created PAUSED
```bash
gcloud scheduler jobs create http scheduler-tick --project=$P --location=me-west1 \
  --schedule="* * * * *" --time-zone=Asia/Jerusalem --http-method=POST \
  --uri=https://lybi-server-$N.me-west1.run.app/api/admin/scheduler/tick \
  --headers=Content-Type=application/json --message-body='{}' --attempt-deadline=60s
gcloud scheduler jobs pause scheduler-tick --project=$P --location=me-west1
```
A per-minute tick keeps a scale-to-zero server awake 24/7 (~$110–120/month). Resume only
when Shlomi says (triggers / proactive messages need it).

### 12. Agents
Skill `copy-agent`: `node scripts/copy-agent-to-env.js <slug> --from origin --to <env> --dry`,
then without `--dry`. Then check the agent's models against the new keys (below).

### 13. Team list
The Builder MCP checks every person's name (simulations, conversations, tasks) against the
environment's own team list (`task_assignees`), and a new DB starts with only Kosta and Shlomi.
Without the rest, Noa's Codex gets `400 "Noa" is not on the board` (task #946). Copy origin's:
`curl -X POST https://lybi-server-$N.me-west1.run.app/api/assignees -H 'Content-Type: application/json' -d '{"name":"Noa"}'`
— once each for Noa, Hila, Claude.

## Model-key traps on a brand-new account
- **Gemini `gemini-2.5-flash` is closed to new accounts** — any add-on on it fails. The
  default Talker is GPT (`gpt-5.6-terra`) since 2026-10-25 for this reason.
- **Anthropic starts with no credit** — every Claude call fails "credit balance is too
  low" until Shlomi adds billing. The console's usage/cost shows up hours late.
- **Never let the local `.env` leak into a test against the new environment** — its
  `OPENAI_ORG_ID` makes the new key fail with "OpenAI-Organization header should match".
- `provider_config` in the new DB overrides the env file (Admin → API Keys) — it starts
  empty, keep it that way unless asked.

## Done = all of these
| Check | How |
|---|---|
| Server up, on its own DB | `curl https://lybi-server-$N.me-west1.run.app/api/models` → 200; `/api/load-tests?agentSlug=x` → `{"loadTests":[]}` |
| Site talks only to its own server | the built bundle names only `lybi-server-$N…`; CORS preflight from the site → 204 |
| Builder works on the empty DB | `https://$P.web.app/builder` → "No agents yet" |
| A real turn | create a test agent (or copy one) → one turn answers, reply saved |
| Team list complete | `/api/assignees` lists Claude, Hila, Kosta, Noa, Shlomi |
| Errors are caught | Admin → Errors shows nothing unexplained |
| Keys are its own | fingerprints (last 4 chars + hash, never the key) of the live service's OpenAI/Anthropic/Gemini match nothing in origin's files |

Then: log anything new in the deploy log, add the environment to the `deploy` skill, and
tell Shlomi what it costs per month at idle.
