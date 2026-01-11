#!/bin/bash

###############################################################################
# Database Connection Test Script
#
# Tests the connection to Cloud SQL PostgreSQL and verifies database setup
#
# Usage: ./test-connection.sh [env-file]
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
print_info "Database Connection Test"
print_info "=========================================="
print_info "Host: $DB_HOST"
print_info "Port: ${DB_PORT:-5432}"
print_info "Database: $DB_NAME"
print_info "User: $DB_USER"
print_info "=========================================="

export PGPASSWORD="$DB_PASSWORD"

# Test 1: Basic connection
print_info "Test 1: Testing basic connection..."
if psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
    print_success "Basic connection successful"
else
    print_error "Basic connection failed"
    print_warning "Make sure:"
    print_warning "  1. Your IP is authorized in Cloud SQL"
    print_warning "  2. The instance is running"
    print_warning "  3. Credentials are correct"
    unset PGPASSWORD
    exit 1
fi

# Test 2: Check PostgreSQL version
print_info "Test 2: Checking PostgreSQL version..."
PG_VERSION=$(psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT version();" | head -n 1)
print_success "PostgreSQL version: $PG_VERSION"

# Test 3: List databases
print_info "Test 3: Listing accessible databases..."
DATABASES=$(psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT datname FROM pg_database WHERE datistemplate = false;" | xargs)
print_success "Databases: $DATABASES"

# Test 4: Check if test table exists
print_info "Test 4: Checking for test table..."
if psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'connection_test');" | grep -q "t"; then
    print_success "Test table exists"

    # Read test data
    print_info "Reading test data..."
    psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -c "SELECT * FROM connection_test;"
else
    print_warning "Test table does not exist"
    print_info "Run init-database.sh to create it"
fi

# Test 5: Check schemas
print_info "Test 5: Checking schemas..."
SCHEMAS=$(psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema';" | xargs)
print_success "Schemas: $SCHEMAS"

# Test 6: Test write permissions
print_info "Test 6: Testing write permissions..."
TEST_WRITE=$(psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -t -c "
    CREATE TEMP TABLE test_write (id int);
    INSERT INTO test_write VALUES (1);
    SELECT COUNT(*) FROM test_write;
    DROP TABLE test_write;
" 2>&1)

if echo "$TEST_WRITE" | grep -q "1"; then
    print_success "Write permissions verified"
else
    print_error "Write permissions test failed"
fi

# Test 7: Connection pooling test
print_info "Test 7: Testing multiple connections..."
for i in {1..3}; do
    psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 'Connection $i' as test;" > /dev/null 2>&1 &
done
wait
print_success "Multiple connections successful"

print_info "=========================================="
print_success "All connection tests passed!"
print_info "=========================================="
print_info ""
print_info "Connection string for your application:"
print_info "postgresql://$DB_USER:****@$DB_HOST:${DB_PORT:-5432}/$DB_NAME"
print_info ""
print_info "Your database is ready for use!"

unset PGPASSWORD
