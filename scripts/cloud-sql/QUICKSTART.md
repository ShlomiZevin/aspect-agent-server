# Cloud SQL Quick Start Guide

Get your Cloud SQL PostgreSQL database up and running in 5 minutes.

## Prerequisites Checklist

- [ ] Google Cloud account with billing enabled
- [ ] `gcloud` CLI installed and authenticated
- [ ] `psql` (PostgreSQL client) installed
- [ ] Appropriate GCP permissions

## 5-Minute Setup

### Step 1: Configure (1 minute)

```bash
cd scripts/cloud-sql
cp cloud-sql-config.env.template cloud-sql-config.env
```

Edit `cloud-sql-config.env`:
```bash
GCP_PROJECT_ID=your-project-id
REGION=europe-west1
INSTANCE_NAME=aspect-agents-db
TIER=db-f1-micro  # ~$10/month for development
```

### Step 2: Provision (2-3 minutes)

```bash
./provision-cloudsql.sh cloud-sql-config.env
```

**Save the password shown at the end!**

### Step 3: Authorize Your IP (30 seconds)

```bash
./authorize-ip.sh
```

### Step 4: Initialize Database (30 seconds)

```bash
./init-database.sh
```

### Step 5: Test Connection (30 seconds)

```bash
./test-connection.sh
```

You should see:
```
✅ All connection tests passed!
```

## What You Get

- ✅ PostgreSQL 15 instance in Europe
- ✅ Database: `agents_platform_db`
- ✅ Admin user with secure password
- ✅ Test table for verification
- ✅ `agents` schema for your platform
- ✅ Connection details in `../.env.cloudsql`

## Connect to Your Database

### Option A: Direct Connection
```bash
source ../.env.cloudsql
psql -h $DB_HOST -U $DB_USER -d $DB_NAME
# Enter password when prompted
```

### Option B: Cloud SQL Proxy (Recommended)
```bash
# Terminal 1
./connect-proxy.sh

# Terminal 2
psql -h 127.0.0.1 -U agent_admin -d agents_platform_db
```

## Use in Your Application

1. Load environment variables:
   ```bash
   # Add to your .env file (in server root)
   cat .env.cloudsql >> .env
   ```

2. Initialize database service:
   ```javascript
   const db = require('./services/database');
   await db.initialize();
   ```

3. Query the database:
   ```javascript
   const result = await db.query('SELECT * FROM connection_test');
   console.log(result.rows);
   ```

## Common Commands

```bash
# Test connection
./test-connection.sh

# Authorize new IP
./authorize-ip.sh

# Connect via proxy
./connect-proxy.sh

# Connect with psql
source ../.env.cloudsql && psql -h $DB_HOST -U $DB_USER -d $DB_NAME
```

## Troubleshooting

**Can't connect?**
```bash
./authorize-ip.sh  # Authorize your IP
```

**Forgot password?**
```bash
cat ../.env.cloudsql | grep DB_PASSWORD
```

**Want to see instance details?**
```bash
gcloud sql instances describe aspect-agents-db
```

## Next Steps

- [ ] Create your application tables
- [ ] Integrate with Express routes
- [ ] Set up migrations
- [ ] Configure monitoring

See [README.md](README.md) for detailed documentation.
