---
name: deploy
description: How to deploy Lybi / Aspect — which command goes where, which keys and database each environment runs with, and the checks before and after. Use whenever someone says deploy, release, ship, push to staging / origin / production / lybi.ai, "put it on staging", "deploy the server / the client", or asks which keys or database an environment uses.
---

# Deploy

**Names:** "origin" = the existing environment (lybi.ai, Noa, customers). There is no
separate Lybi production yet. "staging" = Lybi's new environment in Tel Aviv.

**Never deploy unless Shlomi says so, in this conversation, for this environment.**
"Deploy to staging" is not permission for origin. No git push comes with a deploy.

## The environments

| | **Origin** (the existing environment — not a real "production") | Staging |
|---|---|---|
| Who uses it | Noa, customers, lybi.ai | Testing before origin |
| Site | https://lybi.ai | https://lybi-staging.web.app |
| **Server command** | `./deploy.sh aspect` | `CLOUDSDK_CORE_DISABLE_PROMPTS=1 ./deploy.sh staging` |
| Cloud Run | `aspect-agent-server`, project `aspect-agents`, europe-west1 | `lybi-server`, project `lybi-staging`, me-west1 (Tel Aviv) |
| Server settings + keys from | `aspect-agent-server/.env.production.aspect` | `aspect-agent-server/.env.production.staging` |
| Model keys (OpenAI / Anthropic / Gemini) | the **original Boostart keys** (same as local `.env`) | **Lybi staging keys** — only staging has them |
| Database | `aspect-agents-db` (live data) | `lybi-staging-db` (its own, started empty) |
| **Client command** (in `aspect-react-client`) | `npm run deploy:freeda` | `npm run deploy:staging` |
| Firebase project | `freeda-2b4af` (hosts lybi.ai) | `lybi-staging` |
| Client talks to | `.env.freeda` → aspect-agent-server | `.env.staging` → lybi-server |
| Shared by both | Leonardo (the one Lybi key), Gmail. Knowledge bases are NOT shared: each environment's live in its own database (pgvector, #1014) | |

**One override to know:** the `provider_config` table in that environment's database
beats the env file (Admin → API Keys writes there). Checked 2026-10-25: neither
database overrides the shared OpenAI / Anthropic / Gemini keys; origin holds only
per-customer keys for the Aspect agents zolstock and superhist. If someone saves a key
on the API Keys page, that environment runs on it from then on, whatever the env file says.

So, apart from that table: **the env file decides the keys.** `deploy.sh <target>` sends every line of
`.env.production.<target>` to Cloud Run and **replaces** all the service's settings
with them. Origin never sees the staging keys and staging never sees origin's,
as long as nobody copies a key between those two files.

Other targets, not part of Lybi's daily work: `./deploy.sh freeda` (project
`menopause-bot`, `.env.production.freeda` — its own keys), `npm run deploy:aspect`
(Aspect BI site). `npm run deploy:lybi-prod` exists in package.json but has no
`.env.lybi-prod` yet — not a working environment; don't use it.

## gcloud accounts

- The default account stays **shlomi@boostart.io** — origin deploys rely on it.
  Never `gcloud config set account` to something else.
- `./deploy.sh aspect` runs `gcloud config set project aspect-agents` (old behaviour).
- `./deploy.sh staging` passes `--project=lybi-staging` per command and changes
  nothing in gcloud config. boostart.io has the roles it needs there.
- Anything owner-level in lybi-staging (IAM, allUsers) needs `--account=shlomi@lybi.ai`.

## Before deploying

1. Know exactly what goes out: `git status` + `git diff --stat` in both folders.
   A deploy ships the **working folder**, committed or not, including other
   sessions' uncommitted changes — say so if there are any you didn't make.
2. Run the batteries for what changed (server `CLAUDE.md` lists them; Builder runtime:
   `scripts/test-error-center.js`, `test-load-tests.js`, `test-simulation-jobs.js`,
   `test-builder-mcp.js`).
3. Client: `npx tsc --noEmit -p tsconfig.app.json` must be clean (the deploy scripts build
   with vite, which doesn't type-check).
4. **Database migrations first.** A new `db/migrations/NNN_*.sql` must be applied to
   that environment's database *before* the server that needs it is deployed — and
   to staging and production separately.
5. Origin: deploy to staging first and check it there.

## Deploy — server first, then client

```bash
cd aspect-agent-server && CLOUDSDK_CORE_DISABLE_PROMPTS=1 ./deploy.sh staging   # ~4–6 min
cd aspect-react-client && npm run deploy:staging                                  # ~1–2 min
```

Origin is the same with `./deploy.sh aspect` and `npm run deploy:freeda`.

## After deploying — check, don't assume

1. The new revision serves: `gcloud run services describe <service> --region <region>
   --project <project> --format="value(status.latestReadyRevisionName,status.url)"`.
2. Health: `curl <apiUrl>/api/models` returns 200.
3. A real turn on a real agent (staging: `account-opening`) answers.
4. Admin → Errors shows nothing new from the deploy.
5. Report: what went out (revision name), where, and the check results.

## Things that bit us

- `deploy.sh` without `CLOUDSDK_CORE_DISABLE_PROMPTS=1` can stop on an interactive
  prompt for a staging deploy.
- Startup tolerates a dead database — a 200 from the health check doesn't prove the DB
  is up; the real turn does.
- Writing a file inside the server folder at runtime is lost on every deploy (it's baked
  into the image). State goes in Postgres or GCS.
- Staging's scheduler is **paused** on purpose — deploying doesn't start it.
- A new frontend origin must be added to the CORS list in `server.js` before it works.

Full staging build record: `aspect-agent-server/docs/setup/lybi-staging-deploy-log.md`.
Copying an agent between environments: skill `copy-agent`.
