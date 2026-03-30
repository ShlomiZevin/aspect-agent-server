# Task: GCP Project Migration — Separate Infrastructure Per Customer

## Background

Everything currently runs under a single GCP project (`aspect-agents`): Cloud Run, Cloud SQL, Cloud Storage, and Firebase Hosting. All agents (Freeda, Lybi/Aspect, Banking, Compass, etc.) share the same server instance, database, and storage bucket. This creates coupling between customers — deployments, outages, and costs are all shared.

We need to split into **separate GCP projects per customer**, each with its own Cloud Run, Cloud SQL, and Cloud Storage. A shared **platform DB** will remain in the original project for cross-project resources (tasks).

### Current State

| Service | Resource | Project | Region |
|---------|----------|---------|--------|
| Cloud Run | `aspect-agent-server` | `aspect-agents` | `europe-west1` |
| Cloud SQL | `aspect-agents-db` (PostgreSQL 15) | `aspect-agents` | `europe-west1` |
| Cloud Storage | `aspect-kb-files` bucket | `aspect-agents` | — |
| Firebase Hosting | `aspect-agents` | `aspect-agents` | — |
| Firebase Hosting | `freeda-2b4af` | `freeda-2b4af` | — |

**Database:** `agents_platform_db` — single DB with all tables for all agents.
**Storage:** `aspect-kb-files` — single bucket, files at `kb-files/{kbId}/...` and `podcast-episodes/...`.
**LLM Keys:** Single set of OpenAI/Anthropic/Gemini keys shared across all agents.

### Target State

```
┌─────────────────────────────────────────────────────┐
│  aspect-agents (Platform / Admin)                    │
│  ├── Cloud SQL: aspect-agents-db (tasks table only)  │
│  └── Admin tools, playground, shared resources       │
└──────────────────────┬──────────────────────────────┘
                       │ (cross-project DB connection)
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌──────────────────┐      ┌──────────────────┐
│  freeda-prod     │      │  lybi-prod       │
│  ├── Cloud Run   │      │  ├── Cloud Run   │
│  ├── Cloud SQL   │      │  ├── Cloud SQL   │
│  ├── Cloud Storage│     │  ├── Cloud Storage│
│  └── Firebase    │      │  └── Firebase    │
│     (freeda-2b4af│      │     (new or      │
│      already exists)    │      aspect-agents)│
└──────────────────┘      └──────────────────┘
```

---

## Phase 1: Create Target GCP Projects

### 1.1 Create Projects
```bash
gcloud projects create freeda-prod --name="Freeda Production"
gcloud projects create lybi-prod --name="Lybi Production"
```

### 1.2 Link Billing
```bash
gcloud billing projects link freeda-prod --billing-account=01FD2D-A3AC57-1B721E
gcloud billing projects link lybi-prod --billing-account=01FD2D-A3AC57-1B721E
```

### 1.3 Enable Required APIs (per project)
```bash
for PROJECT in freeda-prod lybi-prod; do
  gcloud services enable \
    sqladmin.googleapis.com \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    storage.googleapis.com \
    secretmanager.googleapis.com \
    --project=$PROJECT
done
```

---

## Phase 2: Database Migration (Cloud SQL)

### Strategy: Full Clone (no cleanup needed)

Both customer DBs start as a full copy of the current DB. All tables, all data. No need to filter or delete — agents are routed by config, not by DB content.

### 2.1 Provision Cloud SQL in Target Projects

```bash
# Freeda
gcloud sql instances create freeda-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=europe-west1 \
  --storage-size=10GB \
  --backup-start-time=03:00 \
  --project=freeda-prod

# Lybi
gcloud sql instances create lybi-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=europe-west1 \
  --storage-size=10GB \
  --backup-start-time=03:00 \
  --project=lybi-prod
```

### 2.2 Create Database and User (per project)

```bash
for INSTANCE in freeda-db lybi-db; do
  PROJECT=$(echo $INSTANCE | sed 's/-db/-prod/')
  gcloud sql databases create agents_platform_db --instance=$INSTANCE --project=$PROJECT
  gcloud sql users create agent_admin --instance=$INSTANCE --password=<SECURE_PASSWORD> --project=$PROJECT
done
```

### 2.3 Export from Source

```bash
# Create a GCS bucket for the export (Cloud SQL export requires GCS)
gsutil mb -p aspect-agents -l europe-west1 gs://aspect-db-exports

# Export full database
gcloud sql export sql aspect-agents-db gs://aspect-db-exports/full-export.sql \
  --database=agents_platform_db \
  --project=aspect-agents
```

### 2.4 Import into Target Projects

