# Lybi staging — deploy log

The recipe for standing up a Lybi environment (staging now; `lybi-prod` and
`lybi-<customer>` later). Written while doing it: every step, who did it, what
went wrong. Task #913. Guide for the human part: `lybi-google-cloud-setup.html`.

## Where things live

| Thing | Value |
|---|---|
| Google company account (Workspace) | primary domain **freeda.ai**, lybi.ai is a secondary domain (customer `C02k6b61v`). Changing the primary domain is Noa/Hila's call — not done. |
| Cloud organization | `909142814999` — displays as "freeda.ai" (follows the primary domain). We change nothing at org level. |
| Lybi identity | `shlomi@lybi.ai` (super admin side); `shlomi@boostart.io` keeps access |
| Billing account | **Lybi** `017787-4464F3-55E08C` (under the org). Admins: shlomi@lybi.ai, shlomi@boostart.io |
| Project | `lybi-staging` ("Lybi Staging"), in the org, billed to Lybi |
| Region | `me-west1` (Tel Aviv) for everything |

Org policies that matter (read 2026-10-25): outside domains **allowed**; any
location **allowed**; service-account key download **disabled** (we never need
a key file — Cloud Run uses its own identity).

## Steps

### 1. Identity and billing — Shlomi (browser; cannot be scripted)
1. `gcloud auth login shlomi@lybi.ai` on the deploy machine (browser sign-in).
   `shlomi@boostart.io` stays the default gcloud account — existing deploys unaffected.
2. Cloud console as shlomi@lybi.ai → accept terms (country Israel).
3. Billing → Add billing account → company card. **Gotcha:** it is created as
   "My Billing Account" — renamed below.

### 2. Project — Claude (CLI as shlomi@lybi.ai)
```bash
# rename the billing account — not in gcloud (GA or beta); the Billing API does it:
curl -X PATCH "https://cloudbilling.googleapis.com/v1/billingAccounts/$BILL?updateMask=displayName" \
  -H "Authorization: Bearer $(gcloud auth print-access-token shlomi@lybi.ai)" -d '{"displayName":"Lybi"}'
gcloud projects create lybi-staging --name="Lybi Staging" --organization=909142814999 --account=shlomi@lybi.ai
gcloud billing projects link lybi-staging --billing-account=$BILL --account=shlomi@lybi.ai
```

### 3. Access for shlomi@boostart.io
- **Gotcha:** `roles/owner` for an outside domain fails with
  `ORG_MUST_INVITE_EXTERNAL_OWNERS` — owners from outside must be invited and
  accept by email. Used instead (no invite needed):
  `roles/editor`, `roles/resourcemanager.projectIamAdmin`, `roles/iam.serviceAccountUser`.
- Billing admin: `billingAccounts/$BILL:getIamPolicy` is a **GET** (POST returns an
  HTML 404) → add `roles/billing.admin` for both accounts → `setIamPolicy`.

### 4. Services (APIs)
```bash
gcloud services enable run sqladmin cloudbuild artifactregistry cloudscheduler iam \
  cloudresourcemanager firebase firebasehosting billingbudgets generativelanguage apikeys serviceusage \
  --project=lybi-staging   # (each as <name>.googleapis.com)
```

### 5. Budget
- **Gotcha:** the Lybi billing account is in **ILS** — a USD budget fails with a bare
  `INVALID_ARGUMENT`. Read `currencyCode` from `GET billingAccounts/$BILL` first.
```bash
gcloud billing budgets create --billing-account=$BILL --display-name="Lybi monthly" \
  --budget-amount=750ILS --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 --billing-project=lybi-staging
```
Alerts go to the billing admins.

### 6. Database — Cloud SQL
```bash
gcloud sql instances create lybi-staging-db --project=lybi-staging \
  --database-version=POSTGRES_15 --edition=ENTERPRISE --tier=db-g1-small \
  --region=me-west1 --storage-type=SSD --storage-size=10GB --storage-auto-increase \
  --backup-start-time=01:00 --availability-type=zonal
```
Same version and size as production (`aspect-agents-db`: POSTGRES_15, db-g1-small →
max_connections 50). `--edition=ENTERPRISE` is required for the shared-core tier.

### 7. Gemini key — no human needed
```bash
gcloud services api-keys create --project=lybi-staging \
  --display-name="Lybi staging - Gemini" --api-target=service=generativelanguage.googleapis.com
gcloud services api-keys get-key-string <uid>   # straight into the env file, never printed
```

### 8. Server settings — `.env.production.staging` (git-ignored)
Built from `.env.production.aspect` by a script that never prints values:
- **kept:** Gmail, Pinecone, Leonardo, Google sign-in client, model names, pool size
- **new:** database (`/cloudsql/lybi-staging:me-west1:lybi-staging-db`, user `lybi_app`,
  generated password), Gemini key, `GCP_BILLING_ACCOUNT_ID`, `LYBI_APP_URL`
