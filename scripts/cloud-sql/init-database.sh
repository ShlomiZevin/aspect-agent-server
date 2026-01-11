#!/bin/bash

###############################################################################
# Database Initialization Script
#
# Initializes the agents platform database with a test table to verify
# connection and basic functionality.
#
# Usage: ./init-database.sh [env-file]
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

# Load environment variables
ENV_FILE="${1:-../.env.cloudsql}"

if [ ! -f "$ENV_FILE" ]; then
    print_error "Environment file not found: $ENV_FILE"
    print_info "Run provision-cloudsql.sh first to create the environment file"
    exit 1
fi

print_info "Loading configuration from $ENV_FILE"
source "$ENV_FILE"

# Check if required variables are set
if [ -z "$DB_HOST" ] || [ -z "$DB_NAME" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ]; then
    print_error "Missing required environment variables"
    exit 1
fi

print_info "=========================================="
print_info "Database Initialization"
print_info "=========================================="
print_info "Host: $DB_HOST"
print_info "Database: $DB_NAME"
print_info "User: $DB_USER"
print_info "=========================================="

# Create SQL script for initialization
SQL_SCRIPT=$(cat <<'EOF'
-- Create a test table to verify connection
DROP TABLE IF EXISTS connection_test;

CREATE TABLE connection_test (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert a test record
INSERT INTO connection_test (message)
VALUES ('Database connection successful!');

-- Create schema for future multi-agent platform tables
CREATE SCHEMA IF NOT EXISTS agents;

COMMENT ON SCHEMA agents IS 'Schema for multi-agent platform data';

-- Grant permissions
GRANT USAGE ON SCHEMA agents TO CURRENT_USER;
GRANT CREATE ON SCHEMA agents TO CURRENT_USER;

-- Display confirmation
SELECT
    'Database initialized successfully!' as status,
    COUNT(*) as test_records
FROM connection_test;
EOF
)

# Execute SQL script
print_info "Executing initialization script..."

export PGPASSWORD="$DB_PASSWORD"

echo "$SQL_SCRIPT" | psql \
    -h "$DB_HOST" \
    -p "${DB_PORT:-5432}" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -v ON_ERROR_STOP=1

if [ $? -eq 0 ]; then
    print_success "Database initialized successfully!"
    print_info ""
    print_info "Created:"
    print_info "  - connection_test table with sample data"
    print_info "  - agents schema for platform tables"
    print_info ""
    print_info "You can now run test-connection.sh to verify the setup"
else
    print_error "Database initialization failed"
    exit 1
fi

unset PGPASSWORD
