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

# Read .env.production and create --set-env-vars argument
# This will read all KEY=VALUE pairs and format them for gcloud
# Remove carriage returns (\r) for Windows compatibility
ENV_VARS=$(grep -v '^#' .env.production | grep -v '^$' | tr -d '\r' | xargs | tr ' ' ',')

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
  --set-env-vars "$ENV_VARS"

echo ""
echo "✅ Deployment complete!"
echo "🌐 Your service URL will be shown above"
echo ""
echo "📝 To set additional secrets securely, use:"
echo "   gcloud run services update $SERVICE_NAME --region $REGION --update-secrets=SECRET_NAME=SECRET_NAME:latest"
