require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const assert = require('assert');
const express = require('express');
const connection = require('../../taskboard/db/connection');

/**
 * End-to-end checks for the Aspect task board.
 *
 * Runs the real router on a real port against the real `aspect_tasks_db`, so
 * routes, services, SQL and constraints are all exercised together. Service
 * functions called directly would pass while the router quietly swallowed a
 * parameter -- which is the failure worth catching, since the routes are where
 * the ordering traps live.
 *
 *   node verification/taskboard/test-taskboard-api.js
 *
 * Needs the Cloud SQL Proxy. Everything it creates is deleted at the end,
 * including on failure: this database is shared with whoever looks at the board
 * next, and leftover rows from a test run are indistinguishable from real work.
 */
const created = { tasks: [], people: [] };
let base;
let server;
let passed = 0;

const ok = name => { passed++; console.log('   ok  ' + name); };

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, raw: text };
}

async function newTask(fields = {}) {
  const r = await api('POST', '/api/taskboard/tasks', { title: 'check', opener: 'Tester', ...fields });
  assert.strictEqual(r.status, 201, `create failed: ${r.raw}`);
  created.tasks.push(r.body.task.id);
  return r.body.task;
}

async function run() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/taskboard', require('../../taskboard/routes/taskboard.routes'));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n--- taskboard API on ${base} ---`);

  // --- create and read ------------------------------------------------------
  const task = await newTask({ description: 'body', priority: 'high', tags: ['x', 'x', ' y '] });
  assert.strictEqual(task.priority, 'high');
  assert.deepStrictEqual(task.tags, ['x', 'y']);
  ok('a task is created, and duplicate/blank tags are collapsed');

  const fetched = await api('GET', `/api/taskboard/tasks/${task.id}`);
  assert.strictEqual(fetched.body.task.title, 'check');
  ok('a task reads back by id');

  assert.strictEqual((await api('GET', '/api/taskboard/tasks/99999999')).status, 404);
  ok('a missing task is a 404, not a 500');

  // --- validation -----------------------------------------------------------
  const blank = await api('POST', '/api/taskboard/tasks', { title: '   ' });
  assert.strictEqual(blank.status, 400);
  assert.match(blank.body.error, /Title is required/);
  ok('a blank title is a 400 with a readable message');

  const badStatus = await api('POST', '/api/taskboard/tasks', { title: 'x', status: 'nope' });
  assert.strictEqual(badStatus.status, 400);
  assert.match(badStatus.body.error, /status must be one of/);
  ok('an invalid status is rejected before it reaches Postgres');

  // Fields the client is not allowed to set must be ignored, not stored.
  const sneaky = await newTask({ id: 424242, createdAt: '1999-01-01', deployedAt: '1999-01-01' });
  assert.notStrictEqual(sneaky.id, 424242);
  assert.strictEqual(sneaky.deployedAt, undefined);
  ok('unwritable fields in the body are ignored');

  // --- update ---------------------------------------------------------------
  const patched = await api('PATCH', `/api/taskboard/tasks/${task.id}`, { status: 'in_progress' });
  assert.strictEqual(patched.body.task.status, 'in_progress');
  assert.strictEqual(patched.body.task.title, 'check');
  ok('a partial update changes only what it names');

  assert.strictEqual((await api('PATCH', '/api/taskboard/tasks/99999999', { status: 'done' })).status, 404);
  ok('updating a missing task is a 404');

  // --- links ----------------------------------------------------------------
  const other = await newTask({ title: 'linked' });
  await api('PATCH', `/api/taskboard/tasks/${task.id}`, { linkedTaskIds: [other.id, 99999999] });
  const linked = await api('GET', `/api/taskboard/tasks/${task.id}`);
  assert.deepStrictEqual(linked.body.task.linkedTaskIds, [other.id]);
  ok('links are stored, and an id naming no task is dropped');

  const reverse = await api('GET', `/api/taskboard/tasks/${other.id}`);
  assert.deepStrictEqual(reverse.body.task.linkedTaskIds, [task.id]);
  ok('a link reads the same from both ends');

  // --- comments and likes ---------------------------------------------------
  const posted = await api('POST', `/api/taskboard/tasks/${task.id}/comments`,
    { author: 'Tester', body: 'first' });
  assert.strictEqual(posted.status, 201);
  const commentId = posted.body.comment.id;
  ok('a comment posts');

  const orphan = await api('POST', '/api/taskboard/tasks/99999999/comments',
    { author: 'Tester', body: 'x' });
  assert.strictEqual(orphan.status, 404);
  ok('commenting on a missing task is a 404, not a foreign-key error');

  const liked = await api('POST', `/api/taskboard/comments/${commentId}/like`, { person: 'Tester' });
  assert.deepStrictEqual(liked.body.comment.likedBy, ['Tester']);
  const unliked = await api('POST', `/api/taskboard/comments/${commentId}/like`, { person: 'Tester' });
  assert.deepStrictEqual(unliked.body.comment.likedBy, []);
  ok('liking is a toggle');

  // --- literal routes are not swallowed by /tasks/:id ------------------------
  const whatsNew = await api('GET', '/api/taskboard/tasks/whats-new?person=Tester');
  assert.strictEqual(whatsNew.status, 200);
  assert.ok(Array.isArray(whatsNew.body.tasks));
  const attention = await api('GET', '/api/taskboard/tasks/needs-attention?person=Tester');
  assert.strictEqual(attention.status, 200);
  assert.ok(Array.isArray(attention.body.taskIds));
  ok('whats-new and needs-attention resolve as literals, not as :id');

  // --- deploy / dismiss -----------------------------------------------------
  await api('POST', `/api/taskboard/tasks/${task.id}/deploy`);
  const afterDeploy = await api('GET', '/api/taskboard/tasks/whats-new?person=Tester');
  assert.ok(afterDeploy.body.tasks.some(t => t.id === task.id));
  ok('a deployed task shows in What\'s New');

  await api('POST', `/api/taskboard/tasks/${task.id}/dismiss`, { person: 'Tester' });
  const afterDismiss = await api('GET', '/api/taskboard/tasks/whats-new?person=Tester');
  assert.ok(!afterDismiss.body.tasks.some(t => t.id === task.id));
  ok('dismissing removes it for that person');

  const otherPerson = await api('GET', '/api/taskboard/tasks/whats-new?person=Someone');
  assert.ok(otherPerson.body.tasks.some(t => t.id === task.id));
  ok('dismissing does not remove it for everyone else');

  // Re-deploying makes it new again — the point of clearing 'seen' acks.
  await api('POST', `/api/taskboard/tasks/${task.id}/deploy`);
  const redeployed = await api('GET', '/api/taskboard/tasks/whats-new?person=Tester');
  assert.ok(redeployed.body.tasks.some(t => t.id === task.id));
  ok('re-deploying brings it back for someone who had dismissed it');

  // --- needs-attention semantics --------------------------------------------
  const thread = await newTask({ title: 'thread', opener: 'Alice' });
  await api('POST', `/api/taskboard/tasks/${thread.id}/comments`, { author: 'Bob', body: 'hi Alice' });

  let alice = await api('GET', '/api/taskboard/tasks/needs-attention?person=Alice');
  assert.ok(alice.body.taskIds.includes(thread.id));
  ok('the opener is flagged when someone else comments');

  let bob = await api('GET', '/api/taskboard/tasks/needs-attention?person=Bob');
  assert.ok(!bob.body.taskIds.includes(thread.id));
  ok('the person who spoke last is not flagged by their own comment');

  // Case-insensitive: names are free text typed by whoever is at the keyboard.
  const lower = await api('GET', '/api/taskboard/tasks/needs-attention?person=alice');
  assert.ok(lower.body.taskIds.includes(thread.id));
  ok('names match case-insensitively');

  // A like counts as having dealt with the thread.
  const bobComment = await api('GET', `/api/taskboard/tasks/${thread.id}/comments`);
  await api('POST', `/api/taskboard/comments/${bobComment.body.comments[0].id}/like`, { person: 'Alice' });
  alice = await api('GET', '/api/taskboard/tasks/needs-attention?person=Alice');
  assert.ok(!alice.body.taskIds.includes(thread.id));
  ok('liking the last comment clears the flag');

  // An unread 'read' task assigned to you is always waiting on you.
  const memo = await newTask({ title: 'memo', type: 'read', assignee: 'Alice' });
  alice = await api('GET', '/api/taskboard/tasks/needs-attention?person=Alice');
  assert.ok(alice.body.taskIds.includes(memo.id));
  await api('PATCH', `/api/taskboard/tasks/${memo.id}`, { acknowledged: true });
  alice = await api('GET', '/api/taskboard/tasks/needs-attention?person=Alice');
  assert.ok(!alice.body.taskIds.includes(memo.id));
  ok('an unread "read" task flags its assignee until acknowledged');

  // --- notifications --------------------------------------------------------
  const notes = await api('GET', '/api/taskboard/notifications?person=Alice');
  assert.ok(notes.body.notifications.some(n => n.taskId === thread.id));
  assert.ok(notes.body.notifications.every(n => n.taskTitle));
  ok('a comment notifies the opener, with the task title attached');

  const bobNotes = await api('GET', '/api/taskboard/notifications?person=Bob');
  assert.ok(!bobNotes.body.notifications.some(n => n.taskId === thread.id));
  ok('the comment author is not notified about themselves');

  // @mention: only names on the roster are notified, so Carol has to exist.
  await api('POST', '/api/taskboard/people', { name: 'Carol' });
  created.people.push('Carol');
  await api('POST', `/api/taskboard/tasks/${task.id}/comments`,
    { author: 'Tester', body: 'can you look at this @Carol?' });
  const carol = await api('GET', '/api/taskboard/notifications?person=Carol');
  assert.ok(carol.body.notifications.some(n => n.taskId === task.id),
    'Carol was not notified about the mention');
  ok('an @mention notifies the person named');

  await api('POST', '/api/taskboard/notifications/read', { person: 'Alice', all: true });
  const cleared = await api('GET', '/api/taskboard/notifications?person=Alice');
  assert.strictEqual(cleared.body.notifications.length, 0);
  ok('marking all read empties the bell');

  // --- filters --------------------------------------------------------------
  const open = await api('GET', '/api/taskboard/tasks?openOnly=true');
  assert.ok(open.body.tasks.every(t => t.status !== 'done'));
  ok('openOnly excludes done tasks');

  const tagged = await api('GET', '/api/taskboard/tasks?tag=y');
  assert.ok(tagged.body.tasks.some(t => t.id === task.id));
  ok('filtering by tag uses the array containment operator');

  // --- delete cascades -------------------------------------------------------
  assert.strictEqual((await api('DELETE', `/api/taskboard/tasks/${thread.id}`)).status, 200);
  assert.strictEqual((await api('GET', `/api/taskboard/tasks/${thread.id}`)).status, 404);
  const orphanNotes = await connection.query(
    'SELECT count(*)::int AS n FROM notifications WHERE task_id = $1', [thread.id]);
  assert.strictEqual(orphanNotes.rows[0].n, 0);
  created.tasks = created.tasks.filter(t => t !== thread.id);
  ok('deleting a task takes its comments and notifications with it');

  assert.strictEqual((await api('DELETE', '/api/taskboard/tasks/99999999')).status, 404);
  ok('deleting a missing task is a 404');

  console.log(`\n   ${passed} checks passed`);
}

async function cleanup() {
  try {
    if (created.tasks.length) {
      // Cascades take comments, likes, acks, links and notifications with them.
      await connection.query('DELETE FROM tasks WHERE id = ANY($1::bigint[])', [created.tasks]);
    }
    // Names used only by this run; a real person of the same name would have
    // been created by the app, not here.
    await connection.query(
      `DELETE FROM notifications WHERE recipient IN ('Tester','Alice','Bob','Someone','Carol')`);
    if (created.people.length) {
      await connection.query('DELETE FROM people WHERE name = ANY($1::text[])', [created.people]);
    }
    const left = await connection.query('SELECT count(*)::int AS n FROM tasks');
    console.log(`   cleaned up - ${left.rows[0].n} task(s) remain in the board`);
  } finally {
    server?.close();
    await connection.close();
  }
}

run()
  .then(cleanup)
  .catch(async err => {
    console.error('\nFAILED:', err.message);
    await cleanup().catch(() => {});
    process.exit(1);
  });
