# Cloud SQL PostgreSQL Setup for Multi-Agent Platform

This directory contains scripts to provision and manage a Cloud SQL PostgreSQL instance for the multi-agent platform. These scripts are designed to be reusable across different projects and Google Cloud accounts.

## Overview

The platform is designed to support multiple agents across different domains (menopause, fitness, nutrition, etc.), not just a single agent. The database architecture reflects this multi-tenant, multi-agent approach.

## Prerequisites

Before running these scripts, ensure you have:

1. **Google Cloud SDK (gcloud)** installed and configured
   ```bash
   # Install gcloud: https://cloud.google.com/sdk/docs/install
   gcloud init
   gcloud auth login
   ```

2. **PostgreSQL Client (psql)** installed
   ```bash
   # Ubuntu/Debian
   sudo apt-get install postgresql-client

   # macOS
   brew install postgresql

   # Windows
   # Download from: https://www.postgresql.org/download/windows/
   ```

3. **Cloud SQL Proxy** (optional, recommended for local development)
   ```bash
   # Linux
   curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.8.2/cloud-sql-proxy.linux.amd64
   chmod +x cloud-sql-proxy
   sudo mv cloud-sql-proxy /usr/local/bin/

   # macOS
   brew install cloud-sql-proxy

   # Windows
   # Download from: https://cloud.google.com/sql/docs/mysql/sql-proxy
   ```

4. **Permissions** in your GCP project:
   - Cloud SQL Admin
   - Service Account User
   - Compute Network Admin (for authorized networks)

## Quick Start

### 1. Configure Your Setup

Copy the configuration template and fill in your values:

```bash
cd scripts/cloud-sql
cp cloud-sql-config.env.template cloud-sql-config.env
# Edit cloud-sql-config.env with your values
```

**Configuration Options:**

- `GCP_PROJECT_ID`: Your Google Cloud project ID
- `REGION`: Region for the database (default: `europe-west1`)
- `INSTANCE_NAME`: Name for your Cloud SQL instance (default: `aspect-agents-db`)
- `DB_VERSION`: PostgreSQL version (default: `POSTGRES_15`)
- `TIER`: Machine type (see below for options)
- `DB_NAME`: Database name (default: `agents_platform_db`)
- `DB_USER`: Admin user name (default: `agent_admin`)
- `STORAGE_SIZE`: Storage in GB (default: `10`)
- `BACKUP_ENABLED`: Enable automated backups (default: `true`)
- `HIGH_AVAILABILITY`: Enable regional HA (default: `false`)

**Machine Tier Options:**

| Tier | vCPUs | RAM | Use Case | Approx. Cost/Month |
|------|-------|-----|----------|-------------------|
| `db-f1-micro` | Shared | 0.6GB | Development/Testing | ~$10 |
| `db-g1-small` | Shared | 1.7GB | Small workloads | ~$25 |
| `db-n1-standard-1` | 1 | 3.75GB | Production (small) | ~$50 |
| `db-n1-standard-2` | 2 | 7.5GB | Production (medium) | ~$100 |

### 2. Provision Cloud SQL Instance

Run the provisioning script:

```bash
# Using config file
./provision-cloudsql.sh cloud-sql-config.env

# Or with defaults (will prompt for confirmation)
./provision-cloudsql.sh
```

This script will:
- ✅ Enable required GCP APIs
- ✅ Create Cloud SQL PostgreSQL instance in Europe
- ✅ Generate secure password for admin user
- ✅ Create database user
- ✅ Create database (`agents_platform_db` or your custom name)
- ✅ Save connection details to `../.env.cloudsql`

**Expected Output:**
```
✅ Cloud SQL Provisioning Complete!
Instance Name: aspect-agents-db
Connection Name: your-project:europe-west1:aspect-agents-db
Public IP: 35.xxx.xxx.xxx
Database: agents_platform_db
User: agent_admin
Password: [generated-password]
```

### 3. Authorize Your IP Address

To connect directly (without Cloud SQL Proxy), authorize your IP:

```bash
./authorize-ip.sh
```

This will automatically detect and authorize your current public IP address.

### 4. Initialize Database

Create the initial schema and test table:

```bash
./init-database.sh
```

This creates:
- `connection_test` table with sample data
- `agents` schema for platform tables
- Proper permissions

### 5. Test Connection

Verify everything is working:

```bash
./test-connection.sh
```

This runs comprehensive tests:
- ✅ Basic connection
- ✅ PostgreSQL version check
- ✅ Database listing
- ✅ Test table verification
- ✅ Schema check
- ✅ Write permissions
- ✅ Connection pooling

## Connection Methods

### Method 1: Direct Connection (Requires IP Authorization)

Use the environment file created during provisioning:

```bash
# Load environment variables
source ../.env.cloudsql

# Connect using psql
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME

# Or use connection string
psql $DATABASE_URL
```

### Method 2: Cloud SQL Proxy (Recommended for Development)

More secure, no IP whitelisting required:

```bash
# Terminal 1: Start proxy
./connect-proxy.sh

# Terminal 2: Connect to database via proxy
psql -h 127.0.0.1 -p 5432 -U agent_admin -d agents_platform_db
```

### Method 3: Application Code

In your Node.js application:

