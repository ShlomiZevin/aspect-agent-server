# Zer4U Data Loading - Optimized

Fast and efficient CSV data loading for Zer4U customer schema.

## 🚀 Quick Start

### Full Reload (Recommended)

Run the complete reload process in one command:

```bash
cd aspect-agent-server
node scripts/reload-zer4u-data.js
```

This will:
1. ✅ Drop existing schema
2. ✅ Create fresh schema structure (no constraints)
3. ✅ Load all CSV files from GCS

**Expected time:** ~5-15 minutes (depends on data size and network)

## 📋 Individual Scripts

If you need to run steps separately:

### 1. Clean Schema

```bash
node scripts/clean-zer4u-schema.js
```

Drops and recreates empty Zer4U schema.

### 2. Create Schema Structure

```bash
node scripts/create-zer4u-schema.js
```

Creates all tables based on CSV analysis.

### 3. Load CSV Data

```bash
node scripts/load-csv-to-db.js
```

Streams and loads all CSV files from GCS.

## ⚡ Performance Optimizations

Our loading process is optimized for **maximum speed**:

### 1. No Database Constraints
- ❌ No primary keys
- ❌ No foreign keys
- ❌ No unique constraints
- ❌ No indexes
- ✅ All columns nullable

**Why?** Constraints slow down inserts significantly. We can add them later if needed.

### 2. Large Batch Sizes
- Batch size: **5,000 rows** (increased from 1,000)
- Uses PostgreSQL multi-row INSERT
- Reduces network round-trips

### 3. Streaming from GCS
- Direct streaming from Google Cloud Storage
- No local file downloads
- Memory efficient for large files

### 4. Connection Pooling
- Pool size: 10 connections for loading
- Reuses connections across batches

## 📊 Progress Monitoring

The scripts provide detailed progress information:

### During Loading

```
[1/25] 📥 Loading: sales.csv
  → Table: sales
  → Size: 1.2 GB
  Progress: 125,000 rows (25,000 rows/s)...
  ✅ Loaded 250,000 rows in 10.5s (23,809 rows/s)
  ⏱️  ETA: 5m 30s (24 tables remaining)
```

### Final Summary

```
═══════════════════════════════════════════════════════════
📈 FINAL SUMMARY:
═══════════════════════════════════════════════════════════
Total tables: 25
Successfully loaded: 25
Failed: 0
Total rows loaded: 4,500,000
Total time: 8m 45s
Average speed: 8,571 rows/s
═══════════════════════════════════════════════════════════

⏱️  Top 5 slowest tables:
  1. sales: 180.5s (2,000,000 rows)
  2. hesbonithiuvi: 120.3s (1,500,000 rows)
  3. calendar: 45.2s (28,838 rows)
  ...
```

## 🔧 Configuration

### Environment Variables

Required in `.env`:

```env
# Database
DB_HOST=35.240.73.50  # or use Cloud SQL Proxy: 127.0.0.1
DB_PORT=5432
DB_NAME=agents_platform_db
DB_USER=agent_admin
DB_PASSWORD=your_password

# GCS
GCP_PROJECT_ID=aspect-agents
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### Adjusting Batch Size

Edit `scripts/load-csv-to-db.js`:

```javascript
const BATCH_SIZE = 5000; // Increase for faster loading (use 10000 for very fast connections)
```

**Recommendations:**
- Fast network + powerful DB: 10,000 rows
- Normal conditions: 5,000 rows (current)
- Slow network: 2,000 rows

## 🐛 Troubleshooting

### Connection Timeout

If loading times out, use **Cloud SQL Proxy**:

```bash
# Terminal 1: Start proxy
./cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db

# Terminal 2: Update .env
DB_HOST=127.0.0.1

# Terminal 3: Run loading
node scripts/reload-zer4u-data.js
```

### Memory Issues

If Node.js runs out of memory:

```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096" node scripts/reload-zer4u-data.js
```

### GCS Authentication

If getting GCS auth errors:

```bash
# Set service account credentials
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"

# Or use gcloud auth
gcloud auth application-default login
```

## 📈 Data Structure

CSV files are stored in GCS:
- **Bucket:** `aspect-clients-data`
- **Folder:** `zer4u/`
- **Format:** UTF-8 CSV with headers

Schema analysis is cached in:
- `data/zer4u-schema-analysis.json` (table structures)
- `data/zer4u-schema-description.txt` (for LLM prompting)

## 🎯 Next Steps

After loading completes:

1. **Test the data:**
   ```bash
   node scripts/test-zer4u-flow.js
   ```

2. **Start the server:**
   ```bash
   npm start
   ```

3. **Use Zer4U crew member** in the UI:
   - Open http://localhost:5173
   - Select "Zer4U" crew member
   - Ask business questions!

## 📝 Notes

- Loading is **idempotent** - safe to re-run
- Schema is dropped/recreated each time
- No data backup is performed automatically
- CSV files remain in GCS (source of truth)

---

**Last updated:** 2026-02-18
**Optimized for:** Maximum loading speed
