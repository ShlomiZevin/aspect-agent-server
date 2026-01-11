#!/bin/bash

###############################################################################
# Authorize IP Address Script
#
# Adds your current public IP to Cloud SQL authorized networks
#
# Usage: ./authorize-ip.sh [instance-name]
###############################################################################

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() { echo -e "${BLUE}ℹ${NC} $1"; }
print_success() { echo -e "${GREEN}✅${NC} $1"; }
print_error() { echo -e "${RED}❌${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }

# Load environment
ENV_FILE="../.env.cloudsql"
if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
fi

INSTANCE_NAME="${1:-$CLOUD_SQL_INSTANCE_NAME}"

if [ -z "$INSTANCE_NAME" ]; then
    print_error "Instance name not provided"
    print_info "Usage: ./authorize-ip.sh [instance-name]"
    exit 1
fi

# Get current public IP
print_info "Detecting your public IP address..."
PUBLIC_IP=$(curl -s https://api.ipify.org)

if [ -z "$PUBLIC_IP" ]; then
    print_error "Failed to detect public IP"
    exit 1
fi

print_success "Your public IP: $PUBLIC_IP"

# Generate a unique network name
NETWORK_NAME="auto-$(echo $PUBLIC_IP | tr '.' '-')-$(date +%s)"

print_info "Adding IP to authorized networks..."
print_info "Instance: $INSTANCE_NAME"
print_info "Network name: $NETWORK_NAME"

# Add IP to authorized networks
gcloud sql instances patch "$INSTANCE_NAME" \
    --authorized-networks="$PUBLIC_IP" \
    --quiet

print_success "IP address authorized successfully!"
print_info ""
print_warning "Note: This IP will remain authorized until you remove it"
print_info "To remove: gcloud sql instances patch $INSTANCE_NAME --clear-authorized-networks"
