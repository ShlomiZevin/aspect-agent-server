/**
 * Read all tasks assigned to Claude with their comments.
 *
 * Usage: node scripts/read-claude-tasks.js
 *
 * Output: All tasks assigned to "Claude" with full descriptions and comments,
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

async function readClaudeTasks() {
  await db.initialize();

  // Fetch tasks
  const tasksResult = await db.query(
    `SELECT id, title, status, description, created_at, updated_at
     FROM tasks
     WHERE LOWER(assignee) LIKE '%claude%'
     ORDER BY id`
  );

  if (tasksResult.rows.length === 0) {
    console.log('No tasks assigned to Claude.');
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
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CLAUDE TASKS — ${tasksResult.rows.length} task(s) found`);
  console.log(`${'='.repeat(60)}\n`);

  for (const task of tasksResult.rows) {
    console.log(`${'─'.repeat(60)}`);
    console.log(`TASK ${task.id}: ${task.title}`);
    console.log(`Status: ${task.status}`);
    console.log(`Created: ${new Date(task.created_at).toLocaleDateString()}`);
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

  console.log(`${'='.repeat(60)}`);
  await db.close();
}

readClaudeTasks().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
