# Task: Yohananhuf — New Data-Connected Agent Setup

## Background

Yohananhuf is a new retail customer joining the Aspect platform. Like Zer4U, they use Qlik for BI and will export data to CSV files in Google Cloud Storage, which we load into a dedicated PostgreSQL schema.

**Key stakeholder:** Nir — the BI person at Yohananhuf who manages Qlik. He needs a clear spec of what data to export.

**Primary use case (from Itzik Atias, 2026-03-24):**
> "I need to examine and provide insights and recommendations on cashier registers vs self-service registers. Identification is by register number. Take the implications by: sales, customers (club vs non-club), customer types, number of transactions, average transaction, times, items, etc."

### Register Type Classification (Known)

The register type is determined by register number ranges — **we do NOT need a separate dimension table from Nir**. We compute it ourselves in PostgreSQL:

```
KupaNo 0–30                                   → קופות רגילות (regular cashiers)
KupaNo 31–50 (or 31–51 for store 29 only)     → קופות עצמאיות (self-service)
KupaNo ≥ 51 (or ≥ 52 for store 29)            → עגלות חכמות (smart carts)
```

This will be implemented as an immutable PostgreSQL function for indexing and use in materialized views:

```sql
CREATE FUNCTION yohananhuf.register_type(kupa_no integer, store_id integer)
RETURNS text AS $$
  SELECT CASE
    WHEN kupa_no BETWEEN 0 AND 30 THEN 'קופות רגילות'
    WHEN kupa_no BETWEEN 31 AND 50 THEN 'קופות עצמאיות'
    WHEN kupa_no = 51 AND store_id = 29 THEN 'קופות עצמאיות'
    WHEN kupa_no >= 51 THEN 'עגלות חכמות'
    ELSE 'לא ידוע'
  END
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;
```

Three analysis groups, not two — smart carts (עגלות חכמות) are a third category.

### Data Sources (from specs in `agents/aspect/data-spec/`)

- **yohananuf-1.docx** — Comax ERP BI export (TXT/TAB files via FTP, daily at 22:00)
  - Key tables: KupaDoc_Header (tickets with `KupaNo`, `Hour`, `StoreC`, `CustomerC`), KupaDoc_Lines (line items with `PrtC`, `Cmt`, `Scm`, `ScmAlut`), Prt (items), Store (stores), Customers, Departments, PrtGroups, PrtGroupTt
  - **KupaDoc_Header.KupaNo** = register number field for register type classification
  - **KupaDoc_Header.Hour** = hour field for time-of-day analysis
- **yohananuf-2.docx** — HOST database views (SQL views for loyalty/club data)
  - Key views: vw_CustomerInfo (`sMemberNo`, `iClubId` for club membership), vw_CustomerSegments (`iSegmentNo` for customer types), vw_Club (club names)

Use `node scripts/read-docx.js agents/aspect/data-spec/yohananuf-1.docx` to read the full specs.

---

## Part 1: Email to Nir — Data Export Queries

**This section is the email content to send to Nir. Copy-paste ready.**

Based on the Comax BI export spec (yohananuf-1) and the HOST database views spec (yohananuf-2).

---

### Email Subject: Aspect BI — שאילתות לייצוא מ-Qlik

---

היי ניר,

אנחנו מקימים מערכת BI חכמה עבור יוהננוף בדגש על ניתוח קופות רגילות מול קופות עצמאיות מול עגלות חכמות.

אנחנו צריכים 4 קבצי CSV שיצאו מ-Qlik פעם ביום. להלן השאילתות לפי מבנה הטבלאות שלכם (Comax + HOST).

---

#### קובץ 1: `sales.csv` — פתקיות קופה + שורות (JOIN)

זו הטבלה המרכזית. צריך לחבר את כותרת הפתקית (KupaDoc_Header) עם השורות (KupaDoc_Lines):

```
מ-KupaDoc_Header:
  C                → מזהה פתקית (מפתח ראשי)
  StoreC           → קוד מחסן/חנות
  Date             → תאריך
  Hour             → שעה (חובה! בלי זה אי אפשר לנתח שעות שיא)
  KupaNo           → מספר קופה (חובה! זה השדה המרכזי לניתוח סוג קופה)
  CustomerC        → קוד לקוח
  Scm              → סכום פתקית
  ScmMaam          → סכום מע"מ
  MOADON_NO        → קוד לקוח מועדון בפתקית

מ-KupaDoc_Lines (JOIN על KupaDocC = KupaDoc_Header.C):
  PrtC             → קוד פריט
  Cmt              → כמות
  Scm              → סכום שורה (נטו)
  ScmAlut          → סכום עלות
  MivzaNo          → מספר מבצע
  AczDisLine       → אחוז הנחה לשורה
  MhrLine          → מחיר ליחידה ברוטו
```