```javascript
// Load database service
const db = require('./services/database');

// Initialize connection
await db.initialize();

// Test connection
const testResult = await db.testConnection();
console.log(testResult);

// Execute queries
const result = await db.query('SELECT * FROM connection_test');
console.log(result.rows);
```

## Environment Variables

After provisioning, your `../.env.cloudsql` file will contain:

```env
# Direct connection
DB_HOST=35.xxx.xxx.xxx
DB_PORT=5432
DB_NAME=agents_platform_db
DB_USER=agent_admin
DB_PASSWORD=generated-password
DATABASE_URL=postgresql://agent_admin:password@35.xxx.xxx.xxx:5432/agents_platform_db

# Proxy connection
DB_HOST_PROXY=127.0.0.1
DB_PORT_PROXY=5432
DATABASE_URL_PROXY=postgresql://agent_admin:password@127.0.0.1:5432/agents_platform_db

# GCP details
CLOUD_SQL_CONNECTION_NAME=project:region:instance
```

## Multi-Agent Architecture

The database is designed to support multiple agents across different domains:

```
agents_platform_db/
├── public/                    # Default schema
│   └── connection_test        # Health check table
│
└── agents/                    # Multi-agent platform schema
    ├── agents                 # Agent definitions (menopause, fitness, etc.)
    ├── conversations          # Cross-agent conversations
    ├── messages               # Message history
    ├── knowledge_bases        # Agent-specific knowledge
    └── users                  # User management
```

Future schema will support:
- 🤖 Multiple agent types (menopause, fitness, nutrition, mental health)
- 💬 Conversation management across agents
- 📚 Agent-specific knowledge bases
- 👥 User management and authentication
- 📊 Analytics and usage tracking

## Scripts Reference

| Script | Purpose |
|--------|---------|
| `provision-cloudsql.sh` | Create Cloud SQL instance and database |
| `init-database.sh` | Initialize schema and test table |
| `test-connection.sh` | Verify database connectivity |
| `connect-proxy.sh` | Start Cloud SQL Proxy for local dev |
| `authorize-ip.sh` | Add your IP to authorized networks |

## Troubleshooting

### Connection Refused

**Problem:** Can't connect to database
**Solutions:**
1. Authorize your IP: `./authorize-ip.sh`
2. Check instance is running: `gcloud sql instances describe [instance-name]`
3. Verify credentials in `.env.cloudsql`

### Permission Denied

**Problem:** Database queries fail with permission errors
**Solutions:**
1. Re-run init script: `./init-database.sh`
2. Check user exists: `gcloud sql users list --instance=[instance-name]`

### Cloud SQL Proxy Not Working

**Problem:** Proxy fails to start
**Solutions:**
1. Verify Cloud SQL Proxy is installed: `cloud-sql-proxy --version`
2. Check you're authenticated: `gcloud auth list`
3. Verify connection name: Check `.env.cloudsql`

### High Costs

**Problem:** Unexpected GCP bills
**Solutions:**
1. Use smaller tier: Change `TIER=db-f1-micro` in config
2. Disable HA: Set `HIGH_AVAILABILITY=false`
3. Schedule instance: Stop instance during off-hours
   ```bash
   gcloud sql instances patch [instance-name] --activation-policy=NEVER
   ```

## Security Best Practices

1. **Use Cloud SQL Proxy** for local development instead of authorizing IPs
2. **Rotate passwords** regularly using:
   ```bash
   gcloud sql users set-password agent_admin --instance=[instance-name] --password=[new-password]
   ```
3. **Enable SSL** for production connections
4. **Use IAM authentication** for service accounts
5. **Never commit** `.env.cloudsql` to version control
6. **Enable audit logging** in GCP Console
7. **Use private IP** for production deployments

## Cost Optimization

- **Development**: Use `db-f1-micro` tier (~$10/month)
- **Disable HA**: Not needed for development
- **Storage**: Start with 10GB, auto-increase enabled
- **Backups**: Keep enabled but adjust retention period
- **Stop when not in use**: For development instances
  ```bash
  gcloud sql instances patch [instance-name] --activation-policy=NEVER
  gcloud sql instances patch [instance-name] --activation-policy=ALWAYS
  ```

## Using with Different Projects

These scripts are designed to be reusable:

1. Create a new config file for each project:
   ```bash
   cp cloud-sql-config.env.template menopause-agent.env
   cp cloud-sql-config.env.template fitness-agent.env
   ```

2. Edit with project-specific values:
   ```bash
   # menopause-agent.env
   GCP_PROJECT_ID=menopause-project
   INSTANCE_NAME=menopause-agent-db
   DB_NAME=menopause_agent_db
   ```

3. Provision with specific config:
   ```bash
   ./provision-cloudsql.sh menopause-agent.env
   ```

## Support

For issues or questions:
1. Check GCP Cloud SQL documentation: https://cloud.google.com/sql/docs
2. Review PostgreSQL documentation: https://www.postgresql.org/docs/
3. Check connection logs: `gcloud sql operations list --instance=[instance-name]`

## Next Steps

After setting up Cloud SQL:

1. ✅ Design and create your agent-specific tables
2. ✅ Integrate database service in your Express routes
3. ✅ Set up connection pooling for production
4. ✅ Implement migrations for schema changes
5. ✅ Configure backups and disaster recovery
6. ✅ Set up monitoring and alerting