```bash
# Grant target project's Cloud SQL service account access to the export bucket
# (Each Cloud SQL instance has a service account that needs GCS read access)

# Get service account for each target instance
SA_FREEDA=$(gcloud sql instances describe freeda-db --project=freeda-prod --format='value(serviceAccountEmailAddress)')
SA_LYBI=$(gcloud sql instances describe lybi-db --project=lybi-prod --format='value(serviceAccountEmailAddress)')

gsutil iam ch serviceAccount:${SA_FREEDA}:objectViewer gs://aspect-db-exports
gsutil iam ch serviceAccount:${SA_LYBI}:objectViewer gs://aspect-db-exports

# Import
gcloud sql import sql freeda-db gs://aspect-db-exports/full-export.sql \
  --database=agents_platform_db \
  --project=freeda-prod

gcloud sql import sql lybi-db gs://aspect-db-exports/full-export.sql \
  --database=agents_platform_db \
  --project=lybi-prod
```

### 2.5 Verify

```bash
# Connect via proxy and verify table counts match
cloud_sql_proxy -instances=freeda-prod:europe-west1:freeda-db=tcp:5433 &
psql -h 127.0.0.1 -p 5433 -U agent_admin -d agents_platform_db -c "SELECT count(*) FROM agents;"
```

---

## Phase 3: Storage Migration (Cloud Storage)

### 3.1 Create Target Buckets

```bash
gsutil mb -p freeda-prod -l europe-west1 gs://freeda-kb-files
gsutil mb -p lybi-prod -l europe-west1 gs://lybi-kb-files
```

### 3.2 Identify KB IDs per Customer

Query the source DB to find which `knowledge_bases.id` values belong to each agent:

```sql
SELECT kb.id, kb.name, a.name as agent_name
FROM knowledge_bases kb
JOIN agents a ON kb."agentId" = a.id
ORDER BY a.name;
```

### 3.3 Copy Files

```bash
# For each Freeda KB ID:
for KB_ID in <freeda-kb-id-1> <freeda-kb-id-2>; do
  gsutil -m cp -r "gs://aspect-kb-files/kb-files/${KB_ID}/" "gs://freeda-kb-files/kb-files/${KB_ID}/"
done

# For each Lybi/Aspect KB ID:
for KB_ID in <lybi-kb-id-1> <lybi-kb-id-2>; do
  gsutil -m cp -r "gs://aspect-kb-files/kb-files/${KB_ID}/" "gs://lybi-kb-files/kb-files/${KB_ID}/"
done

# Copy podcast episodes if applicable
gsutil -m cp -r gs://aspect-kb-files/podcast-episodes/ gs://freeda-kb-files/podcast-episodes/
```

### 3.4 Service Account for Storage

Each project needs a service account with Storage Admin on its own bucket:

```bash
# Create service account per project
gcloud iam service-accounts create storage-sa \
  --display-name="Storage Service Account" \
  --project=freeda-prod

# Grant bucket access
gsutil iam ch serviceAccount:storage-sa@freeda-prod.iam.gserviceaccount.com:objectAdmin gs://freeda-kb-files
```

---

## Phase 4: Shared Tasks DB (Cross-Project Connection)

### Problem
The tasks table lives in the DB but tasks are shared across all projects. After the split, each project has its own DB and can't see each other's tasks.

### Solution
Keep tasks in the **platform DB** (`aspect-agents` project). Each Cloud Run service connects to **two databases**:
1. Its own DB — for conversations, messages, KB, context, etc.
2. The platform DB — for tasks only

### 4.1 Authorize Cross-Project Cloud SQL Access

Each Cloud Run service needs permission to connect to the platform DB instance:

```bash
# Get the Cloud Run service account for each project
# (default: <PROJECT_NUMBER>-compute@developer.gserviceaccount.com)

# Grant Cloud SQL Client role on the platform project
gcloud projects add-iam-policy-binding aspect-agents \
  --member="serviceAccount:<FREEDA_SA>" \
  --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding aspect-agents \
  --member="serviceAccount:<LYBI_SA>" \
  --role="roles/cloudsql.client"
```

### 4.2 Cloud Run: Multiple Cloud SQL Instances

```bash
gcloud run deploy freeda-agent-server \
  --add-cloudsql-instances=freeda-prod:europe-west1:freeda-db,aspect-agents:europe-west1:aspect-agents-db \
  --project=freeda-prod \
  ...
```

### 4.3 Code Change: Dual DB Connection

Add a second connection pool in the server code:

```js
// db.pg.js — add platform DB connection
const platformPool = new Pool({
  host: process.env.PLATFORM_DB_HOST,  // Unix socket to aspect-agents-db
  database: 'agents_platform_db',
  user: process.env.PLATFORM_DB_USER,
  password: process.env.PLATFORM_DB_PASSWORD,
});
```

Task service queries use `platformPool` instead of the default pool. All other services remain unchanged.

### 4.4 Environment Variables (per customer Cloud Run)