**טווח:** לפחות 24 חודשים אחרונים להשוואה שנתית.

**חשוב:** השדות `Hour` ו-`KupaNo` הם קריטיים — בלעדיהם אי אפשר לעשות את הניתוח המבוקש.

---

#### קובץ 2: `customers.csv` — לקוחות + מועדון

צריך לחבר את טבלת לקוחות Comax עם נתוני מועדון מ-HOST:

```
מ-Customers (Comax):
  C                → קוד פנימי לקוח (מפתח — חייב להתאים ל-CustomerC ב-sales)
  Code             → קוד לקוח
  Nm               → שם לקוח
  CityC            → קוד עיר (JOIN ל-Cities.C → Nm לשם עיר)
  Sex              → מין (1-זכר / 2-נקבה)
  DateBirth        → תאריך לידה
  JoinDate         → תאריך הצטרפות
  Idx_Grp          → קבוצת מועדון

מ-vw_CustomerInfo (HOST, JOIN על sMemberNo = Customers.Code):
  iClubId          → מס' מועדון (JOIN ל-vw_Club.iClubId → Description לשם מועדון)
  dtMembershipStart → תאריך תחילת מועדון
  dtMembershipEnd   → תאריך סיום מועדון

מ-vw_CustomerSegments (HOST, JOIN על dCustomerId):
  iSegmentNo       → מס' סגמנט (סוג לקוח)
```

**חשוב:** אנחנו צריכים לדעת לכל לקוח:
- האם הוא חבר מועדון פעיל (dtMembershipEnd > today, או iClubId קיים)
- מה הסגמנט שלו (iSegmentNo)

**שאלה:** מה הערכים האפשריים של iSegmentNo? (צריך מיפוי מספר→שם)

---

#### קובץ 3: `items.csv` — פריטים + היררכיה

```
מ-Prt (Comax):
  C                → קוד פנימי פריט (מפתח — חייב להתאים ל-PrtC ב-sales)
  Code             → קוד פריט
  Nm               → שם פריט
  BarCode          → ברקוד
  DepartmentC      → קוד מחלקה
  GroupC           → קוד קבוצה
  GroupTtC         → קוד תת קבוצה
  Spk              → קוד ספק

+ JOIN לשמות:
  Departments.Nm    → שם מחלקה (JOIN על DepartmentC = Departments.C)
  PrtGroups.Nm      → שם קבוצה (JOIN על GroupC = PrtGroups.C)
  PrtGroupTt.Nm     → שם תת קבוצה (JOIN על GroupTtC = PrtGroupTt.C)
  DepartmentsTop.Nm → שם מחלקת על (JOIN על Departments.DepartmentTop = DepartmentsTop.C)
```

---

#### קובץ 4: `stores.csv` — חנויות/מחסנים + סניפים

```
מ-Store (Comax):
  C                → קוד פנימי מחסן (מפתח — חייב להתאים ל-StoreC ב-sales)
  Code             → קוד מחסן
  Nm               → שם מחסן
  SnifC            → קוד סניף

+ JOIN:
  Snif.Nm          → שם סניף (JOIN על SnifC = Snif.C)
  Snif.Azor        → שם אזור
  Cities.Nm        → שם עיר (JOIN על Store.City = Cities.C)
```

---

#### שאלות:

1. **סגמנטי לקוחות:** מה הערכים האפשריים של `iSegmentNo` ב-vw_CustomerSegments? (צריך מיפוי מספר→שם כדי להציג נכון)
2. **נפח נתונים:** בערך כמה פתקיות קופה בחודש? (כדי שנתכנן את גודל ה-DB)

תודה!

---

**(End of email content)**

---

## Part 2: Agent Setup (Platform Work)

Once Nir's data lands in GCS, we need the full agent stack. This follows the exact pattern of Zer4U.

### Server-Side

#### 2.1 Create agent folder + crew member

