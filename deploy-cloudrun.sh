#!/bin/bash

# Cloud Run Deployment Script for Aspect Agent Server
# This script builds and deploys your Node.js server to Google Cloud Run

set -e  # Exit on error

# Configuration
PROJECT_ID="aspect-agents"
SERVICE_NAME="aspect-agent-server"
REGION="europe-west1"
CLOUD_SQL_INSTANCE="aspect-agents:europe-west1:aspect-agents-db"

# Load environment variables from .env.production
if [ ! -f .env.production ]; then
  echo "❌ Error: .env.production file not found!"
  exit 1
fi

echo "🚀 Deploying to Cloud Run..."
echo "   Project: $PROJECT_ID"
echo "   Service: $SERVICE_NAME"
echo "   Region: $REGION"

# Set the active project
gcloud config set project $PROJECT_ID

# Generate a YAML env vars file from .env.production
# This handles JSON values and special characters correctly
ENV_YAML_FILE=$(mktemp /tmp/env-vars-XXXXXX.yaml)
trap "rm -f $ENV_YAML_FILE" EXIT

while IFS= read -r line; do
  # Skip comments and empty lines
  line=$(echo "$line" | tr -d '\r')
  [[ -z "$line" || "$line" =~ ^# ]] && continue

  key="${line%%=*}"
  value="${line#*=}"

  # Quote the value to handle JSON, spaces, and special characters
  echo "$key: '$value'" >> "$ENV_YAML_FILE"
done < .env.production

echo "   Environment variables loaded from .env.production"

# Build and deploy to Cloud Run
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
  --set-cloudsql-instances $CLOUD_SQL_INSTANCE \
  --env-vars-file "$ENV_YAML_FILE"

echo ""
echo "✅ Deployment complete!"
echo "🌐 Your service URL will be shown above"
echo ""
echo "📝 To set additional secrets securely, use:"
echo "   gcloud run services update $SERVICE_NAME --region $REGION --update-secrets=SECRET_NAME=SECRET_NAME:latest"
