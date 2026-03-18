/**
 * Create (or update) a task in the DB.
 *
 * Generic, reusable script — accepts task data via CLI args or env.
 * Safe to re-run — updates the existing task if title already exists.
 *
 * Usage:
 *   node scripts/create-task.js --title "My Task" --assignee "Noa" --type "read" --priority "high" --description "<p>Details</p>"
 *
 * All flags (all optional except --title):
 *   --title        Task title (required)
 *   --description  HTML description
 *   --status       todo | in_progress | done (default: todo)
 *   --priority     low | medium | high | critical (default: medium)
 *   --type         task | feature | bug | idea | goal | agenda | read (default: task)
 *   --domain       general | freeda | banking | aspect | etc. (default: general)
 *   --assignee     Person name
 *   --opener       Who opened it (default: same as assignee)
 *   --tags         Comma-separated tags
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      result[key] = args[++i];
    }
  }
  return result;
}

const args = parseArgs();

if (!args.title) {
  console.error('Usage: node scripts/create-task.js --title "Task Title" [--assignee "Name"] [--type "task"] ...');
  process.exit(1);
}

const TASK = {
  title: args.title,
  description: args.description || '',
  status: args.status || 'todo',
  priority: args.priority || 'medium',
  type: args.type || 'task',
  domain: args.domain || 'general',
  assignee: args.assignee || null,
  opener: args.opener || args.assignee || null,
  tags: args.tags ? args.tags.split(',').map(t => t.trim()) : [],
};

async function createTask() {
  try {
    console.log(`Creating task: "${TASK.title}"...\n`);

    const existing = await pool.query(
      `SELECT id FROM tasks WHERE title = $1`,
      [TASK.title]
    );

    if (existing.rows.length > 0) {
      const id = existing.rows[0].id;
      console.log(`Task already exists (ID: ${id}). Updating...`);

      await pool.query(
        `UPDATE tasks SET
          description = $1, status = $2, priority = $3, type = $4,
          domain = $5, assignee = $6, opener = $7, created_by = $8,
          tags = $9, updated_at = NOW()
        WHERE id = $10`,
        [
          TASK.description, TASK.status, TASK.priority, TASK.type,
          TASK.domain, TASK.assignee, TASK.opener, TASK.opener,
          JSON.stringify(TASK.tags), id,
        ]
      );
      console.log(`Task #${id} updated.`);
    } else {
      const result = await pool.query(
        `INSERT INTO tasks (
          title, description, status, priority, type, domain,
          assignee, opener, created_by, tags,
          is_draft, is_completed, at_risk, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
        RETURNING id`,
        [
          TASK.title, TASK.description, TASK.status, TASK.priority,
          TASK.type, TASK.domain, TASK.assignee, TASK.opener, TASK.opener,
          JSON.stringify(TASK.tags), false, false, false,
        ]
      );
      console.log(`Task created! ID: ${result.rows[0].id}`);
    }

    console.log(`  Title:    ${TASK.title}`);
    console.log(`  Assignee: ${TASK.assignee || '—'}`);
    console.log(`  Type:     ${TASK.type}`);
    console.log(`  Priority: ${TASK.priority}`);

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

createTask();
