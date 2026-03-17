/**
 * Create (or update) a task in the DB.
 *
 * Generic, reusable script for inserting tasks directly into the task board.
 * Safe to re-run — updates the existing task if title already exists.
 *
 * Usage:
 *   node scripts/create-task.js
 *
 * Customize the TASK config object below before running.
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

// ─────────────────────────────────────────────
// TASK CONFIGURATION — edit this before running
// ─────────────────────────────────────────────
const TASK = {
  title: 'Add Claude KB Support via Anthropic Files API',

  // status: 'todo' | 'in_progress' | 'done'
  status: 'todo',

  // priority: 'low' | 'medium' | 'high' | 'critical'
  priority: 'medium',

  // type: 'feature' | 'bug' | 'task' | 'idea' | 'agenda'
  type: 'feature',

  // domain: 'general' | 'freeda' | 'banking' | 'aspect' | etc.
  domain: 'general',

  // assignee: name of person or 'Claude'
  assignee: 'Kosta',

  // opener: name of the person opening the task (shown on card)
  opener: 'Shlomi',

  // tags: array of strings shown as chips on the card
  tags: ['kb', 'claude', 'anthropic'],

  description: `<p>OpenAI and Google have native KB/vector store support. Claude doesn't — so we mimic it using the <strong>Anthropic Files API</strong>: upload files once, inject them as document blocks at inference time. No semantic retrieval; Claude reads all files in context.</p>

<p><strong>Full spec + implementation steps:</strong> <code>tasks/claude-kb-files-api.md</code> in the repo root. Read that first — it lists every file to touch and why.</p>

<p><strong>How to verify when done:</strong></p>
<p>1. <strong>Upload a file and ask about it</strong><br>
Create a KB with provider = Anthropic. Upload a text file with a unique fact (e.g. "The magic number is 4872"). Attach that KB to a crew using a Claude model. Ask the crew about that fact.<br>
→ Claude should answer correctly from the file.</p>

<p>2. <strong>Works without KB too</strong><br>
Send a normal message to the same crew without needing the KB.<br>
→ Conversation works normally, no errors.</p>

<p>3. <strong>No regression on other providers</strong><br>
Have a quick chat with an OpenAI-based crew with KB, and a Gemini-based crew with KB.<br>
→ Both behave exactly as before.</p>`,
};
// ─────────────────────────────────────────────

async function createTask() {
  try {
    console.log(`🔧 Creating task: "${TASK.title}"...\n`);

    const existing = await pool.query(
      `SELECT id FROM tasks WHERE title = $1`,
      [TASK.title]
    );

    if (existing.rows.length > 0) {
      const id = existing.rows[0].id;
      console.log(`⚠️  Task already exists (ID: ${id}). Updating...`);

      await pool.query(
        `UPDATE tasks SET
          description = $1,
          status = $2,
          priority = $3,
          type = $4,
          domain = $5,
          assignee = $6,
          opener = $7,
          created_by = $8,
          tags = $9,
          updated_at = NOW()
        WHERE id = $10`,
        [
          TASK.description,
          TASK.status,
          TASK.priority,
          TASK.type,
          TASK.domain,
          TASK.assignee,
          TASK.opener,
          TASK.opener,
          JSON.stringify(TASK.tags),
          id,
        ]
      );

      console.log(`✅ Task #${id} updated.`);
    } else {
      const result = await pool.query(
        `INSERT INTO tasks (
          title, description, status, priority, type, domain,
          assignee, opener, created_by, tags,
          is_draft, is_completed, at_risk,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
        RETURNING id`,
        [
          TASK.title,
          TASK.description,
          TASK.status,
          TASK.priority,
          TASK.type,
          TASK.domain,
          TASK.assignee,
          TASK.opener,
          TASK.opener,      // created_by — same as opener (mirrors how browser tasks work)
          JSON.stringify(TASK.tags),
          false,            // is_draft
          false,            // is_completed
          false,            // at_risk
        ]
      );

      console.log(`✅ Task created! ID: ${result.rows[0].id}`);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('📋 TASK:');
    console.log('═'.repeat(60));
    console.log(`Title:    ${TASK.title}`);
    console.log(`Status:   ${TASK.status}`);
    console.log(`Priority: ${TASK.priority}`);
    console.log(`Type:     ${TASK.type}`);
    console.log(`Domain:   ${TASK.domain}`);
    console.log(`Assignee: ${TASK.assignee}`);
    console.log(`Opener:   ${TASK.opener}`);
    console.log(`Tags:     ${TASK.tags.join(', ')}`);
    console.log('═'.repeat(60) + '\n');

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

createTask();
