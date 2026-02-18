/**
 * SQL Helper Service
 *
 * Generic service that translates natural language questions to SQL queries
 * Uses Claude with customer schema descriptions
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

/**
 * Translate a natural language question to SQL query
 * @param {string} question - Natural language question
 * @param {string} schemaName - Database schema name (e.g., 'zer4u')
 * @returns {Promise<{query: string, explanation: string}>}
 */
async function translateQuestionToSQL(question, schemaName) {
  try {
    // Load schema description
    const schemaDescPath = path.join(__dirname, '..', 'data', `${schemaName}-schema-description.txt`);
    const schemaDescription = await fs.readFile(schemaDescPath, 'utf8');

    // Ask Claude to generate SQL
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a SQL expert. Generate a PostgreSQL query to answer this question.

QUESTION: ${question}

DATABASE SCHEMA:
${schemaDescription}

IMPORTANT RULES:
1. Always use schema prefix: ${schemaName}.table_name
2. Hebrew column names MUST be in double quotes: "${schemaName}.sales"."קוד פריט"
3. Cast text columns when needed: CAST(column AS NUMERIC)
4. Use LIMIT to avoid huge result sets (max 1000 rows)
5. Handle NULLs appropriately
6. Return only valid PostgreSQL syntax

RESPONSE FORMAT:
Return a JSON object with:
{
  "query": "SELECT ...",
  "explanation": "This query does X by Y..."
}

Only return the JSON, nothing else.`
      }]
    });

    const responseText = response.content[0].text.trim();

    // Extract JSON (handle markdown code blocks)
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.split('```json')[1].split('```')[0].trim();
    } else if (responseText.includes('```')) {
      jsonText = responseText.split('```')[1].split('```')[0].trim();
    }

    const result = JSON.parse(jsonText);

    return {
      query: result.query,
      explanation: result.explanation
    };

  } catch (error) {
    console.error('SQL translation error:', error.message);
    throw new Error(`Failed to translate question to SQL: ${error.message}`);
  }
}

/**
 * Execute SQL query and return results
 * @param {string} query - SQL query to execute
 * @param {number} maxRows - Maximum rows to return (default 1000)
 * @returns {Promise<Array>}
 */
async function executeQuery(query, maxRows = 1000) {
  try {
    // Add LIMIT if not present
    const limitedQuery = query.toUpperCase().includes('LIMIT')
      ? query
      : `${query} LIMIT ${maxRows}`;

    const result = await pool.query(limitedQuery);
    return result.rows;

  } catch (error) {
    console.error('Query execution error:', error.message);
    throw new Error(`Failed to execute query: ${error.message}`);
  }
}

/**
 * Main function: Question → SQL → Data
 * @param {string} question - Natural language question
 * @param {string} schemaName - Database schema name
 * @returns {Promise<{data: Array, query: string, explanation: string}>}
 */
async function fetchDataForQuestion(question, schemaName) {
  console.log(`📊 Processing question for ${schemaName}:`, question);

  const { query, explanation } = await translateQuestionToSQL(question, schemaName);

  console.log('🔍 Generated SQL:', query);
  console.log('💡 Explanation:', explanation);

  const data = await executeQuery(query);

  console.log(`✅ Fetched ${data.length} rows`);

  return { data, query, explanation };
}

module.exports = {
  translateQuestionToSQL,
  executeQuery,
  fetchDataForQuestion
};