- **pending:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (new Lybi keys)
- **dropped:** WhatsApp, Notion, Aspect data reloads, billing-dashboard admin keys,
  OpenAI Assistants ids, the Aspect KB bucket

### 9. Firebase — the client's home
```bash
firebase projects:addfirebase lybi-staging   # → site lybi-staging, https://lybi-staging.web.app
```

### 10. Code wiring
- `deploy.sh`: new target `staging` (project lybi-staging, service `lybi-server`,
  region me-west1, min instances 0, otherwise production sizing). It passes
  `--project` per command — it never changes the active gcloud project/account
  the other targets rely on. `aspect` and `freeda` are unchanged.
- `server.js` CORS allowlist: `https://lybi-staging.web.app`, `…firebaseapp.com`.
- Client: `.firebaserc` alias `staging → lybi-staging`; `.env.staging`
  (`VITE_API_URL=https://lybi-server-700084613835.me-west1.run.app` — Cloud Run
  URLs are predictable: `<service>-<project number>.<region>.run.app`);
  `npm run deploy:staging` uses `--project staging` (no `firebase use`).
- Production's scheduler: one job `data-loader-tick`, every minute,
  `POST /api/admin/scheduler/tick`, Asia/Jerusalem — staging gets the same.

### 11. Database structure — copy from production, no data
**Tools:** PostgreSQL client binaries (`pg_dump`, `psql`), plain zip from EnterpriseDB,
only `pgsql/bin/*` unpacked to `C:\tools\pgsql` — no installer, nothing system-wide:
```bash
curl -L -o pg17.zip https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip
unzip -q pg17.zip 'pgsql/bin/*' -d /c/tools/ && rm pg17.zip
```

**Reaching production's database:** by IP. **Gotcha:** this machine's IP rotates
(two exit IPs at once) — a timeout means it fell off the allow-list. Fix (Shlomi's
permission, append-only, keeps every existing entry):
```bash
cd scripts/cloud-sql && ./authorize-ip.sh                 # aspect-agents-db (the script's default)
./authorize-ip.sh aspect-data-db                          # the default does NOT cover this one
```

**Dump only the `public` schema.** Production's platform DB also has `zer4u`
(Aspect data tables + helper functions) and an empty `agents` schema — not Lybi.
```bash
pg_dump --schema-only --no-owner --no-privileges --schema=public -f prod-schema-public.sql   # PGHOST… from .env
# pg_dump 17 → Postgres 15: drop the PG17-only SET; the new DB already has schema public
grep -vE "^(SET transaction_timeout|CREATE SCHEMA public;|ALTER SCHEMA public OWNER)" prod-schema-public.sql > lybi-schema.sql
```

**Load into staging as the app user** (so it owns every table — no grants needed):
```bash
gcloud sql databases create agents_platform_db --instance=lybi-staging-db --project=lybi-staging
gcloud sql users create lybi_app --instance=lybi-staging-db --project=lybi-staging --password=<from env file>
gcloud sql instances patch lybi-staging-db --project=lybi-staging --authorized-networks=<this machine's IPs>
PGHOST=<staging IP> PGUSER=lybi_app PGSSLMODE=require psql -v ON_ERROR_STOP=1 -q -f lybi-schema.sql
```
Result 2026-10-25: **76 tables, 220 indexes (incl. primary keys / uniques), 0 rows.**

