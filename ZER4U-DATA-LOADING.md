# Zer4U Data Loading - Complete Guide

## Overview

This guide documents the complete process of loading Zer4U customer data (7 GB, 30 CSV files) from Google Cloud Storage into PostgreSQL.

**Final Results:**
- ✅ 30 tables loaded successfully
- ✅ ~63.3 million rows total
- ✅ ~8-9 GB database size
- ✅ 45 indexes created for performance
- ✅ Ready for production queries

---

## Architecture

### Data Flow
```
Google Cloud Storage (GCS)
    ↓
PostgreSQL COPY Command (streaming)
    ↓
PostgreSQL Database (zer4u schema)
    ↓
Zer4U Crew Member (AI queries)
```

### Key Technologies
- **PostgreSQL COPY**: 10-50x faster than INSERT
- **pg-copy-streams**: Node.js streaming library
- **GCS Service**: Direct streaming from cloud storage
- **Indexed Columns**: B-tree indexes on codes, dates, IDs

---

## Scripts Overview

### 1. Data Analysis
```bash
node scripts/scan-csv-files.js
```
- Scans all CSV files in GCS bucket
- Detects column types and structure
- Handles Hebrew filenames
- Outputs: `data/zer4u-schema-analysis.json`

**Key Features:**
- Hebrew to English table name mapping
- Conservative type inference (NUMERIC/TEXT)
- Sample-based analysis (500-1000 rows)

### 2. Schema Creation
```bash
node scripts/create-zer4u-schema.js
```
- Drops and recreates `zer4u` schema
- Creates all 30 tables with TEXT columns
- No constraints (for maximum loading speed)

### 3. Data Loading (COPY Method)
```bash
node scripts/load-csv-to-db-copy.js
```
- Uses PostgreSQL COPY FROM STDIN
- Streams directly from GCS
- Progress tracking every 2 seconds
- Speed: 8,000-40,000 rows/sec

**Performance Comparison:**
- Old method (batch INSERT): 4,456 rows/sec ❌
- COPY method: 8,000-40,000 rows/sec ✅

### 4. Failed Tables Reload
```bash
node scripts/reload-failed-tables.js
```
- Reloads specific tables that failed with type errors
- Uses TEXT for all columns (safest approach)
- Handles edge cases (decimals, percentages)

### 5. Sales Table Loader
```bash
node scripts/load-sales-only.js
```
- Dedicated script for largest table (3.63 GB)
- Extended timeouts (1 hour)
- Special handling for network stability

### 6. Index Creation
```bash
node scripts/create-indexes.js
```
- Creates 45 indexes across all tables
- Patterns: codes, dates, IDs, foreign keys
- Time: ~40 minutes for all indexes

**Index Patterns:**
- `kod_*`, `*_kod`, `קוד*` - Item/customer codes
- `*date*`, `תאריך*` - Date columns
- `store*`, `customer*`, `item*` - Business entities

### 7. Verification
```bash
node scripts/check-loaded-tables.js
```
- Lists all tables with row counts and sizes
- Identifies missing tables
- Verifies data integrity

---

## Table Details

### Large Tables (>1 GB)
| Table | Rows | Size | Columns | Key Indexes |
|-------|------|------|---------|-------------|
| linktable | 23.9M | 2.4 GB | 8 | item_code, date, store |
| inventory | 19.8M | 1.9 GB | 6 | - |
| sales | 9.5M | 3.9 GB | 54 | item_code, customer, date, store |

### Medium Tables (100 MB - 1 GB)
| Table | Rows | Size | Columns | Key Indexes |
|-------|------|------|---------|-------------|
| shorot_kbla | 7.6M | 686 MB | 5 | - |
| customers | 1.4M | 112 MB | 7 | customer_number, name |

### Small Tables (<100 MB)
- 25 additional tables
- Various business data (stores, items, targets, etc.)
- Total: ~2.4M rows

---

