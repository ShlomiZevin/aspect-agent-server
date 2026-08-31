require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env'), quiet: true });

const assert = require('assert');
const connection = require('../connection');

/**
 * Proves the 001 schema enforces what its constraints claim.
 *
 * Worth running rather than trusting: the point of moving the JSONB arrays into
 * real tables was to get referential integrity, and integrity you have not seen
 * reject something is just a comment. Everything is created inside a
 * transaction that is rolled back, so it leaves no rows behind.
 */
async function run() {
  const pool = connection.getPool();
  const c = await pool.connect();
  let passed = 0;
  const ok = name => { passed++; console.log('   ok  ' + name); };

  const rejects = async (name, sql, params) => {
    try {
      await c.query('SAVEPOINT s');
      await c.query(sql, params);
      throw new Error(`expected rejection: ${name}`);
    } catch (e) {
      if (e.message.startsWith('expected rejection')) throw e;
      await c.query('ROLLBACK TO SAVEPOINT s');
      ok(name);
    }
  };

  try {
    await c.query('BEGIN');

    const { rows: [task] } = await c.query(
      `INSERT INTO tasks (title, opener, tags) VALUES ('smoke', 'tester', '{a,b}') RETURNING *`);
    ok('a task inserts with defaults');
    assert.strictEqual(task.status, 'todo');
    assert.strictEqual(task.priority, 'medium');
    assert.deepStrictEqual(task.tags, ['a', 'b']);
    ok('defaults and text[] tags round-trip');

    await rejects('a blank title is rejected',
      `INSERT INTO tasks (title) VALUES ('   ')`);
    await rejects('an unknown status is rejected',
      `INSERT INTO tasks (title, status) VALUES ('x', 'wat')`);
    await rejects('an unknown priority is rejected',
      `INSERT INTO tasks (title, priority) VALUES ('x', 'urgent')`);
    await rejects('a task cannot depend on itself',
      `UPDATE tasks SET depends_on = id WHERE id = $1`, [task.id]);

    const { rows: [comment] } = await c.query(
      `INSERT INTO task_comments (task_id, author, body) VALUES ($1,'tester','hi') RETURNING *`,
      [task.id]);
    ok('a comment attaches to its task');

    await rejects('a blank comment body is rejected',
      `INSERT INTO task_comments (task_id, author, body) VALUES ($1,'t','  ')`, [task.id]);
    await rejects('a comment cannot name a task that does not exist',
      `INSERT INTO task_comments (task_id, author, body) VALUES (99999999,'t','x')`);

    await c.query(`INSERT INTO comment_likes (comment_id, person) VALUES ($1,'tester')`, [comment.id]);
    await rejects('the same person cannot like a comment twice',
      `INSERT INTO comment_likes (comment_id, person) VALUES ($1,'tester')`, [comment.id]);

    await c.query(`INSERT INTO task_acks (task_id, person, kind) VALUES ($1,'tester','seen')`, [task.id]);
    await rejects('an unknown ack kind is rejected',
      `INSERT INTO task_acks (task_id, person, kind) VALUES ($1,'tester','maybe')`, [task.id]);

    const { rows: [other] } = await c.query(
      `INSERT INTO tasks (title) VALUES ('smoke 2') RETURNING id`);
    await c.query(`INSERT INTO task_links (task_id, linked_task_id) VALUES ($1,$2)`, [task.id, other.id]);
    await rejects('a task cannot be linked to itself',
      `INSERT INTO task_links (task_id, linked_task_id) VALUES ($1,$1)`, [task.id]);

    await c.query(`INSERT INTO notifications (recipient, task_id, type) VALUES ('tester',$1,'comment')`,
      [task.id]);

    // updated_at is owned by the trigger. Tested by writing a deliberately wrong
    // value and checking it did not survive -- not by watching the clock: the
    // trigger uses now(), which is transaction start time, so inside this single
    // transaction a correct trigger produces no visible movement at all.
    await c.query(
      `UPDATE tasks SET title = 'smoke edited', updated_at = '2000-01-01' WHERE id = $1`,
      [task.id]);
    const { rows: [touched] } = await c.query(`SELECT updated_at FROM tasks WHERE id = $1`, [task.id]);
    assert.strictEqual(touched.updated_at.getUTCFullYear(), new Date().getUTCFullYear(),
      'the trigger let the caller set updated_at');
    ok('updated_at is owned by the trigger and overrides the caller');

    // The reason the FKs exist at all: deleting a task must take its whole tail
    // with it. The old schema had no ON DELETE and left orphans.
    await c.query(`DELETE FROM tasks WHERE id = $1`, [task.id]);
    const counts = await c.query(`
      SELECT (SELECT count(*)::int FROM task_comments  WHERE task_id = $1)    AS comments,
             (SELECT count(*)::int FROM task_acks      WHERE task_id = $1)    AS acks,
             (SELECT count(*)::int FROM task_links     WHERE task_id = $1)    AS links,
             (SELECT count(*)::int FROM notifications  WHERE task_id = $1)    AS notes,
             (SELECT count(*)::int FROM comment_likes  WHERE comment_id = $2) AS likes`,
      [task.id, comment.id]);
    assert.deepStrictEqual(counts.rows[0], { comments: 0, acks: 0, links: 0, notes: 0, likes: 0 });
    ok('deleting a task cascades to comments, likes, acks, links and notifications');

    // A linked task must survive its partner being deleted.
    const { rows: [survivor] } = await c.query(`SELECT count(*)::int AS n FROM tasks WHERE id = $1`, [other.id]);
    assert.strictEqual(survivor.n, 1);
    ok('the task on the other end of a link survives');

    console.log(`\n   ${passed} checks passed`);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await connection.close();
  }
}

run().catch(async err => {
  console.error('\nFAILED:', err.message);
  await connection.close().catch(() => {});
  process.exit(1);
});