```
agents/yohananhuf/
├── AGENT.md              — agent documentation (follow zer4u/AGENT.md pattern)
└── crew/
    ├── index.js           — exports { YohananhufCrew }
    └── yohananhuf.crew.js — single BI crew member with fetch_yohananhuf_data tool
```

**Crew member config:**
- Name: `yohananhuf`
- Model: `gpt-4o`
- Tool: `fetch_yohananhuf_data` — calls `dataQueryService.queryByQuestion(question, 'yohananhuf')`
- Guidance: Business intelligence advisor for Yohananhuf retail chain. Specialized in **register type analysis** — three categories: קופות רגילות (regular), קופות עצמאיות (self-service), עגלות חכמות (smart carts). Responds in Hebrew/English matching user language.
- The guidance should specifically mention the three register types as a core capability and include example questions.

#### 2.2 DB migration: add agent record

```
db/migrations/run-0XX-add-yohananhuf-agent.js
```

Insert into `agents` table:
- name: `Yohananhuf`
- url_slug: `yohananhuf`
- domain: `retail`
- model: `gpt-4o`, provider: `openai`

Follow `run-016-add-zer4u-agent.js` exactly.

#### 2.3 Data loading scripts

```
scripts/
├── create-yohananhuf-indexes.js          — yohananhuf-specific indexes + helper functions
├── create-yohananhuf-materialized-views.js — yohananhuf-specific views (register-type focused)
└── reload-yohananhuf-zero-downtime.js    — orchestrator (register with DataReloadService)
```

**If the Data Loader Infrastructure task (ID 423) is done first**, the generic pipeline (scan CSV → create schema → load via COPY → shadow swap) is already parameterized. The yohananhuf-specific work is:
- The `register_type()` classification function
- The index definitions
- The materialized views
- The reload function that chains everything

#### 2.4 Helper functions (yohananhuf-specific)

```sql
-- Reuse same pattern as zer4u:
CREATE FUNCTION yohananhuf.parse_date_ddmmyyyy(text) RETURNS date ...
CREATE FUNCTION yohananhuf.to_int_safe(text) RETURNS integer ...
CREATE FUNCTION yohananhuf.to_numeric_safe(text) RETURNS numeric ...

-- NEW: Time parser for שעה column
CREATE FUNCTION yohananhuf.parse_time_hhmm(text) RETURNS time AS $$
  SELECT CASE WHEN $1 IS NULL OR $1 = '' THEN NULL ELSE $1::time END
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;

-- NEW: Register type classifier (THE core business logic)
CREATE FUNCTION yohananhuf.register_type(kupa_no integer, store_id integer)
RETURNS text AS $$
  SELECT CASE
    WHEN kupa_no BETWEEN 0 AND 30 THEN 'קופות רגילות'
    WHEN kupa_no BETWEEN 31 AND 50 THEN 'קופות עצמאיות'
    WHEN kupa_no = 51 AND store_id = 29 THEN 'קופות עצמאיות'
    WHEN kupa_no >= 51 THEN 'עגלות חכמות'
    ELSE 'לא ידוע'
  END
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;

-- Convenience wrapper that takes text inputs (what the CSV columns actually are):
CREATE FUNCTION yohananhuf.register_type_from_text(kupa_text text, store_text text)
RETURNS text AS $$
  SELECT yohananhuf.register_type(
    yohananhuf.to_int_safe(kupa_text),
    yohananhuf.to_int_safe(store_text)
  )
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;
```

#### 2.5 Indexes (yohananhuf-specific)

```sql
-- Core single-column indexes on sales:
idx_sales_date_parsed        — yohananhuf.parse_date_ddmmyyyy("תאריך")
idx_sales_register           — yohananhuf.to_int_safe("מס.קופה")
idx_sales_store              — yohananhuf.to_int_safe("מס.חנות")
idx_sales_customer           — yohananhuf.to_int_safe("מס.לקוח")
idx_sales_item               — "קוד פריט"
idx_sales_revenue            — yohananhuf.to_numeric_safe("מכירה ללא מע""מ") DESC
idx_sales_time               — yohananhuf.parse_time_hhmm("שעה")

-- Register type index (computed from register + store):
idx_sales_register_type      — yohananhuf.register_type_from_text("מס.קופה", "מס.חנות")

-- Composite indexes for key analysis patterns:
idx_sales_register_type_date — (register_type_from_text, parse_date_ddmmyyyy) — register perf over time
idx_sales_store_date         — (to_int_safe("מס.חנות"), parse_date_ddmmyyyy) — store perf over time
idx_sales_register_store     — (to_int_safe("מס.קופה"), to_int_safe("מס.חנות")) — register by store
idx_sales_customer_date      — (to_int_safe("מס.לקוח"), parse_date_ddmmyyyy) — customer history
```

