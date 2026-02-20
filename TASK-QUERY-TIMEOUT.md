# Task: Query Timeout & User Feedback

**Depends on:** TASK-AUTO-INDEXING.md (Query Optimizer) must be completed first.

## Goal
Prevent long-running queries from blocking the agent. Kill queries that exceed 15 seconds and provide helpful feedback to the user pointing them to the Query Optimizer.

## Problem
- Some queries can run for minutes, blocking the conversation
- User waits with no feedback
- Bad UX and wastes resources

## Solution

### How It Works

```
Query Execution Started
        ↓
   Duration > 15s?
        ↓ YES
   [Kill Query]
        ↓
   [Log to slow_queries with status: 'timeout']
        ↓
   [Return friendly message to user]
```

---

## Implementation

### 1. Modify data-query.service.js

```javascript
const QUERY_TIMEOUT_MS = 15000; // 15 seconds

async queryByQuestion(question, customerSchema, options = {}) {
  const client = await this.pool.connect();

  try {
    // Set PostgreSQL statement timeout
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);

    const startTime = Date.now();
    const result = await client.query(sql);
    const duration = Date.now() - startTime;

    // Log slow queries (5-15s) - they completed but were slow
    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      await this.logSlowQuery({ ...params, status: 'completed' });
    }

    return result;

  } catch (error) {
    // Check if it's a timeout error
    if (error.message.includes('statement timeout') ||
        error.message.includes('canceling statement')) {

      // Log as timed-out query
      await this.logSlowQuery({
        agentName,
        schemaName,
        question,
        sql,
        durationMs: QUERY_TIMEOUT_MS,
        status: 'timeout'
      });

      // Return user-friendly response
      return {
        error: true,
        timeout: true,
        message: this.getTimeoutMessage()
      };
    }
    throw error;
  }
}

getTimeoutMessage() {
  return `I'm sorry, this query is taking too long to process.

The query has been logged and can be reviewed in the **Query Optimizer** dashboard, where an admin can analyze it and create optimizations to make similar queries faster in the future.

In the meantime, try asking a more specific question or narrowing down the time range.`;
}
```

### 2. Update slow_queries Table

Add `status` column to distinguish:
```sql
ALTER TABLE public.slow_queries
ADD COLUMN status TEXT DEFAULT 'completed';
-- Values: 'completed' (slow but finished), 'timeout' (killed)
```

### 3. Update Crew Member Response

In `zer4u.crew.js`, handle the timeout response:

```javascript
async handleDataFetch(params) {
  const result = await dataQueryService.queryByQuestion(...);

  if (result.timeout) {
    return {
      error: true,
      userMessage: result.message,
      suggestion: 'Try a more specific question or smaller date range.'
    };
  }

  // ... normal handling
}
```

### 4. Admin Dashboard Update

In Query Optimizer, show timeout status:

| Status | Badge | Description |
|--------|-------|-------------|
| `completed` | 🐌 Slow | Completed in 5-15s |
| `timeout` | ⏱️ Timeout | Killed after 15s |

Filter options: All / Slow / Timeout

---

## Config

```bash
QUERY_TIMEOUT_MS=15000          # Kill queries after 15s
SLOW_QUERY_THRESHOLD_MS=5000    # Log queries slower than 5s
```

---

## User Message Examples

**Hebrew version:**
```
מצטער, השאילתה לוקחת יותר מדי זמן.

השאילתה נשמרה וניתן לבדוק אותה בלוח הבקרה של **Query Optimizer**, שם מנהל יכול לנתח אותה וליצור אופטימיזציות.

בינתיים, נסה לשאול שאלה יותר ספציפית או לצמצם את טווח התאריכים.
```

**English version:**
```
I'm sorry, this query is taking too long to process.

The query has been logged and can be reviewed in the Query Optimizer dashboard, where an admin can analyze it and create optimizations.

In the meantime, try asking a more specific question or narrowing down the time range.
```

---

## Files to Modify

| File | Change |
|------|--------|
| `services/data-query.service.js` | Add timeout handling |
| `services/slow-query.service.js` | Add `status` field |
| `agents/aspect/crew/zer4u.crew.js` | Handle timeout response |
| `db/migrations/xxx_add_slow_query_status.sql` | Add status column |
| Client: `SlowQueriesTable.tsx` | Show timeout badge + filter |

---

## Priority: Medium

## Estimated Complexity
| Component | Effort |
|-----------|--------|
| Query timeout logic | Low |
| User message handling | Low |
| Status column + migration | Low |
| Admin UI badge/filter | Low |
| **Total** | **1 focused session** |
