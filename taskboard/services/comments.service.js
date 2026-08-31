/**
 * Comments, likes, and the "needs your attention" query.
 *
 * The attention query is the reason this file is worth reading. The old board
 * computed it by loading every comment and every task into memory and grouping
 * them in JavaScript, on an endpoint polled every 10 seconds per open tab. It is
 * a set problem, so it is solved here as one.
 */
const connection = require('../db/connection');
const events = require('./events.service');

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

/** A task's comments, oldest first, each carrying who liked it. */
async function listComments(taskId) {
  const { rows } = await connection.query(`
    SELECT c.id, c.task_id, c.author, c.body, c.created_at, c.updated_at,
           COALESCE(
             (SELECT array_agg(l.person ORDER BY l.created_at)
                FROM comment_likes l WHERE l.comment_id = c.id),
             '{}') AS liked_by
      FROM task_comments c
     WHERE c.task_id = $1
     ORDER BY c.created_at`, [taskId]);
  return rows.map(toApi);
}

async function addComment(taskId, author, body) {
  if (!author?.trim()) throw new ValidationError('Author is required');
  if (!body?.trim())   throw new ValidationError('Comment body is required');

  const { rows } = await connection.query(
    `INSERT INTO task_comments (task_id, author, body)
     SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM tasks WHERE id = $1)
     RETURNING *`, [taskId, author.trim(), body.trim()]);

  // No row means the task is gone. Reported as not-found rather than as a
  // foreign-key error, which is what the bare INSERT would have produced.
  if (rows.length === 0) return null;

  const comment = toApi({ ...rows[0], liked_by: [] });
  await notifyAbout(taskId, comment);
  events.emit({ type: 'comment_added', taskId, comment });
  return comment;
}

async function deleteComment(commentId) {
  const { rowCount } = await connection.query(
    'DELETE FROM task_comments WHERE id = $1', [commentId]);
  if (rowCount === 0) return false;
  events.emit({ type: 'comment_deleted', commentId });
  return true;
}

/**
 * Toggles one person's like. Returns the comment, or null if it is gone.
 *
 * The delete-then-insert pair is two statements rather than one because "toggle"
 * has no single-statement form; they are ordered so the worst case is a like
 * that does not appear, never a duplicate — the primary key forbids that anyway.
 */
async function toggleLike(commentId, person) {
  if (!person?.trim()) throw new ValidationError('A name is required');
  const name = person.trim();

  const { rowCount: removed } = await connection.query(
    'DELETE FROM comment_likes WHERE comment_id = $1 AND person = $2', [commentId, name]);

  if (removed === 0) {
    const { rowCount: added } = await connection.query(
      `INSERT INTO comment_likes (comment_id, person)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM task_comments WHERE id = $1)
       ON CONFLICT DO NOTHING`, [commentId, name]);
    if (added === 0) return null;
  }

  const { rows } = await connection.query(`
    SELECT c.*, COALESCE(
             (SELECT array_agg(l.person ORDER BY l.created_at)
                FROM comment_likes l WHERE l.comment_id = c.id), '{}') AS liked_by
      FROM task_comments c WHERE c.id = $1`, [commentId]);
  if (rows.length === 0) return null;

  const comment = toApi(rows[0]);
  events.emit({ type: 'comment_updated', taskId: comment.taskId, comment });
  return comment;
}

/**
 * Task ids that are waiting on this person.
 *
 * A task needs your attention when someone else has spoken after you last did,
 * on a thread you are part of -- you opened it, or you have commented on it.
 * Unread 'read' tasks assigned to you count too, since that is what the type is
 * for.
 *
 * "Last did" includes liking, not only commenting: a like is how people
 * acknowledge a comment here, and ignoring it meant a thread stayed flagged
 * after it had been dealt with.
 *
 * Names are compared case-insensitively because they are free text typed by
 * whoever is at the keyboard, and "Noa" and "noa" are the same person.
 */
async function needsAttention(person) {
  if (!person) return [];

  const { rows } = await connection.query(`
    WITH me AS (SELECT lower($1::text) AS name),
    -- The last time I touched each thread, by comment or by like.
    my_last AS (
      SELECT task_id, max(at) AS at FROM (
        SELECT c.task_id, c.created_at AS at
          FROM task_comments c, me WHERE lower(c.author) = me.name
        UNION ALL
        SELECT c.task_id, l.created_at AS at
          FROM comment_likes l
          JOIN task_comments c ON c.id = l.comment_id, me
         WHERE lower(l.person) = me.name
      ) touches GROUP BY task_id
    ),
    last_comment AS (
      SELECT DISTINCT ON (task_id) task_id, author
        FROM task_comments ORDER BY task_id, created_at DESC
    )
    SELECT t.id
      FROM tasks t
      JOIN last_comment lc ON lc.task_id = t.id
      LEFT JOIN my_last m  ON m.task_id  = t.id, me
     WHERE lower(lc.author) <> me.name
       AND (lower(t.opener) = me.name OR m.task_id IS NOT NULL)
       AND EXISTS (
         SELECT 1 FROM task_comments c
          WHERE c.task_id = t.id
            AND lower(c.author) <> me.name
            AND (m.at IS NULL OR c.created_at > m.at))
    UNION
    SELECT t.id
      FROM tasks t, me
     WHERE t.type = 'read' AND NOT t.acknowledged AND lower(t.assignee) = me.name`,
    [person]);

  return rows.map(r => Number(r.id));
}

/**
 * Notifications for a new comment: everyone @mentioned, plus the assignee, the
 * opener, and anyone who has commented before -- minus the author, who does not
 * need telling about their own message.
 *
 * Written as one INSERT..SELECT so the recipient set is computed by the database
 * rather than assembled with a query per candidate, which is what the old
 * version did.
 */
async function notifyAbout(taskId, comment) {
  const mentioned = [...comment.body.matchAll(/@([\wא-ת'-]+)/g)].map(m => m[1]);

  await connection.query(`
    INSERT INTO notifications (recipient, task_id, comment_id, type)
    -- Cast both ids explicitly: a bare $n in a SELECT list has no surrounding
    -- expression to infer from, so Postgres types it as text and the INSERT
    -- fails on a column it would have accepted anywhere else.
    SELECT DISTINCT r.name, $1::bigint, $2::bigint, 'comment'
      FROM (
        SELECT t.assignee AS name FROM tasks t WHERE t.id = $1 AND t.assignee IS NOT NULL
        UNION
        SELECT t.opener        FROM tasks t WHERE t.id = $1 AND t.opener IS NOT NULL
        UNION
        SELECT c.author        FROM task_comments c WHERE c.task_id = $1
        UNION
        -- AS m(name) again names the COLUMN, not the table. A bare AS m makes
        -- m a whole-row reference, which lower() cannot take.
        SELECT p.name FROM people p
          WHERE lower(p.name) = ANY(SELECT lower(m.name) FROM unnest($4::text[]) AS m(name))
      ) r
     WHERE lower(r.name) <> lower($3)`,
    [taskId, comment.id, comment.author, mentioned]);
}

function toApi(row) {
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    author: row.author,
    body: row.body,
    likedBy: row.liked_by ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  listComments, addComment, deleteComment, toggleLike, needsAttention, ValidationError,
};
