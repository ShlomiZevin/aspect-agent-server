/**
 * Task reads and writes for the Aspect board.
 *
 * Drizzle is used for the plain row work and hand-written SQL for the two
 * aggregate reads, where a set-based query is both clearer and the entire point
 * -- see listTasks() and whatsNew(). Mixing is deliberate, not drift.
 */
const { eq } = require('drizzle-orm');
const connection = require('../db/connection');
const { tasks } = require('../db/schema');
const events = require('./events.service');

const STATUSES   = ['todo', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const TYPES      = ['task', 'bug', 'feature', 'idea', 'goal', 'agenda', 'read', 'test'];

/** Fields a client may set. Anything else in the body is ignored, not trusted. */
const WRITABLE = [
  'title', 'description', 'status', 'priority', 'type', 'assignee', 'opener',
  'dueDate', 'tags', 'atRisk', 'acknowledged', 'isDraft', 'dependsOn',
];

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

/**
 * Normalises and validates a client payload.
 *
 * The database has CHECK constraints for all of this, so nothing invalid can be
 * stored either way -- but a constraint violation reaches the user as a Postgres
 * error string, and this reaches them as a sentence. The constraints stay as the
 * real guarantee; this is for the message.
 */
function clean(input, { partial = false } = {}) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(input, k);

  for (const key of WRITABLE) {
    if (!has(key)) continue;
    out[key] = input[key];
  }

  if (has('title')) {
    const title = String(out.title ?? '').trim();
    if (!title) throw new ValidationError('Title is required');
    if (title.length > 255) throw new ValidationError('Title is longer than 255 characters');
    out.title = title;
  } else if (!partial) {
    throw new ValidationError('Title is required');
  }

  if (has('description')) out.description = out.description?.trim() || null;
  if (has('assignee'))    out.assignee    = out.assignee?.trim() || null;
  if (has('opener'))      out.opener      = out.opener?.trim() || null;
  if (has('dueDate'))     out.dueDate     = out.dueDate || null;
  if (has('dependsOn'))   out.dependsOn   = out.dependsOn ?? null;

  if (has('tags')) {
    const tags = Array.isArray(out.tags) ? out.tags : [];
    // De-duplicated here rather than in the UI: a text[] has no unique
    // constraint, and duplicate chips are the kind of thing nobody reports.
    out.tags = [...new Set(tags.map(t => String(t).trim()).filter(Boolean))];
  }

  for (const [key, allowed] of [['status', STATUSES], ['priority', PRIORITIES], ['type', TYPES]]) {
    if (has(key) && !allowed.includes(out[key])) {
      throw new ValidationError(`${key} must be one of: ${allowed.join(', ')}`);
    }
  }

  for (const flag of ['atRisk', 'acknowledged', 'isDraft']) {
    if (has(flag)) out[flag] = Boolean(out[flag]);
  }

  return out;
}

/**
 * Every task, with its linked ids attached.
 *
 * The links arrive from a lateral aggregate rather than a second round trip or
 * a JSONB column: one query, one row per task, and the ids are guaranteed to
 * name tasks that exist because they come through a foreign key. The old board
 * kept them in a JSONB array that could outlive the task it pointed at.
 *
 * Links are symmetric -- "related to" has no direction -- so both ends are
 * unioned. Storing one row and reading both ways beats storing two rows that
 * can disagree.
 */
async function listTasks(filters = {}) {
  const where = [];
  const params = [];
  const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };

  if (filters.status)   add('t.status = ?', filters.status);
  if (filters.assignee) add('t.assignee = ?', filters.assignee);
  if (filters.type)     add('t.type = ?', filters.type);
  if (filters.priority) add('t.priority = ?', filters.priority);
  if (filters.tag)      add('t.tags @> ARRAY[?]::text[]', filters.tag);
  if (filters.openOnly) where.push("t.status <> 'done'");

  const { rows } = await connection.query(`
    SELECT t.*, COALESCE(l.linked, '{}') AS linked_task_ids
      FROM tasks t
      LEFT JOIN LATERAL (
        SELECT array_agg(id) AS linked FROM (
          SELECT linked_task_id AS id FROM task_links WHERE task_id = t.id
          UNION
          SELECT task_id      AS id FROM task_links WHERE linked_task_id = t.id
        ) both_ends
      ) l ON true
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.created_at DESC`, params);

  return rows.map(toApi);
}

async function getTask(id) {
  const { rows } = await connection.query(
    `SELECT t.*, COALESCE(
              (SELECT array_agg(x.id) FROM (
                 SELECT linked_task_id AS id FROM task_links WHERE task_id = t.id
                 UNION
                 SELECT task_id AS id FROM task_links WHERE linked_task_id = t.id) x),
              '{}') AS linked_task_ids
       FROM tasks t WHERE t.id = $1`, [id]);
  return rows[0] ? toApi(rows[0]) : null;
}

async function createTask(input) {
  const values = clean(input);
  const db = connection.getDb();

  const [row] = await db.insert(tasks).values(values).returning();
  if (Array.isArray(input.linkedTaskIds)) await setLinks(row.id, input.linkedTaskIds);

  const task = await getTask(row.id);
  events.emit({ type: 'task_created', task });
  return task;
}

