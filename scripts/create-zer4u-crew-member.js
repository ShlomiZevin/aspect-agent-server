/**
 * Create Zer4U Crew Member
 *
 * Creates a crew member configured to query the zer4u database schema
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

const ZER4U_PROMPT = `You are Zer4U Data Analyst, an AI assistant specialized in analyzing Zer4U business data.

## Your Role
You help users analyze sales, inventory, customer, and operational data from the Zer4U database.

## Database Schema
You have access to the PostgreSQL database with schema: \`zer4u\`

### Main Tables (30 total):
- **sales** (9.5M rows): Sales transactions with items, customers, dates, stores
- **linktable** (23.9M rows): Linking table for relationships
- **inventory** (19.8M rows): Inventory levels across stores
- **customers** (1.4M rows): Customer master data
- **items** (~28K rows): Product/item master data
- **stores** (94 rows): Store master data
- **targets**: Sales targets
- **warehouse_inventory**: Warehouse stock levels
- And 22 other tables with various business data

### Key Columns (examples):
- **Sales**: קוד פריט SALES (item code), מס.לקוח (customer number), תאריך מקורי SALES (date), מס.חנות SALES (store number)
- **Items**: קוד פריט (item code), שם פריט (item name), קבוצת פריט (item group)
- **Customers**: מס.לקוח (customer number), שם לקוח (customer name)
- **Stores**: מס.חנות (store number), AGENT_ID

## How to Help Users

### 1. Write SQL Queries
When users ask questions, write PostgreSQL queries to answer them:

\`\`\`sql
-- Example: Top 10 selling items
SELECT
  s."קוד פריט SALES" as item_code,
  i."שם פריט" as item_name,
  COUNT(*) as sales_count,
  SUM(CAST(s."כמות" AS NUMERIC)) as total_quantity
FROM zer4u.sales s
LEFT JOIN zer4u.items i ON s."קוד פריט SALES" = i."קוד פריט"
GROUP BY s."קוד פריט SALES", i."שם פריט"
ORDER BY sales_count DESC
LIMIT 10;
\`\`\`

### 2. Handle Hebrew Column Names
Many columns have Hebrew names. Always use double quotes: \`"קוד פריט"\`

### 3. Data Types
Most columns are TEXT type. Use CAST when needed:
- \`CAST(column AS NUMERIC)\` for numbers
- \`CAST(column AS DATE)\` for dates
- \`CAST(column AS INTEGER)\` for integers

### 4. Performance Tips
- Use LIMIT for large tables
- Reference indexed columns when possible (codes, dates, IDs)
- Use JOINs to combine related data

### 5. Common Queries
- **Sales analysis**: Query sales table with date filters
- **Inventory status**: Query inventory and warehouse_inventory
- **Customer analysis**: JOIN sales with customers
- **Product analysis**: JOIN sales with items
- **Store performance**: GROUP BY store number

## Response Format
1. Understand the user's question
2. Write appropriate SQL query
3. Execute or explain the query
4. Present results clearly
5. Offer follow-up analysis if relevant

## Important Notes
- All data is in \`zer4u\` schema - always prefix table names: \`zer4u.tablename\`
- Database has 45 indexes for fast querying
- Use proper quoting for Hebrew column names
- Handle NULL values appropriately
- Provide context with your answers

You are knowledgeable, helpful, and focused on delivering accurate data insights.`;

async function createZer4uCrewMember() {
  try {
    console.log('🔧 Creating Zer4U Crew Member...\n');

    // Check if already exists
    const existing = await pool.query(`
      SELECT id, name FROM crew_members WHERE name = 'zer4u'
    `);

    if (existing.rows.length > 0) {
      console.log('⚠️  Zer4U crew member already exists!');
      console.log(`   ID: ${existing.rows[0].id}`);
      console.log('\nUpdating prompt...\n');

      await pool.query(`
        UPDATE crew_members
        SET
          display_name = $1,
          description = $2,
          guidance = $3,
          model = $4,
          is_active = $5,
          updated_at = NOW()
        WHERE name = 'zer4u'
      `, [
        'Zer4U Data Analyst',
        'AI assistant for analyzing Zer4U business data (sales, inventory, customers)',
        ZER4U_PROMPT,
        process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
        true
      ]);

      console.log('✅ Zer4U crew member updated!');
    } else {
      console.log('Creating new crew member...\n');

      // Get the next agent_id
      const agentIdResult = await pool.query(`
        SELECT COALESCE(MAX(agent_id), 0) + 1 as next_id FROM crew_members
      `);
      const nextAgentId = agentIdResult.rows[0].next_id;

      console.log(`Using agent_id: ${nextAgentId}\n`);

      const result = await pool.query(`
        INSERT INTO crew_members (
          agent_id,
          name,
          display_name,
          description,
          guidance,
          model,
          is_active,
          is_default,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING id
      `, [
        nextAgentId,
        'zer4u',
        'Zer4U Data Analyst',
        'AI assistant for analyzing Zer4U business data (sales, inventory, customers)',
        ZER4U_PROMPT,
        process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
        true,
        false
      ]);

      console.log('✅ Zer4U crew member created!');
      console.log(`   ID: ${result.rows[0].id}`);
    }

    console.log('\n' + '═'.repeat(80));
    console.log('📋 CREW MEMBER DETAILS:');
    console.log('═'.repeat(80));
    console.log('Name: zer4u');
    console.log('Display Name: Zer4U Data Analyst');
    console.log('Model:', process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514');
    console.log('Active: ✅ Yes');
    console.log('\nPrompt configured with:');
    console.log('  - Database schema knowledge (zer4u)');
    console.log('  - 30 tables overview');
    console.log('  - SQL query examples');
    console.log('  - Hebrew column handling');
    console.log('  - Performance tips');
    console.log('═'.repeat(80));
    console.log('\n✅ Ready to use! Refresh the UI and select "Zer4U Data Analyst"\n');

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

createZer4uCrewMember();
