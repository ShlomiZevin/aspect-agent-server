#!/bin/bash

# Deploy to App Engine Flexible Environment
# This environment supports true streaming without buffering

echo "🚀 Deploying to App Engine Flexible Environment..."
echo ""

# Check if version ID is provided
if [ -z "$1" ]; then
  # Auto-generate version ID based on timestamp
  VERSION_ID="flex-v$(date +%Y%m%d-%H%M%S)"
  echo "📝 No version ID provided, auto-generating: $VERSION_ID"
else
  VERSION_ID="$1"
  echo "📝 Using provided version ID: $VERSION_ID"
fi

echo ""
echo "⚠️  NOTE: Flexible environment takes 5-10 minutes to deploy"
echo "   (much slower than Standard, but supports streaming!)"
echo ""
echo "🚀 Deploying to App Engine Flexible..."
echo "   Version: $VERSION_ID"
echo "   Config: app.flexible.yaml"
echo ""

# Deploy using the flexible environment config
gcloud app deploy app.flexible.yaml --version="$VERSION_ID" --no-promote --no-stop-previous-version

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Deployment successful!"
  echo "📦 Version deployed: $VERSION_ID"
  echo "🔗 URL: https://aspect-agents.oa.r.appspot.com"
  echo ""
  echo "💡 To view all versions:"
  echo "   gcloud app versions list"
  echo ""
  echo "💡 To split traffic between versions:"
  echo "   gcloud app services set-traffic default --splits $VERSION_ID=1"
else
  echo ""
  echo "❌ Deployment failed!"
  exit 1
fi