async function updateTask(id, input) {
  const values = clean(input, { partial: true });
  const db = connection.getDb();

  if (Object.keys(values).length > 0) {
    const [row] = await db.update(tasks).set(values).where(eq(tasks.id, id)).returning();
    if (!row) return null;
  } else if (!await exists(id)) {
    return null;
  }

  if (Array.isArray(input.linkedTaskIds)) await setLinks(id, input.linkedTaskIds);

  const task = await getTask(id);
  events.emit({ type: 'task_updated', task });
  return task;
}

async function deleteTask(id) {
  const db = connection.getDb();
  const deleted = await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  if (deleted.length === 0) return false;
  // Comments, likes, acks, links and notifications go with it by cascade —
  // see the foreign keys in 001_init.sql.
  events.emit({ type: 'task_deleted', taskId: id });
  return true;
}

/**
 * Replaces a task's links with exactly `ids`.
 *
 * Written as delete-then-insert inside one transaction because the set is tiny
 * and the alternative -- diffing in JavaScript -- is more code for the same
 * result. Self-links and ids that name a missing task are dropped by the table's
 * own constraints, so a bad id from the client cannot corrupt anything.
 */
async function setLinks(taskId, ids) {
  const wanted = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n !== taskId))];
  const client = await connection.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM task_links WHERE task_id = $1 OR linked_task_id = $1`, [taskId]);
    if (wanted.length > 0) {
      await client.query(
        // `AS wanted(id)` names the COLUMN. Written as `AS id`, the alias names
        // the table instead, so the `id` in the WHERE resolves to `tasks.id`
        // from the subquery's own scope -- the test becomes tasks.id = tasks.id,
        // always true, and every id sails through to the foreign key.
        `INSERT INTO task_links (task_id, linked_task_id)
         SELECT $1, wanted.id FROM unnest($2::bigint[]) AS wanted(id)
          WHERE EXISTS (SELECT 1 FROM tasks WHERE tasks.id = wanted.id)
         ON CONFLICT DO NOTHING`, [taskId, wanted]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function exists(id) {
  const { rows } = await connection.query('SELECT 1 FROM tasks WHERE id = $1', [id]);
  return rows.length > 0;
}

async function markDeployed(id) {
  const db = connection.getDb();
  const [row] = await db.update(tasks)
    .set({ deployedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) return null;

  // A redeploy makes the task new again for everyone, so previous dismissals
  // are cleared. Emails already sent are not: nobody wants the same digest twice.
  await connection.query(`DELETE FROM task_acks WHERE task_id = $1 AND kind = 'seen'`, [id]);

  const task = await getTask(id);
  events.emit({ type: 'task_updated', task });
  return task;
}

/**
 * Deployed tasks this person has not dismissed yet.
 *
 * This is the query that used to time out. It fetched every deployed task and
 * filtered a JSONB array in JavaScript, on an endpoint polled every 10 seconds
 * per open tab. Now the "not seen by me" test is an anti-join on an indexed
 * table, and `description` is still left out because it can hold pasted base64
 * images worth hundreds of kilobytes.
 */
async function whatsNew(person) {
  if (!person) return [];
  const { rows } = await connection.query(`
    SELECT t.id, t.title, t.status, t.priority, t.type, t.assignee, t.opener,
           t.due_date, t.tags, t.deployed_at, t.created_at, t.updated_at
      FROM tasks t
     WHERE t.deployed_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM task_acks a
          WHERE a.task_id = t.id AND a.kind = 'seen' AND lower(a.person) = lower($1))
     ORDER BY t.deployed_at DESC`, [person]);
  return rows.map(toApi);
}

/** Dismisses a deployed task from one person's What's New. Idempotent. */
async function dismiss(id, person) {
  if (!person) throw new ValidationError('A name is required');
  const { rowCount } = await connection.query(
    `INSERT INTO task_acks (task_id, person, kind)
     SELECT $1, $2, 'seen' WHERE EXISTS (SELECT 1 FROM tasks WHERE id = $1)
     ON CONFLICT DO NOTHING`, [id, person]);
  // rowCount 0 means either "already dismissed" or "no such task"; the caller
  // only cares about the latter.
  return rowCount > 0 || exists(id);
}

/** snake_case row -> the camelCase shape the client already speaks. */
function toApi(row) {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    type: row.type,
    assignee: row.assignee ?? undefined,
    opener: row.opener ?? undefined,
    dueDate: row.due_date ?? undefined,
    tags: row.tags ?? [],
    atRisk: row.at_risk,
    acknowledged: row.acknowledged,
    isDraft: row.is_draft,
    dependsOn: row.depends_on == null ? undefined : Number(row.depends_on),
    linkedTaskIds: (row.linked_task_ids ?? []).map(Number),
    deployedAt: row.deployed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  listTasks, getTask, createTask, updateTask, deleteTask,
  markDeployed, whatsNew, dismiss,
  ValidationError, STATUSES, PRIORITIES, TYPES,
};