### 12. First server deploy
```bash
CLOUDSDK_CORE_DISABLE_PROMPTS=1 ./deploy.sh staging
```
**Gotcha — failed first time:** `<number>-compute@developer.gserviceaccount.com does
not have storage.objects.get`. The org does not give Google's default compute
account any role automatically (secure-by-default), so the build robot can't read
the uploaded source. Fix, done properly:
```bash
# build: the default compute account gets exactly the Cloud Run builder role
gcloud projects add-iam-policy-binding lybi-staging \
  --member=serviceAccount:<number>-compute@developer.gserviceaccount.com --role=roles/run.builder
# runtime: the server gets its OWN identity with only what it needs
gcloud iam service-accounts create lybi-server --project=lybi-staging
#   wait ~15 s — a brand-new service account "does not exist" for a moment
for r in cloudsql.client logging.logWriter monitoring.metricWriter cloudtrace.agent; do
  gcloud projects add-iam-policy-binding lybi-staging \
    --member=serviceAccount:lybi-server@lybi-staging.iam.gserviceaccount.com --role=roles/$r
done
```
`deploy.sh` staging target: `SERVICE_ACCOUNT=lybi-server@lybi-staging.iam.gserviceaccount.com`
(passed as `--service-account`; other targets keep Cloud Run's default identity).

Second deploy: built and serving at `https://lybi-server-700084613835.me-west1.run.app`.
**Gotcha:** "Setting IAM policy failed" — making the service public needs
`run.services.setIamPolicy`, which an *editor* (shlomi@boostart.io) does not have.
Done as the project's owner:
```bash
gcloud run services add-iam-policy-binding lybi-server --region=me-west1 --project=lybi-staging \
  --member=allUsers --role=roles/run.invoker --account=shlomi@lybi.ai
```
Later fix so every deploy runs clean: give the deploying account `roles/run.admin`
on the project (done as the owner) — editors can deploy but not set service IAM, so
each deploy repeated the warning (harmless: the public binding persists across
revisions).

Checks: `/health` 200 (0.47 s); `/api/load-tests?agentSlug=x` → `{"loadTests":[]}`
(reaches its own DB). Startup log: DB connected; one harmless line —
`[taskboard] could not seed people: database "aspect_tasks_db" does not exist`
(the Aspect task board's DB; not part of Lybi staging).

### 13. Scheduler — created PAUSED
```bash
gcloud scheduler jobs create http scheduler-tick --project=lybi-staging --location=me-west1 \
  --schedule="* * * * *" --time-zone=Asia/Jerusalem --http-method=POST \
  --uri=https://lybi-server-700084613835.me-west1.run.app/api/admin/scheduler/tick \
  --headers=Content-Type=application/json --message-body='{}' --attempt-deadline=60s
gcloud scheduler jobs pause scheduler-tick --project=lybi-staging --location=me-west1
```
**Cost decision (Shlomi):** a per-minute tick keeps a scale-to-zero server awake 24/7
(~$110–120/month at production size). Paused until triggers need testing.

### Model keys — OpenAI
One OpenAI project **Lybi**, one API key per environment (`lybi-staging`, later
`lybi-prod`, `lybi-<customer>`). Cost per environment = usage grouped by API key.
The key alone is enough (project-scoped); `OPENAI_ORG_ID`/`OPENAI_PROJECT_ID` are
only read by the billing dashboard.

Changing a key on a running server — no rebuild:
```bash
# same YAML deploy.sh builds from the env file; --env-vars-file REPLACES all vars
gcloud run services update lybi-server --region=me-west1 --project=lybi-staging --env-vars-file=<yaml>
```

### 14. Client deploy
```bash
npm run deploy:staging        # → https://lybi-staging.web.app
```
Checks: the bundle references only `lybi-server-700084613835.me-west1.run.app`
(24×, no production URL); CORS preflight from `https://lybi-staging.web.app` → 204
with the origin allowed; home + `/builder` load with no errors on the empty DB
("No agents yet") — no bootstrap rows needed for the Builder.

### 15. End-to-end check (2026-10-25)
| Check | Result |
|---|---|
| Create an agent in the Builder (`staging-check`) | ✅ |
| A turn with the default Talker (`gemini-2.5-flash`) | ❌ — see finding 1 |
| The same turn on `gpt-5.6-terra` | ✅ 2.7 s, reply saved |
| Error center caught the Gemini failure (area model · stream · talker) | ✅ |
| Load test, 2 at once, through the public address | ✅ "as fast as one alone, no errors", turns 1.0–2.8 s, $0.015 |
| Server vitals during the run | CPU ≤14%, 206 MB, **DB pool ≤1/5 in use, 0 waiting** |

**Finding 1 — default Gemini model is closed to new accounts.** Google: "models/gemini-2.5-flash
is no longer available to new users … use models/gemini-3.8-flash". Every new
environment gets fresh keys → every new agent's default Talker fails there.
Production works only because its Gemini account is old. **Decided (Shlomi): the
default is GPT** — `gpt-5.6-terra` (the platform's EVERYDAY_MODEL) in
`builder/addons/talker.addon.json`, `DEFAULT_BALANCED_MODEL` (client
`registry/providerModels.ts`), the seeded Talker in `addonLibrary.ts` and the
legacy-draft migration in `draftStorage.ts`. Existing agents keep their saved
model. The model list marks gemini-2.5-flash as closed to new accounts.

**Finding 2 — the DB pool pressure seen locally was distance.** Next to its DB,
10-at-once-class load keeps the pool nearly idle (≤1 of 5 at 2 at once). Measure
before changing `DB_POOL_MAX`.

**Finding 3 — the first estimate of a fresh agent is low** (it averages the agent's few
turns so far, here including a failed one): $0.0035 estimated, $0.015 spent. The cap
still holds (it stops on real spend); later runs use the last load test's real cost.

### Model keys — Anthropic
One console account (Lybi's), the **Default** workspace, one key per environment
(`lybi-staging`, …). **Gotchas:**
- The key is linked to the person who creates it ("deactivated if you leave the
  organization") — fine for staging; production wants a non-personal account.
- A new account has **no credit**: every call fails with "credit balance is too low"
  until billing is set up (Settings → Billing → card + credits / auto-reload).
- Check every Claude id in `models.service.js` against `GET /v1/models` with the new
  key. 2026-10-25: all offered except `claude-haiku-4-5`, listed only as
  `claude-haiku-4-5-20251001` (alias check pending the credit).

### Sign-in — what each kind is, and the per-environment Google client
- **Lybi's customer sign-in = name + phone** at `/:agent/go` (users created in the
  agent's Admin → Users; `POST /api/auth/login`). Needs nothing per environment.
- **Google sign-in** (`GOOGLE_OAUTH_CLIENT_ID`, the "Sign-In" module) guards the
  *Aspect* screens (dashboard, Intelligence, chat widget) — not Lybi's Builder chat.
  The client id reaches the browser through `GET /api/auth/signin/config`, so
  changing it is a server setting only.
- Each environment still gets its OWN Google client (done for staging):
  1. Firebase → Authentication → Get started → Sign-in method → Google → Enable
     (public name Lybi, support shlomi@lybi.ai) → Web SDK configuration → **Web client ID**.
  2. Cloud console → Credentials → "Web client (auto created by Google Service)" →
     Authorized JavaScript origins → add `https://<site>.web.app` (**Firebase adds
     only `…firebaseapp.com` and localhost**) → Save.
  3. Google Auth Platform → Audience → must be **In production**, External (it was).
  These three are console-only — no command or API — so a human clicks them.

### 17. Copy an agent's setup from production — skill `copy-agent`
How-to lives in the skill (`.claude/skills/copy-agent/SKILL.md`):
```bash
node scripts/copy-agent-to-env.js <slug> --from prod --to staging --dry
node scripts/copy-agent-to-env.js <slug> --from prod --to staging [--replace]
```
Environments are named in `scripts/environments.json` — **a new environment adds an
entry there** (DB public IP, credentials file, API/site URLs, isProduction).
Copies the **setup**: folders (+ parents), project, agent, all agent versions,
all crews + crew versions, KB links + their `library_files` records, the change
history, the legacy `agents` row. Not data (conversations, messages, runs,
memory, customer users, feedback). Builder text ids kept; auto-numbered tables
get fresh ids. Refuses to copy an agent that already exists on the target.

2026-10-25, Noa's agent (found as the only Builder agent active in the last day:
76 conversations / 543 user messages): **`account-opening`** — 2 folders, 1 project,
5 agent versions, 11 crews, 51 crew versions, 2 KB links (namespace
`account-opening-kb`), 4 file records, 2 history entries. Proof: the project as
loaded through production's API and staging's API is **identical**.
Its add-ons use gpt-5.6, gpt-5.6-luna, gpt-5.5, gpt-4o-mini and **claude-sonnet-4-6 (13)**
— the Claude ones need the Anthropic credit on the new account.

### Keys — what staging actually runs with (verified from the live service)
Fingerprints of the env on Cloud Run vs production's files: OpenAI, Anthropic, Gemini
are **staging's own** (match nothing in production); Pinecone, Leonardo and Gmail are
**shared on purpose**. No admin keys. Staging's `provider_config` holds no key
overrides (only the daily simulation counter).

**Pinecone — decided: keep Shlomi's account.** It has no card (free plan → no cost),
and a Lybi account would mean re-uploading every knowledge base. Staging reads the
same index/namespaces, so copied agents keep their knowledge.

### 16. Still open
- **Anthropic credit** (Shlomi) — the key is in, calls fail until billing is set up.
- ~~Google sign-in, Lybi's own~~ — done: staging serves its own client
  `700084613835-20k7…` (see "Sign-in" above).
- **Google Cloud free trial:** the Lybi billing account runs on the trial (₪921,
  until 2027-01-24) — upgrade to paid so staging never pauses (credit carries over).
- **Scheduler:** paused by decision.

### 17. The Builder MCP knows the environments (2026-10-25)
- `builder/environments.js` lists them: **Origin** (`aspect-agents`, lybi.ai — the first
  environment, every agent so far, the task board) and **Lybi Staging**. The door's entry
  page opens with "which environment you are on" and the others; `/builder/mcp/environments`
  returns it as JSON. Which one = the request's host, no setting needed (`LYBI_ENV` overrides).
- **Gotcha:** `lybi-staging.web.app/builder/mcp` goes to **Origin** — the staging site
  deploys lybi.ai's `firebase.json`, whose `/builder/mcp` redirect names Origin's server.
  Staging's door is the server's own address:
  `https://lybi-server-700084613835.me-west1.run.app/builder/mcp`. The Builder's
  "Connect my AI" now hands out that address on staging (`MCP_URL` follows `VITE_API_URL`).
- New environment → one entry in `environments.js` (BUILDER_MCP_MAINTENANCE §3.10).
