#!/bin/bash

###############################################################################
# Schema-only Migration: aspect-agents-db -> lybi-db
#
# Dumps the operational DB schema (no data) from aspect-agents and loads it
# into the new lybi-db on menopause-bot. KB tables stay empty by design — the
# new env uses different OpenAI/Anthropic/Gemini accounts and existing
# vector stores are unreachable.
#
# Prerequisites:
#   - cloud-sql-proxy installed and in PATH
#   - gcloud authenticated with Cloud SQL Client on BOTH projects
#     (aspect-agents AND menopause-bot)
#   - psql and pg_dump installed locally (PostgreSQL client tools)
#   - Source DB password (from .env.production.aspect: DB_PASSWORD)
#   - Target DB password (lybi-db agent_admin password)
#
# Usage:
#   export SOURCE_DB_PASSWORD='...'   # from .env.production.aspect
#   export TARGET_DB_PASSWORD='...'   # lybi-db agent_admin
#   ./migrate-schema-to-lybi.sh
###############################################################################

set -e

# ── Configuration ──────────────────────────────────────────────────────────

SOURCE_CONN="aspect-agents:europe-west1:aspect-agents-db"
TARGET_CONN="menopause-bot:me-west1:lybi-db"

# Ports per spec (gcp-migration-finalization.md §4). If local Postgres on 5432
# blocks the source proxy, stop it before running or override SOURCE_PORT here.
SOURCE_PORT=5432
TARGET_PORT=5433

DB_NAME="agents_platform_db"
DB_USER="agent_admin"
DUMP_FILE="operational-schema.sql"

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

# ── Pre-flight ─────────────────────────────────────────────────────────────

if [ -z "$SOURCE_DB_PASSWORD" ] || [ -z "$TARGET_DB_PASSWORD" ]; then
  error "Both SOURCE_DB_PASSWORD and TARGET_DB_PASSWORD must be set."
  info  "  export SOURCE_DB_PASSWORD='...'   # from .env.production.aspect"
  info  "  export TARGET_DB_PASSWORD='...'   # lybi-db agent_admin"
  exit 1
fi

command -v cloud-sql-proxy >/dev/null || { error "cloud-sql-proxy not found in PATH"; exit 1; }
command -v pg_dump >/dev/null         || { error "pg_dump not found in PATH";         exit 1; }
command -v psql >/dev/null            || { error "psql not found in PATH";            exit 1; }

echo ""
info "=========================================="
info "  Schema-only Migration"
info "=========================================="
info "Source: $SOURCE_CONN / $DB_NAME"
info "Target: $TARGET_CONN / $DB_NAME"
info "=========================================="
echo ""

read -p "Proceed? (y/n) " -n 1 -r
echo
[[ ! $REPLY =~ ^[Yy]$ ]] && { error "Cancelled."; exit 1; }

# ── Step 1: Start Cloud SQL Proxies ────────────────────────────────────────

info "Step 1/5 — Starting cloud-sql-proxy on ports $SOURCE_PORT (source) and $TARGET_PORT (target)..."

cloud-sql-proxy "$SOURCE_CONN" --port=$SOURCE_PORT >/tmp/proxy-source.log 2>&1 &
SOURCE_PID=$!

cloud-sql-proxy "$TARGET_CONN" --port=$TARGET_PORT >/tmp/proxy-target.log 2>&1 &
TARGET_PID=$!

cleanup() {
  info "Stopping proxies (PIDs $SOURCE_PID, $TARGET_PID)..."
  kill $SOURCE_PID $TARGET_PID 2>/dev/null || true
}
trap cleanup EXIT

# Wait for both proxies to be ready (poll, don't sleep blindly)
for i in {1..20}; do
  if PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h 127.0.0.1 -p $SOURCE_PORT -U "$DB_USER" -d postgres -c "SELECT 1" >/dev/null 2>&1 \
  && PGPASSWORD="$TARGET_DB_PASSWORD" psql -h 127.0.0.1 -p $TARGET_PORT -U "$DB_USER" -d postgres -c "SELECT 1" >/dev/null 2>&1; then
    success "Both proxies ready."
    break
  fi
  if [ "$i" -eq 20 ]; then
    error "Proxies failed to come up after 20s. Check /tmp/proxy-source.log and /tmp/proxy-target.log"
    exit 1
  fi
  sleep 1
done

# ── Step 2: Ensure target DB exists ────────────────────────────────────────

info "Step 2/5 — Ensuring database '$DB_NAME' exists on target lybi-db..."

DB_EXISTS=$(PGPASSWORD="$TARGET_DB_PASSWORD" psql -h 127.0.0.1 -p $TARGET_PORT -U "$DB_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")

if [ "$DB_EXISTS" = "1" ]; then
  warn "Database '$DB_NAME' already exists on lybi-db."
  read -p "Continue and load schema into existing DB? (y/n) " -n 1 -r
  echo
  [[ ! $REPLY =~ ^[Yy]$ ]] && { error "Cancelled."; exit 1; }
else
  PGPASSWORD="$TARGET_DB_PASSWORD" psql -h 127.0.0.1 -p $TARGET_PORT -U "$DB_USER" -d postgres -c \
    "CREATE DATABASE $DB_NAME"
  success "Created database '$DB_NAME' on lybi-db."
fi

# ── Step 3: Dump source schema ─────────────────────────────────────────────

info "Step 3/5 — Dumping schema from source ($SOURCE_CONN)..."

PGPASSWORD="$SOURCE_DB_PASSWORD" pg_dump \
  --schema-only \
  --no-owner \
  --no-privileges \
  -h 127.0.0.1 -p $SOURCE_PORT -U "$DB_USER" -d "$DB_NAME" \
  > "$DUMP_FILE"

LINES=$(wc -l < "$DUMP_FILE")
success "Schema dumped to $DUMP_FILE ($LINES lines)."

# ── Step 4: Load into target ───────────────────────────────────────────────

info "Step 4/5 — Loading schema into target lybi-db..."

PGPASSWORD="$TARGET_DB_PASSWORD" psql \
  -h 127.0.0.1 -p $TARGET_PORT -U "$DB_USER" -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  < "$DUMP_FILE"

success "Schema loaded."

# ── Step 5: Verify ─────────────────────────────────────────────────────────

info "Step 5/5 — Verifying target..."

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h 127.0.0.1 -p $TARGET_PORT -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='public';"

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h 127.0.0.1 -p $TARGET_PORT -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name LIMIT 20;"

echo ""
info "=========================================="
success "Schema migration complete."
info "=========================================="
info "Next steps (manual):"
info "  - Seed agents row for Freeda (the menopause bot) in lybi-db.agents."
info "  - Seed task_assignees (e.g. Shlomi, Kosta) if task board will be used."
info "  - DO NOT run zer4u/newdeli/thestock/hypertoy data-agent migrations on lybi-db."
info "  - DO NOT copy knowledge_bases / knowledge_base_files rows or GCS files."
info "=========================================="
