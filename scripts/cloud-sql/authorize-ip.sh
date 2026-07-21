#!/bin/bash

###############################################################################
# Authorize IP Address Script
#
# Adds your public IP(s) to Cloud SQL authorized networks.
#
# Usage:
#   ./authorize-ip.sh                          # auto-detect IPs, default instance
#   ./authorize-ip.sh -a                       # auto-detect IPs, ALL instances in the project
#   ./authorize-ip.sh -i 77.137.64.21          # use explicit IP
#   ./authorize-ip.sh -i 77.137.64.21 myinst   # explicit IP + instance
#   ./authorize-ip.sh myinst                   # explicit instance, auto-detect IPs
#
# Auto-detection queries THREE services and authorizes EVERY distinct
# IPv4 they return. Rationale: some ISPs / routers egress different
# connections via different public IPs (split routing) — detection
# services can each see a different one, and the DB connection may use
# yet another of them. Authorizing the union covers all of them.
#
# Tip: your machine likely talks to TWO instances (operational
# aspect-agents-db + data aspect-data-db) — use -a to fix both at once.
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

is_ipv4() { echo "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }

# Parse args (supports -i/--ip, -a/--all, plus positional instance name)
EXPLICIT_IP=""
ALL_INSTANCES=false
POSITIONAL_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        -i|--ip)
            EXPLICIT_IP="$2"
            shift 2
            ;;
        -a|--all)
            ALL_INSTANCES=true
            shift
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

# ── Resolve the IP LIST to authorize ─────────────────────────────────
IPS_TO_ADD=()
if [ -n "$EXPLICIT_IP" ]; then
    if ! is_ipv4 "$EXPLICIT_IP"; then
        print_error "Invalid IPv4 address: $EXPLICIT_IP"
        exit 1
    fi
    IPS_TO_ADD=("$EXPLICIT_IP")
    print_success "Using explicit IP: $EXPLICIT_IP"
else
    print_info "Detecting public IP from multiple sources..."
    IPIFY_IP=$(curl -s --max-time 5 -4 https://api.ipify.org || echo "")
    ICANHAZ_IP=$(curl -s --max-time 5 -4 https://ipv4.icanhazip.com | tr -d '[:space:]' || echo "")
    IFCONFIG_IP=$(curl -s --max-time 5 -4 https://ifconfig.me/ip || echo "")

    print_info "  api.ipify.org:        ${IPIFY_IP:-<failed>}"
    print_info "  ipv4.icanhazip.com:   ${ICANHAZ_IP:-<failed>}"
    print_info "  ifconfig.me:          ${IFCONFIG_IP:-<failed>}"

    # Union of every distinct valid IPv4 the services returned. When
    # they disagree (split routing / dual WAN) we authorize ALL of
    # them — the DB connection may egress via any.
    for ip in "$IPIFY_IP" "$ICANHAZ_IP" "$IFCONFIG_IP"; do
        if is_ipv4 "$ip" && ! printf '%s\n' "${IPS_TO_ADD[@]}" | grep -qx "$ip"; then
            IPS_TO_ADD+=("$ip")
        fi
    done

    if [ ${#IPS_TO_ADD[@]} -eq 0 ]; then
        print_error "Failed to detect a public IPv4 from any service"
        print_info "Run again with: ./authorize-ip.sh -i <your-ip>"
        exit 1
    fi

    if [ ${#IPS_TO_ADD[@]} -gt 1 ]; then
        print_warning "Detection services disagree — your connection uses more than one egress IP."
        print_warning "Authorizing ALL of them: ${IPS_TO_ADD[*]}"
    else
        print_success "Detected IP: ${IPS_TO_ADD[0]}"
    fi
fi

# ── Resolve the INSTANCE LIST to patch ───────────────────────────────
INSTANCES=()
if [ "$ALL_INSTANCES" = true ]; then
    print_info "Listing every Cloud SQL instance in the active project..."
    # tr -d '\r' — on Windows (git-bash) gcloud emits CRLF line endings;
    # a trailing \r makes the instance name invalid for the API.
    while IFS= read -r name; do
        [ -n "$name" ] && INSTANCES+=("$name")
    done < <(gcloud sql instances list --format="value(name)" | tr -d '\r')
    if [ ${#INSTANCES[@]} -eq 0 ]; then
        print_error "No Cloud SQL instances found in the active gcloud project"
        exit 1
    fi
    print_info "Instances: ${INSTANCES[*]}"
else
    INSTANCE_NAME="${POSITIONAL_ARGS[0]:-$CLOUD_SQL_INSTANCE_NAME}"
    if [ -z "$INSTANCE_NAME" ]; then
        print_error "Instance name not provided"
        print_info "Usage: ./authorize-ip.sh [-i <ip>] [-a|--all] [instance-name]"
        exit 1
    fi
    INSTANCES=("$INSTANCE_NAME")
fi

# ── Patch each instance (append-only) ────────────────────────────────
for INSTANCE in "${INSTANCES[@]}"; do
    echo ""
    print_info "── Instance: $INSTANCE ──"
    EXISTING_IPS=$(gcloud sql instances describe "$INSTANCE" \
        --format="value(settings.ipConfiguration.authorizedNetworks[].value)" \
        | tr ';' ',' | tr -d '[:space:]')

    MISSING=()
    for ip in "${IPS_TO_ADD[@]}"; do
        if ! echo ",$EXISTING_IPS," | grep -q ",$ip,"; then
            MISSING+=("$ip")
        fi
    done

    if [ ${#MISSING[@]} -eq 0 ]; then
        print_success "All detected IPs already authorized on $INSTANCE — nothing to do"
        continue
    fi

    NEW_IPS="$EXISTING_IPS"
    for ip in "${MISSING[@]}"; do
        if [ -z "$NEW_IPS" ]; then NEW_IPS="$ip"; else NEW_IPS="$NEW_IPS,$ip"; fi
    done

    print_info "Existing: ${EXISTING_IPS:-<none>}"
    print_info "Adding:   ${MISSING[*]}"

    gcloud sql instances patch "$INSTANCE" \
        --authorized-networks="$NEW_IPS" \
        --quiet

    print_success "Authorized on $INSTANCE"
done

echo ""
print_success "Done."
print_warning "Note: these IPs remain authorized until removed"
print_info "To clear an instance: gcloud sql instances patch <instance> --clear-authorized-networks"
