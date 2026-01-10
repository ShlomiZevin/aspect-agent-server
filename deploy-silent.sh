#!/bin/bash

# Silent deployment - deploys without promoting and keeps previous versions running
# Usage: ./deploy-silent.sh [version-id]
# If no version-id is provided, one will be auto-generated

echo "🔇 Silent Deployment to App Engine..."
echo "   (No promotion, previous versions will keep running)"
echo ""

# Check if version ID is provided
if [ -z "$1" ]; then
  # Auto-generate version ID based on timestamp
  VERSION_ID="v$(date +%Y%m%d-%H%M%S)"
  echo "📝 No version ID provided, auto-generating: $VERSION_ID"
else
  VERSION_ID="$1"
  echo "📝 Using provided version ID: $VERSION_ID"
fi

echo ""
echo "🚀 Deploying to App Engine..."
echo "   Version: $VERSION_ID"
echo "   Promote: NO"
echo "   Stop previous: NO"
echo ""

# Deploy with --no-promote and --no-stop-previous-version
# gcloud app deploy --version=general-flex-1 --no-promote --no-stop-previous-version
gcloud app deploy --version="$VERSION_ID" --no-promote --no-stop-previous-version

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Silent deployment successful!"
  echo "📦 Version deployed: $VERSION_ID"
  echo "🔗 Version URL: https://$VERSION_ID-dot-aspect-agents.oa.r.appspot.com"
  echo ""
  echo "💡 To promote this version to receive traffic:"
  echo "   gcloud app services set-traffic default --splits $VERSION_ID=1"
  echo ""
  echo "💡 To view all versions:"
  echo "   gcloud app versions list"
else
  echo ""
  echo "❌ Deployment failed!"
  exit 1
fi