#### 2.6 Materialized Views (yohananhuf-specific)

**Register-type focused views (the core analysis):**

```sql
-- 1. THE primary view: register type performance by month
CREATE MATERIALIZED VIEW yohananhuf.mv_by_register_type_month AS
SELECT
  yohananhuf.register_type_from_text(s."מס.קופה", s."מס.חנות") AS register_type,
  TO_CHAR(yohananhuf.parse_date_ddmmyyyy(s."תאריך"), 'YYYY-MM') AS year_month,
  COUNT(DISTINCT s."מזהה עסקה") AS transaction_count,
  COUNT(*) AS line_item_count,
  SUM(s."מכירה ללא מע""מ"::numeric) AS total_revenue,
  AVG(s."מכירה ללא מע""מ"::numeric) AS avg_line_item,
  COUNT(DISTINCT s."מס.לקוח") AS unique_customers
FROM yohananhuf.sales s
WHERE s."מכירה ללא מע""מ" IS NOT NULL AND s."מכירה ללא מע""מ" != ''
GROUP BY register_type, year_month;

-- 2. Register type × store (which stores have best self-service adoption?)
CREATE MATERIALIZED VIEW yohananhuf.mv_by_register_type_store AS
SELECT
  yohananhuf.register_type_from_text(s."מס.קופה", s."מס.חנות") AS register_type,
  yohananhuf.to_int_safe(s."מס.חנות") AS store_number,
  st."שם חנות" AS store_name,
  COUNT(DISTINCT s."מזהה עסקה") AS transaction_count,
  SUM(s."מכירה ללא מע""מ"::numeric) AS total_revenue,
  COUNT(DISTINCT s."מס.לקוח") AS unique_customers
FROM yohananhuf.sales s
LEFT JOIN yohananhuf.stores st ON yohananhuf.to_int_safe(s."מס.חנות") = st."מס.חנות"
WHERE s."מכירה ללא מע""מ" IS NOT NULL AND s."מכירה ללא מע""מ" != ''
GROUP BY register_type, store_number, store_name;

-- 3. Register type × hour of day (peak hours per register type)
CREATE MATERIALIZED VIEW yohananhuf.mv_by_register_type_hour AS
SELECT
  yohananhuf.register_type_from_text(s."מס.קופה", s."מס.חנות") AS register_type,
  EXTRACT(HOUR FROM yohananhuf.parse_time_hhmm(s."שעה"))::integer AS hour_of_day,
  COUNT(DISTINCT s."מזהה עסקה") AS transaction_count,
  SUM(s."מכירה ללא מע""מ"::numeric) AS total_revenue,
  COUNT(DISTINCT s."מס.לקוח") AS unique_customers
FROM yohananhuf.sales s
WHERE s."שעה" IS NOT NULL AND s."שעה" != ''
  AND s."מכירה ללא מע""מ" IS NOT NULL AND s."מכירה ללא מע""מ" != ''
GROUP BY register_type, hour_of_day;

-- 4. Register type × customer segment (club/non-club by register type)
CREATE MATERIALIZED VIEW yohananhuf.mv_by_register_type_customer_segment AS
SELECT
  yohananhuf.register_type_from_text(s."מס.קופה", s."מס.חנות") AS register_type,
  COALESCE(c."חבר מועדון", 'לא ידוע') AS club_member,
  COALESCE(c."סוג לקוח", 'לא ידוע') AS customer_type,
  COUNT(DISTINCT s."מזהה עסקה") AS transaction_count,
  SUM(s."מכירה ללא מע""מ"::numeric) AS total_revenue,
  COUNT(DISTINCT s."מס.לקוח") AS unique_customers
FROM yohananhuf.sales s
LEFT JOIN yohananhuf.customers c ON yohananhuf.to_int_safe(s."מס.לקוח") = c."מס.לקוח"
WHERE s."מכירה ללא מע""מ" IS NOT NULL AND s."מכירה ללא מע""מ" != ''
GROUP BY register_type, club_member, customer_type;

-- 5. Register type × product category (what sells at each register type?)
CREATE MATERIALIZED VIEW yohananhuf.mv_by_register_type_item_group AS
SELECT
  yohananhuf.register_type_from_text(s."מס.קופה", s."מס.חנות") AS register_type,
  COALESCE(i."קבוצת פריט", 'לא ידוע') AS item_group,
  SUM(s."כמות"::numeric) AS total_quantity,
  SUM(s."מכירה ללא מע""מ"::numeric) AS total_revenue,
  COUNT(DISTINCT s."מזהה עסקה") AS transaction_count
FROM yohananhuf.sales s
LEFT JOIN yohananhuf.items i ON s."קוד פריט" = i."קוד פריט"
WHERE s."מכירה ללא מע""מ" IS NOT NULL AND s."מכירה ללא מע""מ" != ''
GROUP BY register_type, item_group;
```

