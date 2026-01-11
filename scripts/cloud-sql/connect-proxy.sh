#!/bin/bash

###############################################################################
# Cloud SQL Proxy Connection Script
#
# Starts Cloud SQL Proxy for secure local connections without IP whitelisting
# Recommended for local development
#
# Usage: ./connect-proxy.sh [env-file]
###############################################################################

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}✅${NC} $1"
}

print_error() {
    echo -e "${RED}❌${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Load environment variables
ENV_FILE="${1:-../.env.cloudsql}"

if [ ! -f "$ENV_FILE" ]; then
    print_error "Environment file not found: $ENV_FILE"
    exit 1
fi

print_info "Loading configuration from $ENV_FILE"
source "$ENV_FILE"

if [ -z "$CLOUD_SQL_CONNECTION_NAME" ]; then
    print_error "CLOUD_SQL_CONNECTION_NAME not found in environment file"
    exit 1
fi

# Check if cloud-sql-proxy is installed
if ! command -v cloud-sql-proxy &> /dev/null; then
    print_error "cloud-sql-proxy is not installed"
    print_info "Install it with:"
    print_info "  curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.8.2/cloud-sql-proxy.linux.amd64"
    print_info "  chmod +x cloud-sql-proxy"
    print_info "  sudo mv cloud-sql-proxy /usr/local/bin/"
    print_info ""
    print_info "Or on macOS:"
    print_info "  brew install cloud-sql-proxy"
    exit 1
fi

print_info "=========================================="
print_info "Starting Cloud SQL Proxy"
print_info "=========================================="
print_info "Connection Name: $CLOUD_SQL_CONNECTION_NAME"
print_info "Local Port: ${DB_PORT_PROXY:-5432}"
print_info "=========================================="
print_info ""
print_warning "Press Ctrl+C to stop the proxy"
print_info ""

# Start the proxy
cloud-sql-proxy "$CLOUD_SQL_CONNECTION_NAME" \
    --port="${DB_PORT_PROXY:-5432}" \
    --address="0.0.0.0"
