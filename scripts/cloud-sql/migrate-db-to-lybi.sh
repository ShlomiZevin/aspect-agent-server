#!/bin/bash

###############################################################################
# Database Migration Script: aspect-agents → menopause-bot (lybi)
#
# Migrates the full database from the source Cloud SQL instance to the
# target instance via GCS export/import.
#
# Prerequisites:
#   - gcloud CLI authenticated
#   - Target instance `lybi-db` already created in `menopause-bot` project
#   - Both projects accessible from current gcloud account
#
# Usage: ./migrate-db-to-lybi.sh
###############################################################################

set -e

# ── Configuration ──────────────────────────────────────────────────────────

# Source (aspect-agents)
SOURCE_PROJECT="aspect-agents"
SOURCE_INSTANCE="aspect-agents-db"
SOURCE_DB="agents_platform_db"

# Target (menopause-bot / lybi)
TARGET_PROJECT="menopause-bot"
TARGET_INSTANCE="lybi-db"
TARGET_DB="agents_platform_db"
TARGET_DB_USER="agent_admin"
TARGET_DB_PASSWORD="MUywwyD7Td68PIsPZdPneih41!"

# GCS bucket for the export (will be created in source project if missing)
EXPORT_BUCKET="gs://aspect-db-exports"
EXPORT_FILE="lybi-migration.sql.gz"
EXPORT_PATH="${EXPORT_BUCKET}/${EXPORT_FILE}"

# ── Colors ─────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}ℹ${NC}  $1"; }
success() { echo -e "${GREEN}✅${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $1"; }
error()   { echo -e "${RED}❌${NC} $1"; }

# ── Pre-flight checks ─────────────────────────────────────────────────────

echo ""
info "=========================================="
info "  DB Migration: aspect-agents → lybi"
info "=========================================="
info "Source: ${SOURCE_PROJECT} / ${SOURCE_INSTANCE} / ${SOURCE_DB}"
info "Target: ${TARGET_PROJECT} / ${TARGET_INSTANCE} / ${TARGET_DB}"
info "Export: ${EXPORT_PATH}"
info "=========================================="
echo ""

read -p "Proceed? (y/n) " -n 1 -r
echo
[[ ! $REPLY =~ ^[Yy]$ ]] && { error "Cancelled."; exit 1; }

# ── Step 1: Ensure export bucket exists ────────────────────────────────────

info "Step 1/7 — Ensuring export bucket exists..."
if gsutil ls "$EXPORT_BUCKET" &>/dev/null; then
    info "Bucket already exists."
else
    gsutil mb -p "$SOURCE_PROJECT" -l europe-west1 "$EXPORT_BUCKET"
    success "Created bucket $EXPORT_BUCKET"
fi

# ── Step 2: Export source database to GCS ──────────────────────────────────

info "Step 2/7 — Exporting source database to GCS..."
if gsutil ls "$EXPORT_PATH" &>/dev/null; then
    info "Export file already exists: $EXPORT_PATH — skipping export."
else
    info "This may take a few minutes depending on DB size..."
    gcloud sql export sql "$SOURCE_INSTANCE" "$EXPORT_PATH" \
        --database="$SOURCE_DB" \
        --project="$SOURCE_PROJECT"
    success "Export complete: $EXPORT_PATH"
fi

# ── Step 3: Ensure target database exists ──────────────────────────────────

info "Step 3/7 — Ensuring target database exists..."
if gcloud sql databases list --instance="$TARGET_INSTANCE" --project="$TARGET_PROJECT" 2>/dev/null | grep -q "$TARGET_DB"; then
    info "Database $TARGET_DB already exists on $TARGET_INSTANCE."
else
    gcloud sql databases create "$TARGET_DB" \
        --instance="$TARGET_INSTANCE" \
        --project="$TARGET_PROJECT"
    success "Created database $TARGET_DB on $TARGET_INSTANCE"
fi

# ── Step 4: Ensure target user exists ──────────────────────────────────────

info "Step 4/7 — Ensuring target DB user exists..."
if gcloud sql users list --instance="$TARGET_INSTANCE" --project="$TARGET_PROJECT" 2>/dev/null | grep -q "$TARGET_DB_USER"; then
    info "User $TARGET_DB_USER already exists."
else
    warn "User $TARGET_DB_USER does not exist. Creating..."
    gcloud sql users create "$TARGET_DB_USER" \
        --instance="$TARGET_INSTANCE" \
        --password="$TARGET_DB_PASSWORD" \
        --project="$TARGET_PROJECT"
    success "User $TARGET_DB_USER created."
fi

# ── Step 5: Grant target instance access to export bucket ──────────────────

info "Step 5/7 — Granting target Cloud SQL access to export bucket..."

TARGET_SA=$(gcloud sql instances describe "$TARGET_INSTANCE" \
    --project="$TARGET_PROJECT" \
    --format='value(serviceAccountEmailAddress)')

info "Target service account: $TARGET_SA"

gsutil iam ch "serviceAccount:${TARGET_SA}:objectViewer" "$EXPORT_BUCKET"

success "Granted read access to export bucket."

# ── Step 6: Import into target ─────────────────────────────────────────────

info "Step 6/7 — Importing database into target instance..."
info "This may take a few minutes..."

gcloud sql import sql "$TARGET_INSTANCE" "$EXPORT_PATH" \
    --database="$TARGET_DB" \
    --project="$TARGET_PROJECT"

success "Import complete!"

# ── Step 7: Verify ─────────────────────────────────────────────────────────

info "Step 7/7 — Retrieving target connection info..."

TARGET_CONNECTION=$(gcloud sql instances describe "$TARGET_INSTANCE" \
    --project="$TARGET_PROJECT" \
    --format="value(connectionName)")

TARGET_IP=$(gcloud sql instances describe "$TARGET_INSTANCE" \
    --project="$TARGET_PROJECT" \
    --format="value(ipAddresses[0].ipAddress)")

echo ""
info "=========================================="
success "Migration Complete!"
info "=========================================="
info "Target Instance:   $TARGET_INSTANCE"
info "Target Connection: $TARGET_CONNECTION"
info "Target Public IP:  $TARGET_IP"
info "Database:          $TARGET_DB"
info "User:              $TARGET_DB_USER"
info ""
info "Connection string:"
info "  postgresql://${TARGET_DB_USER}:<password>@${TARGET_IP}:5432/${TARGET_DB}"
info ""
info "Cloud SQL proxy:"
info "  cloud_sql_proxy -instances=${TARGET_CONNECTION}=tcp:5433"
info "  psql -h 127.0.0.1 -p 5433 -U ${TARGET_DB_USER} -d ${TARGET_DB}"
info ""
info "Verify with:"
info "  psql> SELECT count(*) FROM agents;"
info "  psql> SELECT count(*) FROM conversations;"
info "  psql> SELECT count(*) FROM messages;"
info "=========================================="