**General aggregation views (same pattern as zer4u):**

```sql
-- 6. Sales by year
mv_sales_by_year       — sale_year, transaction_count, total_revenue, avg_revenue

-- 7. Sales by month
mv_sales_by_month      — year_month, sale_year, sale_month, transaction_count, total_revenue

-- 8. Sales by store per month
mv_sales_by_store_month — store_number, store_name, year_month, transaction_count, total_revenue

-- 9. Sales by store (all-time)
mv_sales_by_store      — store_number, store_name, transaction_count, total_revenue

-- 10. Sales by customer (all-time)
mv_sales_by_customer   — customer_number, customer_name, purchase_count, total_purchases

-- 11. Sales by product (all-time)
mv_sales_by_product    — item_code, item_name, total_quantity, total_revenue
```

Total: **11 materialized views** — 5 register-type-specific + 6 general.

#### 2.7 Schema description

After loading data, generate `data/yohananhuf-schema-description.txt` using `schemaDescriptorService.generateSchemaDescription('yohananhuf')`. Then manually review and add:
- The `register_type()` function documentation and usage patterns
- Emphasis that register type analysis is the core use case
- All 11 materialized view descriptions with when-to-use guidance
- Helper function docs (same pattern as zer4u schema description)
- Common query examples for the three register types

#### 2.8 Register with Data Loader

```js
// In server.js init (after Data Loader infra task 423 is in place):
dataReloadService.registerReloader('yohananhuf', {
  reloadFn: require('./scripts/reload-yohananhuf-zero-downtime').reloadYohananhuf,
  gcsFolderPrefix: 'yohananhuf/',
});
```

Cloud Scheduler: add a second daily trigger for yohananhuf at 04:00 AM (staggered after zer4u at 03:00).

### Client-Side

#### 2.9 Agent config

```
src/agents/yohananhuf.config.ts
```

Follow `zer4u.config.ts` pattern:
- agentName: `Yohananhuf`
- displayName: `Yohananhuf Business Intelligence` (or Hebrew: `יוהננוף - מודיעין עסקי`)
- storagePrefix: `yohananhuf_`
- database: `{ schema: 'yohananhuf', enableQueryLogging: true }`
- Quick questions focused on register type analysis:
  - "השוואת קופות רגילות מול עצמאיות מול עגלות חכמות"
  - "ממוצע עסקה לפי סוג קופה"
  - "שעות שיא לפי סוג קופה"
  - "פילוח לקוחות מועדון לפי סוג קופה"
  - "מוצרים נמכרים ביותר בקופות עצמאיות"
  - "מגמת מכירות חודשית"
  - "חנויות מובילות"
  - "השוואה שנתית"
- themeClass: `theme-yohananhuf`

#### 2.10 Page component

```
src/pages/YohananhufPage.tsx
```

Follow `Zer4UPage.tsx` pattern exactly.

#### 2.11 Routing + agents index

- Add to `src/agents/index.ts` exports
- Add route in `App.tsx`
- Add to `DashboardPage.tsx` agentConfigs map

---

## Implementation Order

