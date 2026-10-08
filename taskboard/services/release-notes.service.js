/**
 * Customer release notes (task #102).
 *
 * The note is written on the task (Hebrew headline + body), Shlomi marks the
 * task as customer-relevant and publishes it from the board, and the
 * Intelligence Center shows each customer user what was published since their
 * own last visit.
 *
 * Two audiences, deliberately kept apart:
 *   - publish()          board side -- moves marked, finished notes to published.
 *   - unseen()/markSeen() customer side -- returns ONLY the headline, the body
 *     and the publish time. Never the task's title, description, assignee or
 *     id: those are internal and can name the customer who asked for it.
 *
 * General only for now: every published note reaches every customer.
 */
const connection = require('../db/connection');
const events = require('./events.service');
const tasksService = require('./tasks.service');

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

/** The popup is a short list; a long backlog is cut rather than scrolled forever. */
const MAX_NOTES = 30;

/**
 * Publishes the given tasks' notes to customers.
 *
 * Only a task that is marked for customers, Done, has a headline and is not
 * already published moves; anything else is reported back as skipped rather
 * than failing the whole batch, so one half-written note cannot block the rest.
 */
async function publish(taskIds) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) throw new ValidationError('No tasks to publish');

  // Truncated to milliseconds: the customer's watermark comes back from a JS
  // Date, which has no microseconds, and an untruncated stamp would always be
  // "after" its own watermark -- the newest note would reappear forever.
  const { rows } = await connection.query(
    `UPDATE tasks SET note_published_at = date_trunc('milliseconds', now())
      WHERE id = ANY($1::bigint[])
        AND customer_note
        AND status = 'done'
        AND btrim(coalesce(note_headline, '')) <> ''
        AND note_published_at IS NULL
      RETURNING id`, [ids]);

  const published = rows.map(r => Number(r.id));
  for (const id of published) {
    const task = await tasksService.getTask(id);
    if (task) events.emit({ type: 'task_updated', task });
  }
  return { published, skipped: ids.filter(id => !published.includes(id)) };
}

function cleanUserId(userId) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id) throw new ValidationError('userId is required');
  if (id.length > 100) throw new ValidationError('userId is too long');
  return id;
}

/**
 * Notes published since this user last pressed "got it", newest first.
 *
 * A user seen for the first time gets a watermark at "now" and an empty list:
 * a new user starts with nothing to catch up on (Shlomi, 2026-10-08).
 */
async function unseen(userId) {
  const id = cleanUserId(userId);
  await connection.query(
    `INSERT INTO customer_note_seen (user_id, seen_until) VALUES ($1, now())
     ON CONFLICT (user_id) DO NOTHING`, [id]);

  const { rows } = await connection.query(
    `SELECT t.note_headline, t.note_body, t.note_published_at
       FROM tasks t, customer_note_seen s
      WHERE s.user_id = $1
        AND t.customer_note
        AND t.note_published_at > s.seen_until
        AND btrim(coalesce(t.note_headline, '')) <> ''
      ORDER BY t.note_published_at DESC
      LIMIT ${MAX_NOTES}`, [id]);

  return rows.map(r => ({
    headline: r.note_headline,
    body: r.note_body ?? null,
    publishedAt: r.note_published_at,
  }));
}

/**
 * Moves the user's watermark to `until` -- the newest note they were shown, not
 * "now", so a note published while the popup was open still shows next time.
 * Never moves backwards and never past the present.
 */
async function markSeen(userId, until) {
  const id = cleanUserId(userId);
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) throw new ValidationError('until must be a date');

  await connection.query(
    `INSERT INTO customer_note_seen (user_id, seen_until) VALUES ($1, LEAST($2::timestamptz, now()))
     ON CONFLICT (user_id) DO UPDATE
       SET seen_until = GREATEST(customer_note_seen.seen_until, LEAST($2::timestamptz, now()))`,
    [id, at.toISOString()]);
}

module.exports = { publish, unseen, markSeen, ValidationError };
