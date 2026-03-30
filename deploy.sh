#!/bin/bash

# Unified Cloud Run Deployment Script
# Usage: ./deploy.sh <target>
#   ./deploy.sh aspect   — deploy to aspect-agents project
#   ./deploy.sh freeda   — deploy to menopause-bot project

set -e

TARGET="${1}"

if [ -z "$TARGET" ]; then
  echo "Usage: ./deploy.sh <aspect|freeda>"
  exit 1
fi

# ── Target configuration ───────────────────────────────────────────────────

case "$TARGET" in
  aspect)
    PROJECT_ID="aspect-agents"
    SERVICE_NAME="aspect-agent-server"
    CLOUD_SQL_INSTANCES="aspect-agents:europe-west1:aspect-agents-db"
    ENV_FILE=".env.production.aspect"
    ;;
  freeda)
    PROJECT_ID="menopause-bot"
    SERVICE_NAME="freeda-agent-server"
    CLOUD_SQL_INSTANCES="menopause-bot:me-west1:lybi-db,aspect-agents:europe-west1:aspect-agents-db"
    ENV_FILE=".env.production.freeda"
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Available targets: aspect, freeda"
    exit 1
    ;;
esac

REGION="europe-west1"

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

# Set the active project
gcloud config set project $PROJECT_ID

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
  --source . \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 3 \
  --cpu 2 \
  --memory 2Gi \
  --timeout 3600 \
  --set-cloudsql-instances $CLOUD_SQL_INSTANCES \
  --env-vars-file "$ENV_YAML_FILE"

echo ""
echo "Deployment complete! ($TARGET)"
