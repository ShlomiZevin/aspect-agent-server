# DEV Environment

> Mirror of production. Deployed the same way as prod (Cloud Run + Cloud SQL + Firebase Hosting).
> Purpose: run all agents and test workability without touching live data.

## Components

### 1. Backend — Cloud Run
- Service: `aspect-agent-server-dev`
- `cpu 2 / mem 2Gi / min-instances 0 / max-instances 1 / timeout 3600 / region europe-west1`
- env from `.env.dev`
- Cost: ~$0–3/mo (min-instances 0 → idle ≈ $0)

### 2. DB main — Cloud SQL
- Instance: `aspect-agents-db-dev`
- `db-g1-small` / 10Gb SSD / no HA
- Cost: ~$25–30/mo

### 3. DB data — Cloud SQL
- Instance: `aspect-data-db-dev`
- `db-g1-small` / 10Gb SSD / no HA
- Cost: ~$25–30/mo

### 4. Frontend — Firebase Hosting
- Site: `aspect-agents-dev.web.app`
- `VITE_API_URL` → dev Cloud Run URL
- Cost: ~$0 (free tier)

## Deployment
- Backend: `gcloud run deploy aspect-agent-server-dev` — same script as prod, with:
  - service name `aspect-agent-server-dev`
  - `--min-instances 0`
  - dev Cloud SQL instances in `--set-cloudsql-instances`
  - env from `.env.dev`
- Frontend: `firebase deploy --only hosting` to the dev site
- Branch mapping: `dev` -> dev, `main` -> prod

## Total cost
~$50–60/mo — Cloud SQL only. Cloud Run ≈ $0 at min-instances 0, frontend ≈ $0.
