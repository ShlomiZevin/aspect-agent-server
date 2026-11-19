/**
 * Comments on agenda lines — the meeting's action items.
 *
 * Noa, Hila and Shlomi comment on each `- [ ]` line of an action-items topic
 * (board task, type 'agenda'): on the shared page /tasks/actions and in the
 * ACTION ITEMS panel of /tasks/center. A comment points at the line's stable
 * id (`<!-- line:… -->`, stamped at the end of the line on the first comment —
 * services/agendaLines.js), so it stays with its line through ticks, notes,
 * text edits and new lines.
 *
 * `author` is the board identity (the name picked once per browser). No auth:
 * internal tool. Only the author may edit their comment; the author or Shlomi
 * may remove it — the name is sent with the request.
 *
 * Every change is broadcast on the board stream as
 *   { type: 'agenda_comment', action: 'added' | 'edited', taskId, comment }
 *   { type: 'agenda_comment', action: 'deleted', taskId, id }
 * and stamping a line id also emits the usual task_updated.
 */
const db = require('./db.pg');
const { agendaLineComments } = require('../db/schema');
const { eq, inArray, asc } = require('drizzle-orm');
const taskService = require('./task.service');
const boardEventsService = require('./boardEvents.service');

const MAX_AUTHOR = 100;
const MAX_BODY = 4000;
const MAX_TASKS = 50;
/** The action items are Shlomi's: he may remove anyone's comment (board name, lower-cased). */
const OWNER = 'shlomi';

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function cleanAuthor(author) {
  const a = typeof author === 'string' ? author.trim() : '';
  if (!a) throw fail(400, 'author is required');
  if (a.length > MAX_AUTHOR) throw fail(400, 'author is too long');
  return a;
}

function cleanBody(body) {
  const b = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trim() : '';
  if (!b) throw fail(400, 'body is required');
  if (b.length > MAX_BODY) throw fail(400, `A comment is at most ${MAX_BODY} characters`);
  return b;
}

class AgendaCommentsService {
  _db() {
    return db.getDrizzle();
  }

  /** Every comment on these topics, oldest first. */
  async list(taskIds) {
    const ids = [...new Set((taskIds || []).filter(id => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) return [];
    if (ids.length > MAX_TASKS) throw fail(400, `At most ${MAX_TASKS} topics at a time`);
    return this._db()
      .select()
      .from(agendaLineComments)
      .where(inArray(agendaLineComments.taskId, ids))
      .orderBy(asc(agendaLineComments.createdAt), asc(agendaLineComments.id));
  }

  /**
   * A new comment on one line, addressed like a tick (index AND text).
   * Returns { comment, task } — task = the topic, with the line's id stamped.
   */
  async add({ taskId, index, text, author, body }) {
    const who = cleanAuthor(author);
    const what = cleanBody(body);
    if (!Number.isInteger(taskId) || taskId <= 0) throw fail(400, 'taskId is required');

    const topic = await taskService.getTask(taskId);
    if (!topic) throw fail(404, 'Task not found');
    if (topic.type !== 'agenda') throw fail(400, 'Comments go on agenda topics only');

    const stamped = await taskService.ensureAgendaLineKey(taskId, { index, text });
    if (!stamped) throw fail(404, 'Task not found');

    const [comment] = await this._db()
      .insert(agendaLineComments)
      .values({ taskId, lineKey: stamped.key, lineText: stamped.text, author: who, body: what })
      .returning();
    boardEventsService.emit({ type: 'agenda_comment', action: 'added', taskId, comment });
    return { comment, task: stamped.task };
  }

  /** The comment, if `author` may change it: its author — or, for removing, the topic's owner (Shlomi). */
  async _own(id, author, { ownerToo = false } = {}) {
    if (!Number.isInteger(id) || id <= 0) throw fail(400, 'Invalid id');
    const who = cleanAuthor(author).toLowerCase();
    const [row] = await this._db().select().from(agendaLineComments).where(eq(agendaLineComments.id, id)).limit(1);
    if (!row) throw fail(404, 'Comment not found');
    const allowed = row.author.toLowerCase() === who || (ownerToo && who === OWNER);
    if (!allowed) throw fail(403, ownerToo ? 'Only the author or Shlomi can remove this comment' : 'Only the author can edit this comment');
    return row;
  }

  async edit(id, { author, body }) {
    const row = await this._own(id, author);
    const what = cleanBody(body);
    if (what === row.body) return row;
    const [comment] = await this._db()
      .update(agendaLineComments)
      .set({ body: what, updatedAt: new Date() })
      .where(eq(agendaLineComments.id, id))
      .returning();
    boardEventsService.emit({ type: 'agenda_comment', action: 'edited', taskId: comment.taskId, comment });
    return comment;
  }

  async remove(id, { author }) {
    const row = await this._own(id, author, { ownerToo: true });
    await this._db().delete(agendaLineComments).where(eq(agendaLineComments.id, id));
    boardEventsService.emit({ type: 'agenda_comment', action: 'deleted', taskId: row.taskId, id });
  }
}

module.exports = new AgendaCommentsService();
