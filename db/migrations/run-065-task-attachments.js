#!/usr/bin/env node
/** Apply 065_task_attachments.sql (task #954) to the database in .env (or the env already set). */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const db = require('../../services/db.pg');

(async () => {
  await db.initialize();
  const sql = fs.readFileSync(path.join(__dirname, '065_task_attachments.sql'), 'utf8');
  try {
    await db.query(sql);
    console.log('✅ Migration 065 applied: task_attachments (files on board tasks, #954)');
  } catch (err) {
    console.error('❌ Migration 065 failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
