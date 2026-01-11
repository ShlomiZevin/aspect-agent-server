#!/bin/bash

###############################################################################
# Cloud SQL PostgreSQL Provisioning Script
#
# This script provisions a Cloud SQL PostgreSQL instance for multi-agent
# platform. It can be reused across different projects and GCP accounts.
#
# Usage: ./provision-cloudsql.sh [config-file]
#        If no config file is provided, it will use default values and prompt
###############################################################################

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}✅${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}❌${NC} $1"
}

# Load configuration from file if provided
CONFIG_FILE="${1:-cloud-sql-config.env}"

if [ -f "$CONFIG_FILE" ]; then
    print_info "Loading configuration from $CONFIG_FILE"
    source "$CONFIG_FILE"
else
    print_warning "Config file not found. Using defaults and prompting for required values."
fi

# Set defaults or prompt for required values
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project)}"
REGION="${REGION:-europe-west1}"
INSTANCE_NAME="${INSTANCE_NAME:-aspect-agents-db}"
DB_VERSION="${DB_VERSION:-POSTGRES_15}"
TIER="${TIER:-db-f1-micro}"
DB_NAME="${DB_NAME:-agents_platform_db}"
DB_USER="${DB_USER:-agent_admin}"
STORAGE_SIZE="${STORAGE_SIZE:-10}"
BACKUP_ENABLED="${BACKUP_ENABLED:-true}"
HIGH_AVAILABILITY="${HIGH_AVAILABILITY:-false}"

print_info "=========================================="
print_info "Cloud SQL PostgreSQL Provisioning"
print_info "=========================================="
print_info "Project ID: $PROJECT_ID"
print_info "Region: $REGION"
print_info "Instance Name: $INSTANCE_NAME"
print_info "Database Version: $DB_VERSION"
print_info "Tier: $TIER"
print_info "Database Name: $DB_NAME"
print_info "Storage Size: ${STORAGE_SIZE}GB"
print_info "Backups Enabled: $BACKUP_ENABLED"
print_info "High Availability: $HIGH_AVAILABILITY"
print_info "=========================================="

# Prompt for confirmation
read -p "Do you want to proceed with this configuration? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_error "Provisioning cancelled."
    exit 1
fi

# Set the project
print_info "Setting GCP project to $PROJECT_ID"
gcloud config set project "$PROJECT_ID"

# Enable required APIs
print_info "Enabling Cloud SQL Admin API..."
gcloud services enable sqladmin.googleapis.com

# Check if instance already exists
print_info "Checking if instance $INSTANCE_NAME already exists..."
if gcloud sql instances describe "$INSTANCE_NAME" --project="$PROJECT_ID" &>/dev/null; then
    print_warning "Instance $INSTANCE_NAME already exists!"
    read -p "Do you want to continue with the existing instance? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "Provisioning cancelled."
        exit 1
    fi
    INSTANCE_EXISTS=true
else
    INSTANCE_EXISTS=false
fi

# Create Cloud SQL instance if it doesn't exist
if [ "$INSTANCE_EXISTS" = false ]; then
    print_info "Creating Cloud SQL PostgreSQL instance..."

    CREATE_CMD="gcloud sql instances create $INSTANCE_NAME \
        --database-version=$DB_VERSION \
        --tier=$TIER \
        --region=$REGION \
        --storage-size=${STORAGE_SIZE}GB \
        --storage-type=SSD \
        --storage-auto-increase \
        --backup-start-time=03:00 \
        --maintenance-window-day=SUN \
        --maintenance-window-hour=4 \
        --project=$PROJECT_ID"

    if [ "$BACKUP_ENABLED" = true ]; then
        CREATE_CMD="$CREATE_CMD --backup"
    fi

    if [ "$HIGH_AVAILABILITY" = true ]; then
        CREATE_CMD="$CREATE_CMD --availability-type=REGIONAL"
    fi

    eval $CREATE_CMD

    print_success "Cloud SQL instance created successfully!"
else
    print_info "Using existing instance $INSTANCE_NAME"
fi

# Generate a secure password
print_info "Generating secure password for database user..."
DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)

# Create database user
print_info "Creating database user $DB_USER..."
if gcloud sql users list --instance="$INSTANCE_NAME" --project="$PROJECT_ID" | grep -q "$DB_USER"; then
    print_warning "User $DB_USER already exists. Updating password..."
    gcloud sql users set-password "$DB_USER" \
        --instance="$INSTANCE_NAME" \
        --password="$DB_PASSWORD" \
        --project="$PROJECT_ID"
else
    gcloud sql users create "$DB_USER" \
        --instance="$INSTANCE_NAME" \
        --password="$DB_PASSWORD" \
        --project="$PROJECT_ID"
fi

print_success "Database user created/updated successfully!"

# Create database
print_info "Creating database $DB_NAME..."
if gcloud sql databases list --instance="$INSTANCE_NAME" --project="$PROJECT_ID" | grep -q "$DB_NAME"; then
    print_warning "Database $DB_NAME already exists."
else
    gcloud sql databases create "$DB_NAME" \
        --instance="$INSTANCE_NAME" \
        --project="$PROJECT_ID"
    print_success "Database created successfully!"
fi

# Get connection information
print_info "Retrieving connection information..."
CONNECTION_NAME=$(gcloud sql instances describe "$INSTANCE_NAME" \
    --project="$PROJECT_ID" \
    --format="value(connectionName)")

PUBLIC_IP=$(gcloud sql instances describe "$INSTANCE_NAME" \
    --project="$PROJECT_ID" \
    --format="value(ipAddresses[0].ipAddress)")

# Create .env file with connection details
ENV_FILE="../.env.cloudsql"
print_info "Creating environment file: $ENV_FILE"

cat > "$ENV_FILE" <<EOF
# Cloud SQL Connection Configuration
# Generated on $(date)

# GCP Configuration
GCP_PROJECT_ID=$PROJECT_ID
CLOUD_SQL_INSTANCE_NAME=$INSTANCE_NAME
CLOUD_SQL_CONNECTION_NAME=$CONNECTION_NAME

# Database Configuration
DB_HOST=$PUBLIC_IP
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD

# Connection String (for use with pg library)
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@$PUBLIC_IP:5432/$DB_NAME

# Cloud SQL Proxy Connection (recommended for local development)
# Run: ./scripts/cloud-sql/connect-proxy.sh
DB_HOST_PROXY=127.0.0.1
DB_PORT_PROXY=5432
DATABASE_URL_PROXY=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
EOF

print_success "Environment file created!"

# Summary
print_info "=========================================="
print_success "Cloud SQL Provisioning Complete!"
print_info "=========================================="
print_info "Instance Name: $INSTANCE_NAME"
print_info "Connection Name: $CONNECTION_NAME"
print_info "Public IP: $PUBLIC_IP"
print_info "Database: $DB_NAME"
print_info "User: $DB_USER"
print_info ""
print_warning "IMPORTANT: Save these credentials securely!"
print_info "Password: $DB_PASSWORD"
print_info ""
print_info "Connection details saved to: $ENV_FILE"
print_info ""
print_info "Next steps:"
print_info "1. Configure authorized networks (if using public IP)"
print_info "2. Run './scripts/cloud-sql/init-database.sh' to create tables"
print_info "3. Run './scripts/cloud-sql/test-connection.sh' to verify connection"
print_info "=========================================="
