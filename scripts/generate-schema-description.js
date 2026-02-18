/**
 * Generate Schema Description for AI Assistant
 * Uses Claude to analyze and describe the database schema
 */

require('dotenv').config();
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function generateSchemaDescription(schemaName = 'zer4u') {
  console.log(`🔍 Analyzing ${schemaName} schema...\n`);

  try {
    // Get all tables with column info
    const tablesResult = await pool.query(`
      SELECT
        t.table_name,
        array_agg(
          json_build_object(
            'column', c.column_name,
            'type', c.data_type,
            'nullable', c.is_nullable
          ) ORDER BY c.ordinal_position
        ) as columns
      FROM information_schema.tables t
      JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE t.table_schema = $1
      GROUP BY t.table_name
      ORDER BY t.table_name
    `, [schemaName]);

    // Get row counts
    const rowCounts = {};
    for (const table of tablesResult.rows) {
      const result = await pool.query(`SELECT count(*) as cnt FROM ${schemaName}.${table.table_name}`);
      rowCounts[table.table_name] = parseInt(result.rows[0].cnt);
    }

    const schemaData = tablesResult.rows.map(t => ({
      table: t.table_name,
      rows: rowCounts[t.table_name],
      columns: t.columns
    }));

    console.log(`📊 Found ${schemaData.length} tables\n`);
    console.log('🤖 Asking Claude to generate description...\n');

    // Ask Claude to generate description
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Analyze this database schema and create a clear, concise description for an AI assistant that will generate SQL queries.

Schema: ${schemaName}
Tables: ${JSON.stringify(schemaData, null, 2)}

Create a description that includes:
1. Overview of the schema purpose
2. Main tables with their purpose
3. Key columns and their meanings (especially codes, IDs, dates)
4. Common relationships between tables
5. Important notes (Hebrew column names, data types, etc.)

Format as clean text, suitable for injection into an AI prompt.`
      }]
    });

    const description = response.content[0].text;

    // Save to file
    const outputPath = path.join(__dirname, '..', 'data', `${schemaName}-schema-description.txt`);
    await fs.writeFile(outputPath, description, 'utf8');

    console.log('✅ Schema description generated!\n');
    console.log('═'.repeat(80));
    console.log(description);
    console.log('═'.repeat(80));
    console.log(`\n📁 Saved to: ${outputPath}\n`);

    await pool.end();
    return description;

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
}

if (require.main === module) {
  generateSchemaDescription('zer4u')
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { generateSchemaDescription };
