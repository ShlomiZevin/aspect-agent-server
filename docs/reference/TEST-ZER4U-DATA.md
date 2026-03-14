# Testing Zer4U Data on Production

## 1️⃣ Create Indexes

```bash
cd g:/Shlomi/freeda2/aspect-agent-server
node scripts/create-indexes.js
```

This will take a few minutes. Indexes are critical for query performance!

---

## 2️⃣ Access the Website

**Production URL:** https://aspect-agents.web.app

Or run locally:
```bash
cd aspect-agent-client-react
npm run dev
# Opens http://localhost:5173
```

---

## 3️⃣ Select Zer4U Crew Member

In the chat interface, select **Zer4U** from the crew members list.

---

## 4️⃣ Test Queries

### ✅ Test 1: Overall Statistics

**Query:**
```
Show me overall statistics for all tables: how many rows in each table?
```

**Expected result:**
- sales: ~9.5M rows
- linktable: ~23.9M rows
- inventory: ~19.8M rows
- shorot_kbla: ~7.6M rows
- customers: ~1.4M rows
- And remaining 25 tables

---

### ✅ Test 2: Sales by Date

**Query:**
```
Show me top 10 days with maximum sales in the last year
```

**Expected result:**
- Should execute quickly (thanks to date indexes)
- Shows dates and sales totals

---

### ✅ Test 3: Product Analysis

**Query:**
```
What are the top 10 most popular products by sales quantity?
```

**Expected result:**
- List of products with codes and quantities
- Query should run fast

---

### ✅ Test 4: Customer Analysis

**Query:**
```
Show me top 5 customers by total purchase amount
```

**Expected result:**
- List of customers with totals
- Customer names/codes

---

### ✅ Test 5: Warehouse Inventory

**Query:**
```
Show me current inventory from warehouse_inventory table
```

**Expected result:**
- List of items with quantities in stock
- ~1,693 records

---

### ✅ Test 6: JOIN Between Tables

**Query:**
```
Join sales data with items information and show me 10 examples
```

**Expected result:**
- Data from two tables combined
- Shows that table relationships work correctly

---

## 5️⃣ Performance Check

### Slow Query WITHOUT indexes:
- Filter by item code: 5-30 seconds ❌

### Fast Query WITH indexes:
- Filter by item code: <1 second ✅

---

## 6️⃣ Error Checking

Monitor:
1. **Browser console** (F12) - JavaScript errors
2. **Network tab** - API errors
3. **Server logs** - SQL errors

---

## 7️⃣ Direct SQL Verification Commands

If you need to verify directly in the database:

```sql
-- Row count for all tables
SELECT
  schemaname,
  tablename,
  n_live_tup as row_count
FROM pg_stat_user_tables
WHERE schemaname = 'zer4u'
ORDER BY n_live_tup DESC;

-- Check indexes
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'zer4u'
ORDER BY tablename, indexname;

-- Table sizes
SELECT
  table_name,
  pg_size_pretty(pg_total_relation_size('zer4u.' || table_name)) as size
FROM information_schema.tables
WHERE table_schema = 'zer4u'
ORDER BY pg_total_relation_size('zer4u.' || table_name) DESC;
```

---

## ✅ Success Criteria

- [ ] All 30 tables loaded with data
- [ ] Indexes created (>45 indexes)
- [ ] Queries execute quickly (<5 sec)
- [ ] Zer4U crew member responds to questions
- [ ] JOINs between tables work
- [ ] No errors in console/logs

---

## 🐛 Troubleshooting

### Issue: "Table not found"
**Solution:** Verify schema = 'zer4u' and tables exist

### Issue: Slow queries
**Solution:** Verify indexes are created (`\di` in psql)

### Issue: "Connection timeout"
**Solution:** Check server is running and .env is configured

### Issue: Zer4U not responding
**Solution:** Verify crew member is configured and prompt is correct

---

## 📊 Final Stats

After successful testing:
- ✅ Data loaded: 30 tables, ~63M rows
- ✅ Indexes created: 45 indexes
- ✅ Database size: ~8-9 GB
- ✅ Ready for production use!

---

## 🚀 Next Steps

1. Test all queries above
2. Verify performance (<5 sec per query)
3. Check data accuracy
4. Deploy to production if needed
5. Monitor query performance in production
