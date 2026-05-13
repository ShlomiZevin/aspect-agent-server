# Task: Finalize GCP Migration — Lybi Stack on `menopause-bot` (a.k.a. "Freeda AI")

## ⚠️ Hard Constraints — Read First

1. **DO NOT touch the current `freeda-2b4af` Firebase project.** It lives under Shlomi's boostart Google account and currently serves `lybi.ai` in production. Stays untouched indefinitely. (It can remain there forever or be retired later — separate decision.)
2. **DO NOT change `lybi.ai` DNS.** It keeps pointing at `freeda-2b4af`. Cutover to the new stack is a SEPARATE future task.
3. The new stack runs **in parallel** on a different Google account (the lybi account, GCP project `menopause-bot` / "Freeda AI") and a brand-new Firebase project. No customer-facing change until the future DNS cutover.

## Naming Clarification

There was confusion earlier about a project called "freeda-ai" vs "menopause-bot". They are **the same project**:

- **Project ID:** `menopause-bot` (this is what code and `gcloud` use)
- **Display name:** "Freeda AI" (what you see in the GCP console UI)

The codebase correctly references the project ID `menopause-bot` — **no code sweep is needed**.

## The Layout

| Project / Resource | Google account | Purpose | Touched? |
|---|---|---|---|
| `freeda-2b4af` Firebase | boostart (Shlomi's personal) | Current Lybi web client — serves `lybi.ai` today | **No** |
| `menopause-bot` GCP project (display: "Freeda AI") | lybi (org) | Target home for Cloud Run + Cloud SQL `lybi-db`. Per Shlomi, `freeda-agent-server` and `lybi-db` already exist here | **Yes — verify + deploy** |
| New `lybi-prod` Firebase project | lybi (org) | New production client, eventually `lybi.ai` after future cutover | **Yes — create + deploy** |

## What's Already Done (per Shlomi)

- GCP project `menopause-bot` (display: "Freeda AI", under the lybi account) has a Cloud Run service `freeda-agent-server`.
- Cloud SQL instance `lybi-db` exists on `menopause-bot`.
- Server code has dual-DB wiring (`PLATFORM_DB_HOST`/`USER`/`PASSWORD`) for the shared platform tasks DB so the task board keeps working across server instances.
- [`deploy.sh`](../../deploy.sh), [`.env.production.freeda`](../../.env.production.freeda), and [`scripts/cloud-sql/migrate-db-to-lybi.sh`](../../scripts/cloud-sql/migrate-db-to-lybi.sh) already target `menopause-bot` — correct.

## What's Left

### 1. Verify in GCP Console

- Confirm `menopause-bot` ("Freeda AI") has a live `freeda-agent-server` Cloud Run service and `lybi-db` Cloud SQL instance.
- Confirm the region matches what's in [`deploy.sh:29`](../../deploy.sh#L29) (`me-west1`).

### 2. Create the New Firebase Project Under the Lybi Google Account

Brand-new, separate from `freeda-2b4af`:

- `lybi-prod` (display: "Lybi Production")

(Staging Firebase is out of scope for this round — prod only.)

### 3. Wire `lybi-prod` Into the Client Repo

[`aspect-react-client/.firebaserc`](../../../aspect-react-client/.firebaserc) currently has a `freeda` alias pointing at `freeda-2b4af`. Replace that alias with `lybi-prod` pointing at the new Firebase project. Keep `default` as-is so existing flows aren't affected.

In [`aspect-react-client/package.json`](../../../aspect-react-client/package.json), add a `deploy:lybi-prod` script following the existing pattern (`vite build --mode lybi-prod && firebase use lybi-prod && firebase deploy --only hosting`).

Create `.env.lybi-prod` with `VITE_API_URL=<freeda-agent-server prod URL on menopause-bot>`.

### 4. Migrate Operational DB — Schema Only

The Aspect customer data DB (gigabytes) is irrelevant here — it's not part of this migration.

Migrate the operational DB (`agents_platform_db`) into `lybi-db`, **schema only**. No row data carried over:

<code>pg_dump --schema-only --no-owner --no-privileges -h 127.0.0.1 -p 5432 -U agent_admin -d agents_platform_db > operational-schema.sql</code>

Then against `lybi-db`:

<code>psql -h 127.0.0.1 -p 5433 -U agent_admin -d agents_platform_db < operational-schema.sql</code>

The existing `migrate-db-to-lybi.sh` does a full `gcloud sql export sql` — that's not what we want here. Either adapt it for schema-only or run the commands above manually.

After schema import, run any per-row bootstrap migrations (e.g. seeding an `agents` row for Lybi, default assignees Shlomi/Kosta). `db/migrations/` handles most of this.

### 5. KB / Storage — Skip Entirely

The new env uses Lybi's own OpenAI/Anthropic/Gemini accounts. Any existing KB vector stores and uploaded GCS files belong to other API accounts and **cannot be reached** by the new server.

- Do **not** migrate `knowledge_bases` / `knowledge_base_files` rows.
- Do **not** copy any GCS bucket files.
- New env boots with empty KB tables. KBs can be re-uploaded later if needed.

### 6. Deploy the Server

<code>cd aspect-agent-server && ./deploy.sh freeda</code>

Verify:

- Cloud Run service starts on `menopause-bot`.
- Basic chat round-trip works.
- Tasks tool works (the cross-project platform DB connection is unchanged and should still authenticate via the existing IAM grants).

### 7. Deploy the New Client

<code>cd aspect-react-client && npm run deploy:lybi-prod</code>

End-to-end test on the new Firebase `*.web.app` URL.

### 8. Do NOT Cut Over `lybi.ai` DNS

`lybi.ai` continues pointing at `freeda-2b4af` under the boostart account until a separate, future cutover task.

## Acceptance Criteria

- [ ] `menopause-bot` ("Freeda AI") confirmed as canonical and has Cloud Run + `lybi-db`
- [ ] `lybi-prod` Firebase project exists under the lybi Google account, Hosting enabled
- [ ] `.firebaserc` + `package.json` + `.env.lybi-prod` updated in `aspect-react-client`
- [ ] `lybi-db` has operational schema (no data, no KB tables populated)
- [ ] `./deploy.sh freeda` deploys cleanly to `menopause-bot`
- [ ] Health check + chat round-trip pass on new Cloud Run URL
- [ ] Tasks tool works on new server (platform DB connection OK)
- [ ] New `lybi-prod` client live on Firebase and talks to the new server
- [ ] `lybi.ai` and `freeda-2b4af` Firebase site **verified unchanged**

## Assignee: Kosta
