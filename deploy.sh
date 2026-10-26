#!/bin/bash

# Unified Cloud Run Deployment Script
# Usage: ./deploy.sh <target>
#   ./deploy.sh aspect   — deploy to aspect-agents project
#   ./deploy.sh freeda   — deploy to menopause-bot project
#   ./deploy.sh staging  — deploy to lybi-staging (Lybi's own project, Tel Aviv; task #913)

set -e

TARGET="${1}"

if [ -z "$TARGET" ]; then
  echo "Usage: ./deploy.sh <aspect|freeda|staging>"
  exit 1
fi

# ── Target configuration ───────────────────────────────────────────────────
# Defaults = production sizing. A target overrides only what differs.

REGION="europe-west1"
SERVICE_ACCOUNT=""         # empty = Cloud Run's default identity
MIN_INSTANCES=1
MAX_INSTANCES=3
CPU=2
MEMORY=4Gi

case "$TARGET" in
  aspect)
    PROJECT_ID="aspect-agents"
    SERVICE_NAME="aspect-agent-server"
    CLOUD_SQL_INSTANCES="aspect-agents:europe-west1:aspect-agents-db,aspect-agents:europe-west1:aspect-data-db"
    ENV_FILE=".env.production.aspect"
    ;;
  freeda)
    PROJECT_ID="menopause-bot"
    SERVICE_NAME="freeda-agent-server"
    CLOUD_SQL_INSTANCES="menopause-bot:me-west1:lybi-db,aspect-agents:europe-west1:aspect-agents-db"
    ENV_FILE=".env.production.freeda"
    ;;
  staging)
    # Lybi staging: everything in Tel Aviv, same machine size as production
    # (so load tests compare), but scales to zero when nobody uses it.
    PROJECT_ID="lybi-staging"
    SERVICE_NAME="lybi-server"
    REGION="me-west1"
    CLOUD_SQL_INSTANCES="lybi-staging:me-west1:lybi-staging-db"
    ENV_FILE=".env.production.staging"
    MIN_INSTANCES=0
    # Its own identity: only Cloud SQL client + logs/metrics/traces. The org does
    # not grant the default compute account anything automatically.
    SERVICE_ACCOUNT="lybi-server@lybi-staging.iam.gserviceaccount.com"
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Available targets: aspect, freeda, staging"
    exit 1
    ;;
esac

# ── Load environment variables ─────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found!"
  exit 1
fi

echo "Deploying to Cloud Run..."
echo "   Target:    $TARGET"
echo "   Project:   $PROJECT_ID"
echo "   Service:   $SERVICE_NAME"
echo "   Region:    $REGION"
echo "   Cloud SQL: $CLOUD_SQL_INSTANCES"
echo "   Env file:  $ENV_FILE"
echo ""

# Origin's targets (aspect, freeda) keep the old behaviour (set the active
# project). Every Lybi environment (staging, lybi-<customer>, …) names its
# project per command, so the active gcloud project and account — what the
# origin deploys rely on — are never changed.
if [ "$TARGET" = "aspect" ] || [ "$TARGET" = "freeda" ]; then
  gcloud config set project $PROJECT_ID
  PROJECT_FLAG=""
else
  PROJECT_FLAG="--project=$PROJECT_ID"
fi

# Generate a YAML env vars file
ENV_YAML_FILE=$(mktemp /tmp/env-vars-XXXXXX.yaml)
trap "rm -f $ENV_YAML_FILE" EXIT

while IFS= read -r line; do
  line=$(echo "$line" | tr -d '\r')
  [[ -z "$line" || "$line" =~ ^# ]] && continue

  key="${line%%=*}"
  value="${line#*=}"

  echo "$key: '$value'" >> "$ENV_YAML_FILE"
done < "$ENV_FILE"

echo "   Environment variables loaded from $ENV_FILE"

# ── Deploy ─────────────────────────────────────────────────────────────────

gcloud run deploy $SERVICE_NAME \
  $PROJECT_FLAG \
  --source . \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --min-instances $MIN_INSTANCES \
  --max-instances $MAX_INSTANCES \
  --cpu $CPU \
  --memory $MEMORY \
  --timeout 3600 \
  --no-cpu-throttling \
  --set-cloudsql-instances $CLOUD_SQL_INSTANCES \
  --env-vars-file "$ENV_YAML_FILE" \
  ${SERVICE_ACCOUNT:+--service-account=$SERVICE_ACCOUNT}

echo ""
echo "Deployment complete! ($TARGET)"
