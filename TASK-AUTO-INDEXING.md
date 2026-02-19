# Task: Adaptive Auto-Indexing for Zer4U Agent

## Goal
Enable the zer4u crew member to detect slow queries, identify missing indexes, and automatically create them to improve response times.

## Problem
- Users ask unpredictable questions
- Pre-created indexes may not cover all query patterns
- Slow queries (>5s) hurt user experience
- Manual index management doesn't scale

## Solution: Query Performance Monitor + Auto-Indexer

### How It Works

```
User Question → SQL Generated → Query Executed
                                      ↓
                              [Performance Monitor]
                                      ↓
                         Duration > threshold (3s)?
                                      ↓
                              [Analyze EXPLAIN]
                                      ↓
                         Sequential scan on large table?
                                      ↓
                              [Create Index]
                                      ↓
                         Log + Notify (optional)
```

### Implementation Steps

#### 1. Add Query Logging Table
```sql
CREATE TABLE zer4u.query_performance_log (
  id SERIAL PRIMARY KEY,
  question TEXT,
  sql TEXT,
  duration_ms INTEGER,
  rows_returned INTEGER,
  explain_plan JSONB,
  suggested_index TEXT,
  index_created BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### 2. Modify data-query.service.js
- Log every query with duration
- If duration > 3000ms, run EXPLAIN ANALYZE
- Parse explain plan for sequential scans on tables > 10K rows
- Extract columns used in WHERE, JOIN, ORDER BY

#### 3. Create index-advisor.service.js
```javascript
class IndexAdvisorService {
  // Analyze slow query and suggest index
  async analyzeSlowQuery(sql, explainPlan) { }

  // Check if suggested index already exists
  async indexExists(tableName, columns) { }

  // Create index with standard naming
  async createIndex(tableName, columns, options) { }

  // Track index usage over time
  async getUnusedIndexes() { }
}
```

#### 4. Index Creation Rules
| Pattern in Query | Index Type |
|------------------|------------|
| `WHERE col = ?` | B-tree on col |
| `WHERE col > ? AND col < ?` | B-tree on col |
| `WHERE zer4u.parse_date_ddmmyyyy(col)` | Functional index |
| `WHERE col1 = ? AND col2 = ?` | Composite (col1, col2) |
| `ORDER BY col DESC` | B-tree DESC |
| `JOIN ON col` | B-tree on col |

#### 5. Safety Guards
- Max 3 auto-indexes per day (prevent runaway)
- Only on tables > 10K rows (small tables don't need)
- Skip if index would be > 1GB estimated
- Require sequential scan in EXPLAIN (confirm it helps)
- Use CONCURRENTLY to avoid locking

#### 6. Naming Convention
```
idx_auto_{table}_{col1}_{col2}_{timestamp}
```

### Example Flow

```
User: "מה המכירות של חנות 15 בינואר?"

1. SQL Generated:
   SELECT ... FROM sales
   WHERE zer4u.to_int_safe("מס.חנות SALES") = 15
   AND zer4u.parse_date_ddmmyyyy("תאריך מקורי SALES")
       BETWEEN '2024-01-01' AND '2024-01-31'

2. Query runs: 8.2 seconds ❌

3. EXPLAIN shows: Seq Scan on sales (9.4M rows)

4. Advisor detects:
   - Missing composite index on (store, date)
   - Suggests: idx_auto_sales_store_date_20240115

5. Creates index (CONCURRENTLY)

6. Next similar query: 0.3 seconds ✅
```

### Files to Create/Modify

| File | Action |
|------|--------|
| `services/index-advisor.service.js` | Create - core logic |
| `services/data-query.service.js` | Modify - add logging |
| `db/schema/query_performance_log.sql` | Create - logging table |
| `scripts/cleanup-unused-indexes.js` | Create - maintenance |

### Config Options (env vars)
```bash
AUTO_INDEX_ENABLED=true
AUTO_INDEX_THRESHOLD_MS=3000
AUTO_INDEX_MAX_PER_DAY=3
AUTO_INDEX_MIN_TABLE_ROWS=10000
```

### Success Metrics
- Queries > 3s reduced by 80%
- Average query time < 2s
- No manual index requests needed

---

## Admin UI: Index Manager

### Location
Add to existing admin section: `/admin/indexes`

### Features

#### 1. Index Dashboard Table
| Column | Description |
|--------|-------------|
| Index Name | `idx_auto_sales_store_date_...` |
| Table | `sales` |
| Columns | `store, date` |
| Reason | "Slow query: store filter + date range" |
| Status | 🟡 Building / ✅ Active / ❌ Failed / 🗑️ Dropped |
| Created | 2024-01-15 14:32 |
| Size | 245 MB |
| Usage | 1,247 scans |

#### 2. Status Types
```
🟡 BUILDING   - Index creation in progress
✅ ACTIVE     - Index ready and being used
⚠️ UNUSED    - No scans in 7+ days (candidate for removal)
❌ FAILED     - Creation failed (show error)
🗑️ DROPPED   - Manually removed
```

#### 3. Admin Actions
- **Pause auto-indexing** - Stop automatic creation
- **Drop index** - Remove unused index
- **Rebuild index** - Recreate with CONCURRENTLY
- **Force create** - Manually trigger index from suggestion

#### 4. Manual Index Tool
For offline/scheduled indexing:
```bash
# CLI tool for manual index operations
node scripts/index-manager.js --list           # Show all indexes
node scripts/index-manager.js --suggestions    # Show pending suggestions
node scripts/index-manager.js --create <name>  # Create specific index
node scripts/index-manager.js --drop <name>    # Drop index
node scripts/index-manager.js --rebuild-all    # Rebuild during maintenance
```

### Database Table for Admin
```sql
CREATE TABLE zer4u.index_registry (
  id SERIAL PRIMARY KEY,
  index_name TEXT UNIQUE NOT NULL,
  table_name TEXT NOT NULL,
  columns TEXT[] NOT NULL,
  reason TEXT,                    -- Short: "store + date filter"
  status TEXT DEFAULT 'pending',  -- pending/building/active/failed/dropped
  auto_created BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  size_bytes BIGINT,
  scan_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  dropped_at TIMESTAMP
);
```

### API Endpoints
```
GET  /api/admin/indexes          - List all indexes with stats
GET  /api/admin/indexes/suggest  - Get suggested indexes
POST /api/admin/indexes          - Create index manually
DELETE /api/admin/indexes/:name  - Drop index
POST /api/admin/indexes/:name/rebuild - Rebuild index
POST /api/admin/indexes/pause    - Pause auto-indexing
```

### React Component (simplified)
```
/admin/indexes
├── IndexDashboard.tsx      - Main table view
├── IndexStatusBadge.tsx    - Status indicator
├── CreateIndexModal.tsx    - Manual creation
└── IndexSuggestions.tsx    - Pending suggestions list
```

---

## Priority: Medium-High
This is an optimization task. Core functionality works, but UX suffers on slow queries.

## Estimated Complexity
- Query logging: Low
- EXPLAIN parsing: Medium
- Auto-index creation: Medium
- Safety guards: Low
- Admin UI: Medium
- CLI tool: Low
- **Total: 3-4 focused sessions**
