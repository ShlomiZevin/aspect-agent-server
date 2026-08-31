/**
 * Who can be assigned work, and their unread notifications.
 *
 * People are identified by the name they type, with no accounts behind it --
 * the same trust model the board has always had. It is written down here rather
 * than left implicit because it is the thing that changes when the Google-auth
 * work lands, and this is the file that will have to change.
 */
const connection = require('../db/connection');

const DEFAULTS = ['Kosta', 'Shlomi', 'Vladimir'];

/** Active people, alphabetically. */
async function list() {
  const { rows } = await connection.query(
    'SELECT name, active, created_at FROM people WHERE active ORDER BY name');
  return rows.map(r => ({ name: r.name, createdAt: r.created_at }));
}

async function add(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('A name is required');

  // Re-adding someone who was deactivated brings them back rather than failing,
  // which is what whoever typed the name meant.
  const { rows } = await connection.query(
    `INSERT INTO people (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET active = true
     RETURNING name, created_at`, [clean]);
  return { name: rows[0].name, createdAt: rows[0].created_at };
}

/**
 * Deactivates instead of deleting. Their name is already written onto tasks and
 * comments as plain text; removing the row would leave those pointing at nobody.
 */
async function deactivate(name) {
  const { rowCount } = await connection.query(
    'UPDATE people SET active = false WHERE name = $1', [name]);
  return rowCount > 0;
}

/** Seeds the starting roster. No-op once anyone exists. */
async function seed() {
  const { rows } = await connection.query('SELECT count(*)::int AS n FROM people');
  if (rows[0].n > 0) return 0;
  await connection.query(
    `INSERT INTO people (name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [DEFAULTS]);
  return DEFAULTS.length;
}

// --- notifications ----------------------------------------------------------

/** Unread notifications for one person, newest first. */
async function notifications(recipient, { limit = 50 } = {}) {
  if (!recipient) return [];
  const { rows } = await connection.query(`
    SELECT n.id, n.task_id, n.comment_id, n.type, n.is_read, n.created_at,
           t.title AS task_title, t.status AS task_status
      FROM notifications n
      JOIN tasks t ON t.id = n.task_id
     WHERE lower(n.recipient) = lower($1) AND NOT n.is_read
     ORDER BY n.created_at DESC
     LIMIT $2`, [recipient, limit]);

  return rows.map(r => ({
    id: Number(r.id),
    taskId: Number(r.task_id),
    commentId: r.comment_id == null ? undefined : Number(r.comment_id),
    type: r.type,
    taskTitle: r.task_title,
    taskStatus: r.task_status,
    createdAt: r.created_at,
  }));
}

async function markRead(ids, recipient) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  // Scoped to the recipient so one person cannot clear another's bell.
  const { rowCount } = await connection.query(
    `UPDATE notifications SET is_read = true
      WHERE id = ANY($1::bigint[]) AND lower(recipient) = lower($2)`,
    [ids.map(Number), recipient]);
  return rowCount;
}

async function markAllRead(recipient) {
  const { rowCount } = await connection.query(
    `UPDATE notifications SET is_read = true
      WHERE lower(recipient) = lower($1) AND NOT is_read`, [recipient]);
  return rowCount;
}

module.exports = { list, add, deactivate, seed, notifications, markRead, markAllRead };