## Performance Optimization

### 1. COPY vs INSERT
**Before (INSERT):**
- LinkTable: 76 minutes (4,456 rows/sec)

**After (COPY):**
- LinkTable: ~10 minutes (40,000+ rows/sec)
- **Result: 7.6x faster!**

### 2. Indexes
**Without Indexes:**
- Filter by item code: 5-30 seconds
- JOIN queries: 10-60 seconds

**With Indexes:**
- Filter by item code: <1 second
- JOIN queries: <5 seconds
- **Result: 5-30x faster queries!**

---

## Troubleshooting

### Issue: Type Mismatch Errors
**Symptoms:**
```
invalid input syntax for type integer: '5.5'
invalid input syntax for type numeric: '144607%'
```

**Solution:**
- Use TEXT columns for problematic tables
- Run `reload-failed-tables.js`
- PostgreSQL can still do numeric operations on TEXT

### Issue: Network Timeout (ECONNRESET)
**Symptoms:**
```
read ECONNRESET
```

**Solution:**
- Increase timeouts (connectionTimeoutMillis, statement_timeout)
- Use dedicated loader script (load-sales-only.js)
- Consider Cloud SQL Proxy for stability

### Issue: Hebrew Filenames Not Converting
**Symptoms:**
- Empty table names for files 21-30
- Tables not created

**Solution:**
- Added HEBREW_TABLE_NAMES mapping in scan-csv-files.js
- Maps Hebrew filenames to English table names

---

## Testing Guide

See [TEST-ZER4U-DATA.md](TEST-ZER4U-DATA.md) for complete testing instructions.

**Quick Test:**
1. Go to https://aspect-agents.web.app
2. Select Zer4U crew member
3. Ask: "Show me overall statistics for all tables"
4. Verify response includes all 30 tables

---

## Production Deployment

### Prerequisites
- PostgreSQL database configured
- GCS bucket access
- Environment variables set (.env)

### Deployment Steps
1. Run schema creation
2. Run data loading (COPY method)
3. Handle failed tables if needed
4. Create indexes
5. Verify data integrity
6. Test with sample queries
7. Monitor performance

### Environment Variables
```bash
DB_HOST=your-db-host
DB_PORT=5432
DB_NAME=your-db-name
DB_USER=your-db-user
DB_PASSWORD=your-password
GCS_BUCKET=your-bucket-name
```

---

## Maintenance

### Adding New Data
1. Upload CSV to GCS bucket
2. Run scan-csv-files.js to analyze
3. Run load-csv-to-db-copy.js to load
4. Create indexes for new tables

### Updating Existing Data
1. Use reload-failed-tables.js or similar
2. Or truncate table and reload
3. Rebuild indexes if needed

### Monitoring
- Check table sizes: `check-loaded-tables.js`
- Monitor query performance
- Watch for slow queries (enable PostgreSQL slow query log)

---

## Lessons Learned

1. **Use COPY, not INSERT** for bulk data
   - 10-50x performance improvement
   - Direct streaming from source

2. **Create indexes AFTER loading**
   - Loading without constraints is faster
   - Add indexes once data is loaded

3. **Conservative type inference**
   - Use TEXT for problematic columns
   - Can still perform numeric operations
   - Avoids type mismatch errors

4. **Handle Hebrew filenames explicitly**
   - Regex sanitization removes Hebrew chars
   - Need explicit mapping table

5. **Network stability matters**
   - Large files (>3 GB) prone to timeouts
   - Use extended timeouts or proxies
   - Consider chunked loading

---

## Contact & Support

For issues or questions:
1. Check troubleshooting section above
2. Review script comments and logs
3. Test queries in TEST-ZER4U-DATA.md
4. Verify environment configuration

---

## Summary

**Time Investment:** ~2 days
**Result:** Production-ready data warehouse with 63M rows
**Performance:** Sub-second queries with proper indexing
**Status:** ✅ Complete and tested