```
Phase 1: Data Export Setup (depends on Nir)
  ├── Send Nir the email from Part 1
  ├── Get answers to the 5 questions
  ├── Set up GCS service account / access for Nir
  └── Wait for first CSV files to land in GCS

Phase 2: Agent Shell (can start before data arrives)
  ├── Client config + page + routing
  ├── Server crew member + migration
  ├── Theme CSS
  └── Deploy — agent is live but has no data yet

Phase 3: Data Pipeline (once CSVs are in GCS)
  ├── Run scan-csv to analyze structure
  ├── Create schema + tables
  ├── Load CSV data
  ├── Create helper functions (including register_type)
  ├── Create indexes (tailored for register analysis)
  ├── Create 11 materialized views (5 register-type + 6 general)
  ├── Generate + review schema description
  └── Test end-to-end: ask questions, verify answers

Phase 4: Data Loader Integration (after task 423)
  ├── Write reload function
  ├── Register with DataReloadService
  ├── Add Cloud Scheduler trigger (04:00 AM)
  └── Verify in Data Loader dashboard
```

---

## Out of Scope

- Dashboard customization beyond standard BI page
- Historical register type changes (assume static mapping; if ranges change, update the function)
- Integration with Yohananhuf's internal systems beyond Qlik CSV export
- Custom visualizations / charts (text-based analysis only, like zer4u)
- Register-level detail dashboard (e.g., "show me register #15 transactions")

---

## Files Touched

### Server (new)

| File | Action |
|------|--------|
| `agents/yohananhuf/AGENT.md` | **Create** |
| `agents/yohananhuf/crew/index.js` | **Create** |
| `agents/yohananhuf/crew/yohananhuf.crew.js` | **Create** |
| `db/migrations/run-0XX-add-yohananhuf-agent.js` | **Create** |
| `scripts/create-yohananhuf-indexes.js` | **Create** — includes `register_type()` function |
| `scripts/create-yohananhuf-materialized-views.js` | **Create** — 11 views |
| `scripts/reload-yohananhuf-zero-downtime.js` | **Create** |
| `data/yohananhuf-schema-description.txt` | **Create** (after first load) |

### Server (modify)

| File | Action |
|------|--------|
| `server.js` | **Modify** — register yohananhuf reloader with DataReloadService |

### Client (new)

| File | Action |
|------|--------|
| `src/agents/yohananhuf.config.ts` | **Create** |
| `src/pages/YohananhufPage.tsx` | **Create** |
| `src/styles/themes/yohananhuf-theme.css` | **Create** |

### Client (modify)

| File | Action |
|------|--------|
| `src/agents/index.ts` | **Modify** — add yohananhuf export |
| `src/App.tsx` | **Modify** — add yohananhuf route |
| `src/pages/DashboardPage.tsx` | **Modify** — add to agentConfigs map |

---

## Acceptance Criteria

- [ ] Nir has received the export spec and confirmed field names + customer type values
- [ ] GCS access set up for yohananhuf exports
- [ ] First CSVs are in GCS `aspect-clients-data/yohananhuf/`
- [ ] Agent accessible at `/yohananhuf` with working chat
- [ ] Agent record exists in `agents` DB table
- [ ] `yohananhuf` schema in PostgreSQL with all tables loaded
- [ ] `register_type()` function correctly classifies all three types
- [ ] Register type analysis works: "השוואת קופות רגילות מול עצמאיות מול עגלות" returns real data
- [ ] Time-based analysis works: "שעות שיא לפי סוג קופה" returns hourly breakdown
- [ ] Customer segmentation works: "פילוח לקוחות מועדון לפי סוג קופה" returns club vs non-club split
- [ ] Product analysis works: "מוצרים נמכרים ביותר בקופות עצמאיות" returns category breakdown
- [ ] All 11 materialized views created and used by SQL generator
- [ ] Schema description generated and reviewed
- [ ] Data Loader dashboard shows yohananhuf schema (once infra task 423 is done)
- [ ] Daily auto-reload registered and scheduled (04:00 AM)

## How to Test

1. Open `/yohananhuf` — should see welcome screen with quick questions
2. Ask "השוואת מכירות בין קופות רגילות, קופות עצמאיות ועגלות חכמות" — should return three-way comparison
3. Ask "באיזה שעות יש הכי הרבה עסקאות בקופות עצמאיות" — should return hourly breakdown
4. Ask "כמה לקוחות מועדון קונים בקופות עצמאיות לעומת קופות רגילות" — should return club member split
5. Ask "מה המוצרים הנמכרים ביותר בעגלות חכמות" — should return product categories
6. Ask "ממוצע עסקה לפי סוג קופה בחודש האחרון" — should use mv_by_register_type_month
7. Open `/yohananhuf/dashboard/data-loader` — should show yohananhuf CSVs and reload history