```bash
# Freeda Cloud Run env vars
DB_HOST=/cloudsql/freeda-prod:europe-west1:freeda-db          # Own DB
PLATFORM_DB_HOST=/cloudsql/aspect-agents:europe-west1:aspect-agents-db  # Shared tasks
PLATFORM_DB_USER=task_reader
PLATFORM_DB_PASSWORD=<password>
GCS_BUCKET_NAME=freeda-kb-files
```

---

## Phase 5: Deploy Cloud Run Per Customer

### 5.1 Update deploy-cloudrun.sh (or create per-customer scripts)

Create `deploy-freeda.sh` and `deploy-lybi.sh` that set the right project, instance, and env vars.

Key differences per deployment:

| Config | Freeda | Lybi |
|--------|--------|------|
| `--project` | `freeda-prod` | `lybi-prod` |
| `--add-cloudsql-instances` | `freeda-prod:...:freeda-db,aspect-agents:...:aspect-agents-db` | `lybi-prod:...:lybi-db,aspect-agents:...:aspect-agents-db` |
| `DB_HOST` | `/cloudsql/freeda-prod:europe-west1:freeda-db` | `/cloudsql/lybi-prod:europe-west1:lybi-db` |
| `GCS_BUCKET_NAME` | `freeda-kb-files` | `lybi-kb-files` |
| `PLATFORM_DB_HOST` | `/cloudsql/aspect-agents:europe-west1:aspect-agents-db` | same |

### 5.2 Update Firebase Hosting

Freeda already has `freeda-2b4af`. Update the client `.env.production` for each deploy target:

```bash
# Freeda
VITE_API_URL=https://freeda-agent-server-<hash>.europe-west1.run.app

# Lybi
VITE_API_URL=https://lybi-agent-server-<hash>.europe-west1.run.app
```

### 5.3 Update CORS Origins

Each Cloud Run server should only allow its own Firebase origins:

```js
// Freeda server
const allowedOrigins = [
  'https://freeda-2b4af.web.app',
  'https://freeda-2b4af.firebaseapp.com',
];

// Lybi server
const allowedOrigins = [
  'https://lybi.ai',
  'https://aspect-agents.web.app',
];
```

---

## Phase 6: LLM API Keys (Optional but Recommended)

Separate API keys per customer for cost tracking:

| Provider | Mechanism | How |
|----------|-----------|-----|
| OpenAI | Projects | Create separate OpenAI Projects per customer |
| Anthropic | Workspaces | Create separate Anthropic Workspaces |
| Gemini | Per GCP project | Each project uses its own Gemini API key |

See `LLM_USAGE_AND_BILLING_PLAN.md` for full billing separation plan.

---

## Execution Checklist

| # | Step | Risk | Downtime | Status |
|---|------|------|----------|--------|
| 1 | Create GCP projects (`freeda-prod`, `lybi-prod`) | None | None | ⬜ |
| 2 | Link billing accounts | None | None | ⬜ |
| 3 | Enable APIs in new projects | None | None | ⬜ |
| 4 | Provision Cloud SQL instances | None | None | ⬜ |
| 5 | Export source DB to GCS | None | None | ⬜ |
| 6 | Import DB into both target instances | Low | None | ⬜ |
| 7 | Verify DB data in both targets | None | None | ⬜ |
| 8 | Create GCS buckets per customer | None | None | ⬜ |
| 9 | Copy KB files to customer buckets | None | None | ⬜ |
| 10 | Create platform DB user for tasks (`task_reader`) | None | None | ⬜ |
| 11 | Code change: dual DB connection for tasks | Low | None | ⬜ |
| 12 | Create per-customer deploy scripts | None | None | ⬜ |
| 13 | Deploy Cloud Run to `freeda-prod` | Low | None | ⬜ |
| 14 | Deploy Cloud Run to `lybi-prod` | Low | None | ⬜ |
| 15 | Test end-to-end (chat, KB, tasks) per customer | None | None | ⬜ |
| 16 | Update Firebase client env + redeploy | Low | Brief | ⬜ |
| 17 | Update CORS in each server | Low | None | ⬜ |
| 18 | DNS cutover (if custom domains) | Medium | Brief | ⬜ |
| 19 | Separate LLM API keys (optional) | None | None | ⬜ |
| 20 | Decommission old shared setup | Low | None | ⬜ |

---

## Notes

- **No data cleanup needed** — both customer DBs are full clones. Agents are routed by client config, not DB content.
- **Firebase is already split** — `aspect-agents` and `freeda-2b4af` projects exist.
- **Tasks stay shared** — via cross-project Cloud SQL connection from each Cloud Run to the platform DB.
- **Same codebase** — no need to fork the server code. Just different env vars per deployment.
- **Migrations** — after the split, run Drizzle migrations independently on each DB. The platform DB only needs the tasks-related migration.
