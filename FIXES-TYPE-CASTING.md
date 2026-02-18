# Fix: Type Mismatch in JOIN Operations

## Problem

The Zer4U data query system was failing with the error:
```
operator does not exist: text = integer
```

This occurred when joining tables with mismatched column types:
- `sales."מס.חנות SALES"` (type: **text**)
- `stores."מס.חנות"` (type: **integer**)

## Root Cause

PostgreSQL requires explicit type casting when comparing columns of different types in JOIN conditions. The schema has several such mismatches:
- Store numbers: text in sales, integer in stores
- Customer numbers: text in sales, integer in customers
- Many numeric values stored as text

## Solution Implemented

### 1. Updated SQL Generator Prompt

**File:** `services/sql-generator.service.js`

Added new rule (#10) to the system prompt:
```
10. **Type Casting**: CRITICAL - When joining tables, if column types differ (e.g., text vs integer),
    you MUST cast to matching types using ::type syntax or CAST()
    - Example: If joining text column to integer column, use: text_col::integer = int_col
    - Common case: sales."מס.חנות SALES"::integer = stores."מס.חנות" (text to integer)
```

Added example showing correct vs incorrect JOIN:
```sql
-- WRONG (type mismatch):
SELECT * FROM zer4u.sales s
JOIN zer4u.stores st ON s."מס.חנות SALES" = st."מס.חנות"
❌ operator does not exist: text = integer

-- CORRECT (with type casting):
SELECT * FROM zer4u.sales s
JOIN zer4u.stores st ON s."מס.חנות SALES"::integer = st."מס.חנות"
✅ Properly casts text to integer
```

### 2. Updated Schema Description

**File:** `data/zer4u-schema-description.txt`

Updated "Key Relationships" section to explicitly show type mismatches:
```
## Key Relationships
- Sales ↔ Stores: `מס.חנות SALES` (text) = `מס.חנות` (integer)
  REQUIRES CAST: sales."מס.חנות SALES"::integer = stores."מס.חנות"
- Sales ↔ Customers: `מס.לקוח` (text in sales, integer in customers) - REQUIRES CAST
```

Added note #7 to "Important Notes":
```
7. **Type Mismatches**: CRITICAL - Many JOIN keys have type mismatches:
   - Store numbers: text in sales, integer in stores - MUST cast: "מס.חנות SALES"::integer
   - Customer numbers: text in sales, integer in customers - MUST cast: "מס.לקוח"::integer
   - When joining, always check types and add ::integer or ::text as needed
```

## Results

### Before Fix
```sql
-- Generated query (FAILED):
SELECT st."שם חנות", SUM(s."מכירה ללא מע""מ"::numeric) as total_revenue
FROM zer4u.sales s
JOIN zer4u.stores st ON s."מס.חנות SALES" = st."מס.חנות"
GROUP BY st."שם חנות"
ORDER BY total_revenue DESC LIMIT 5

-- Error: operator does not exist: text = integer
```

### After Fix
```sql
-- Generated query (SUCCESS):
SELECT st."שם חנות", st."מס.חנות", SUM(s."מכירה ללא מע""מ"::numeric) as total_revenue
FROM zer4u.sales s
JOIN zer4u.stores st ON s."מס.חנות SALES"::integer = st."מס.חנות"
GROUP BY st."שם חנות", st."מס.חנות"
ORDER BY total_revenue DESC LIMIT 5

-- ✅ Query completed in 19.4 seconds, returned 5 rows
```

## Performance Improvements

Created indexes on key columns to speed up JOIN operations:

**File:** `scripts/create-performance-indexes.js`

Indexes created:
- `zer4u_idx_sales_store` on `sales("מס.חנות SALES")`
- `zer4u_idx_sales_customer` on `sales("מס.לקוח")`
- `zer4u_idx_sales_item` on `sales("קוד פריט SALES")`
- `zer4u_idx_sales_date` on `sales("תאריך מקורי SALES")`
- `zer4u_idx_stores_number` on `stores("מס.חנות")`
- `zer4u_idx_customers_number` on `customers("מס.לקוח")`
- And more...

## Testing

Test script: `scripts/test-specific-question.js`

Example test results:
```
Question: "top 5 stores by total sales revenue"
✅ SUCCESS - Rows: 5
Duration: 19.4 seconds
SQL: Correctly generated with type casting
```

## Architecture Notes

This fix maintains the generic architecture:
1. **Schema Description** - Generic service that describes any customer schema
2. **SQL Generator** - Generic service that translates questions to SQL using schema description
3. **Data Query Service** - Generic service that executes queries
4. **Crew Member** - Generic crew that uses the above services

The fix is applied at the **SQL Generator prompt level**, making it work for any customer schema with similar type mismatch issues.

## Future Recommendations

1. **Data Type Normalization**: Consider normalizing data types in the schema (convert text numeric columns to actual numeric types)
2. **Query Timeout**: Increase timeout for complex aggregations (currently 30 seconds)
3. **Query Optimization**: Add WHERE clauses with date ranges to limit data scanned
4. **Materialized Views**: For common aggregations (e.g., monthly sales by store)

## Files Modified

1. `services/sql-generator.service.js` - Added type casting rules and examples
2. `data/zer4u-schema-description.txt` - Updated with type mismatch information
3. `scripts/create-performance-indexes.js` - New script for index creation
4. `scripts/test-specific-question.js` - New test script for validation

## Date
2026-02-18
