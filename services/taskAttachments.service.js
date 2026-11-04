/**
 * Files attached to a LYBI board task (task #954). Stored in the database
 * (db/migrations/065_task_attachments.sql). Used by the board's routes in
 * server.js and by the Builder MCP, so a file Codex attaches and one
 * dropped on the board are the same thing.
 */

const db = require('./db.pg');

const MAX_BYTES = 25 * 1024 * 1024;

const ROW = `id, task_id AS "taskId", file_name AS "fileName", mime_type AS "mimeType",
  size_bytes AS "sizeBytes", uploaded_by AS "uploadedBy", created_at AS "createdAt"`;

/** A task's files, oldest first, without their bytes. */
async function list(taskId) {
  const r = await db.query(`SELECT ${ROW} FROM task_attachments WHERE task_id = $1 ORDER BY created_at, id`, [taskId]);
  return r.rows;
}

/**
 * Attach a file. Throws a message fit to show when it is empty, too big,
 * or the task does not exist.
 */
async function add(taskId, { fileName, mimeType, buffer, uploadedBy }) {
  const name = String(fileName || '').trim();
  if (!name) throw new Error('The file needs a name.');
  if (!buffer || !buffer.length) throw new Error('The file is empty.');
  if (buffer.length > MAX_BYTES) throw new Error(`"${name}" is ${(buffer.length / 1048576).toFixed(1)} MB — the limit is 25 MB.`);
  const task = await db.query('SELECT 1 FROM tasks WHERE id = $1', [taskId]);
  if (!task.rows.length) throw new Error(`No task #${taskId}.`);
  const r = await db.query(
    `INSERT INTO task_attachments (task_id, file_name, mime_type, size_bytes, data, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${ROW}`,
    [taskId, name, mimeType || 'application/octet-stream', buffer.length, buffer, uploadedBy || null]);
  return r.rows[0];
}

/** One file with its bytes, or null. */
async function get(taskId, id) {
  const r = await db.query(`SELECT ${ROW}, data FROM task_attachments WHERE task_id = $1 AND id = $2`, [taskId, id]);
  return r.rows[0] || null;
}

/** Remove a file. Returns its name, or null when there was none. */
async function remove(taskId, id) {
  const r = await db.query('DELETE FROM task_attachments WHERE task_id = $1 AND id = $2 RETURNING file_name', [taskId, id]);
  return r.rows[0]?.file_name ?? null;
}

module.exports = { MAX_BYTES, list, add, get, remove };
