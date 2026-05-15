#!/bin/bash

###############################################################################
# Authorize IP Address Script
#
# Adds an IP to Cloud SQL authorized networks.
#
# Usage:
#   ./authorize-ip.sh                          # auto-detect via ipify
#   ./authorize-ip.sh -i 77.137.64.21          # use explicit IP
#   ./authorize-ip.sh -i 77.137.64.21 myinst   # explicit IP + instance
#   ./authorize-ip.sh myinst                   # explicit instance, auto-detect IP
#
# Tip: if your browser shows a different IP than the script detects (VPN,
# split-tunneling, proxy, etc.), pass the browser IP via -i. You can see your
# browser's egress IP at https://api.ipify.org or https://whatismyipaddress.com
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

# Parse args (supports -i/--ip flag plus positional instance name)
EXPLICIT_IP=""
POSITIONAL_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        -i|--ip)
            EXPLICIT_IP="$2"
            shift 2
            ;;
        -h|--help)
            grep -E "^# " "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

# Load environment
ENV_FILE="../.env.cloudsql"
if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
fi

INSTANCE_NAME="${POSITIONAL_ARGS[0]:-$CLOUD_SQL_INSTANCE_NAME}"

if [ -z "$INSTANCE_NAME" ]; then
    print_error "Instance name not provided"
    print_info "Usage: ./authorize-ip.sh [-i <ip>] [instance-name]"
    exit 1
fi

# Resolve IP to authorize
if [ -n "$EXPLICIT_IP" ]; then
    PUBLIC_IP="$EXPLICIT_IP"
    print_success "Using explicit IP: $PUBLIC_IP"
else
    print_info "Detecting public IP from multiple sources..."
    IPIFY_IP=$(curl -s --max-time 5 https://api.ipify.org || echo "")
    ICANHAZ_IP=$(curl -s --max-time 5 -4 https://ipv4.icanhazip.com || echo "")
    IFCONFIG_IP=$(curl -s --max-time 5 -4 https://ifconfig.me/ip || echo "")

    print_info "  api.ipify.org:        ${IPIFY_IP:-<failed>}"
    print_info "  ipv4.icanhazip.com:   ${ICANHAZ_IP:-<failed>}"
    print_info "  ifconfig.me:          ${IFCONFIG_IP:-<failed>}"

    PUBLIC_IP="$IPIFY_IP"
    if [ -z "$PUBLIC_IP" ]; then
        print_error "Failed to detect public IP from any service"
        print_info "Run again with: ./authorize-ip.sh -i <your-ip>"
        exit 1
    fi

    # Warn on disagreement — usually means VPN/split-tunneling/proxy
    if [ -n "$ICANHAZ_IP" ] && [ "$ICANHAZ_IP" != "$PUBLIC_IP" ]; then
        print_warning "Detection services disagree (ipify=$PUBLIC_IP, icanhazip=$ICANHAZ_IP)"
        print_warning "Your browser may see yet a different IP. If connection still fails,"
        print_warning "open https://api.ipify.org in your browser and run:"
        print_warning "  ./authorize-ip.sh -i <ip-shown-in-browser>"
    fi

    print_success "Detected IP: $PUBLIC_IP"
fi

# Basic sanity check on IP format (IPv4)
if ! echo "$PUBLIC_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    print_error "Invalid IPv4 address: $PUBLIC_IP"
    print_info "Cloud SQL authorized networks require an IPv4 address (or CIDR)"
    exit 1
fi

# Fetch existing authorized networks so we APPEND instead of replacing
print_info "Fetching existing authorized networks..."
EXISTING_IPS=$(gcloud sql instances describe "$INSTANCE_NAME" \
    --format="value(settings.ipConfiguration.authorizedNetworks[].value)" \
    | tr ';' ',' | tr -d '[:space:]')

# Skip if already authorized
if echo ",$EXISTING_IPS," | grep -q ",$PUBLIC_IP,"; then
    print_success "IP $PUBLIC_IP is already authorized — nothing to do"
    exit 0
fi

# Build merged list
if [ -z "$EXISTING_IPS" ]; then
    NEW_IPS="$PUBLIC_IP"
else
    NEW_IPS="$EXISTING_IPS,$PUBLIC_IP"
fi

print_info "Adding IP to authorized networks..."
print_info "Instance: $INSTANCE_NAME"
print_info "Existing: ${EXISTING_IPS:-<none>}"
print_info "New list: $NEW_IPS"

gcloud sql instances patch "$INSTANCE_NAME" \
    --authorized-networks="$NEW_IPS" \
    --quiet

print_success "IP address authorized successfully!"
print_info ""
print_warning "Note: This IP will remain authorized until you remove it"
print_info "To remove: gcloud sql instances patch $INSTANCE_NAME --clear-authorized-networks"
