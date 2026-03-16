/**
 * Read all tasks assigned to Claude with their comments.
 *
 * Usage:
 *   node scripts/read-claude-tasks.js           # shows only in_progress (default)
 *   node scripts/read-claude-tasks.js all        # shows all statuses
 *   node scripts/read-claude-tasks.js done       # shows only done
 *
 * Output: Tasks assigned to "Claude" with full descriptions and comments,
 * formatted for easy reading in a Claude Code session.
 */
require('dotenv').config();

const db = require('../services/db.pg');

function stripHtml(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function printTask(task, commentsByTask) {
  console.log(`${'─'.repeat(60)}`);
  console.log(`TASK ${task.id}: ${task.title}`);
  console.log(`Status: ${task.status} | Created: ${new Date(task.created_at).toLocaleDateString()}`);
  console.log(`${'─'.repeat(60)}`);

  const desc = stripHtml(task.description);
  if (desc) {
    console.log(`\n${desc}\n`);
  } else {
    console.log('\n(no description)\n');
  }

  const comments = commentsByTask[task.id];
  if (comments && comments.length > 0) {
    console.log(`--- ${comments.length} comment(s) ---`);
    for (const c of comments) {
      const date = new Date(c.created_at).toLocaleDateString();
      console.log(`\n[${c.author} — ${date}]`);
      console.log(stripHtml(c.content));
    }
    console.log('');
  }
}

async function readClaudeTasks() {
  const statusFilter = process.argv[2] || 'in_progress';

  await db.initialize();

  // Fetch tasks
  const query = statusFilter === 'all'
    ? `SELECT id, title, status, description, created_at FROM tasks
       WHERE LOWER(assignee) LIKE '%claude%'
       ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, id`
    : `SELECT id, title, status, description, created_at FROM tasks
       WHERE LOWER(assignee) LIKE '%claude%' AND status = $1
       ORDER BY id`;

  const params = statusFilter === 'all' ? [] : [statusFilter];
  const tasksResult = await db.query(query, params);

  if (tasksResult.rows.length === 0) {
    console.log(`No tasks assigned to Claude with status: ${statusFilter}`);
    await db.close();
    return;
  }

  // Fetch all comments for these tasks
  const taskIds = tasksResult.rows.map(t => t.id);
  const commentsResult = await db.query(
    `SELECT task_id, author, content, created_at
     FROM task_comments
     WHERE task_id = ANY($1)
     ORDER BY task_id, created_at`,
    [taskIds]
  );

  // Group comments by task_id
  const commentsByTask = {};
  for (const c of commentsResult.rows) {
    if (!commentsByTask[c.task_id]) commentsByTask[c.task_id] = [];
    commentsByTask[c.task_id].push(c);
  }

  // Output
  const showing = statusFilter === 'all' ? 'ALL' : statusFilter.toUpperCase();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CLAUDE TASKS [${showing}] — ${tasksResult.rows.length} task(s)`);
  console.log(`${'='.repeat(60)}`);

  for (const task of tasksResult.rows) {
    printTask(task, commentsByTask);
  }

  console.log(`${'='.repeat(60)}`);
  await db.close();
}

readClaudeTasks().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
