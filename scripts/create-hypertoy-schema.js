/**
 * Create Hyper Toy schema and tables.
 * Accepts the same `schemas` format as create-thestock-schema.js —
 * built dynamically from GCS CSV headers + column-aliases-hypertoy.js.
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');

function generateCreateTableSQL(schemaName, tableSchema) {
  const cols = tableSchema.columns.map(c => {
    const name = c.name.replace(/^﻿/, '').trim().replace(/"/g, '""');
    return `  "${name}" ${c.type} NULL`;
  });
  // Tables are LOGGED from the start (shared pattern across all agents).
  // Avoids the SET LOGGED heap rewrite at Phase 2 — silent and slow on big tables.
  return `CREATE TABLE ${schemaName}.${tableSchema.tableName} (\n${cols.join(',\n')}\n)`;
}

async function createSchema(targetSchema, schemas) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle'
        AND query LIKE '%' || $1 || '%' AND pid <> pg_backend_pid()
    `, [targetSchema]).catch(() => {});

    await client.query(`DROP SCHEMA IF EXISTS ${targetSchema} CASCADE`);
    await client.query(`CREATE SCHEMA ${targetSchema}`);

    for (const tableSchema of schemas) {
      const sql = generateCreateTableSQL(targetSchema, tableSchema);
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

module.exports = { createSchema };
