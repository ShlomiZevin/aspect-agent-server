const db = require('./db.pg');
const { tasks, taskAssignees } = require('../db/schema');
const { eq, desc, and, or, gt, lt, ilike, isNull, isNotNull, notInArray, sql } = require('drizzle-orm');
const notificationsService = require('./notifications.service');
const boardEventsService = require('./boardEvents.service');
const emailScheduler = require('./emailScheduler.service');
const { sendBlockerAlertEmail } = require('./email.service');

// Priority "blocker" (above critical) means "fix right now": the moment a task
// is opened as, or raised to, Blocker, this person gets an immediate email.
const BLOCKER_PRIORITY = 'blocker';
const BLOCKER_RECIPIENT = 'Shlomi';

// Sidebar items, never shipped — kept out of the Release list and What's New.
const NON_RELEASE_TYPES = ['goal', 'agenda'];

// A team member's first What's New shows this many of the latest releases.
const WHATS_NEW_START = 25;

// ─── Agenda checklist lines (used by updateAgendaLine) ─────────────────
const AGENDA_CHECK_RE = /^(\s*)[-*] \[( |x|X)\] ?(.*)$/;
const AGENDA_QUOTE_RE = /^\s*>/;
const AGENDA_NOTE_RE = /^\s*>\s*הערה:/;
const AGENDA_NOTE_PREFIX = '  > הערה: ';
const AGENDA_INDENTED_RE = /^\s+\S/; // a point's indented "  - detail" lines

/**
 * Pure: returns the new description with one checklist line changed.
 * Throws { status: 409 } when the line can't be found safely.
 */
function applyAgendaLineChange(description, { index, text, checked, note }) {
  const eol = description.includes('\r\n') ? '\r\n' : '\n';
  const lines = description.split(/\r?\n/);
  const items = []; // { lineNo, text }
  lines.forEach((line, lineNo) => {
    const m = line.match(AGENDA_CHECK_RE);
    if (m) items.push({ lineNo, text: m[3].trim() });
  });

  const want = text.trim();
  let target = items[index] && items[index].text === want ? items[index] : null;
  if (!target) {
    const same = items.filter(it => it.text === want);
    if (same.length === 1) target = same[0];
  }
  if (!target) {
    const err = new Error('That line moved or changed — reload the agenda');
    err.status = 409;
    throw err;
  }

  const out = lines.slice();
  if (checked !== undefined) {
    out[target.lineNo] = out[target.lineNo].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
  }

  if (note !== undefined) {
    // New notes go right after the quotes under the point (before its
    // indented "  - " detail lines); an existing note is found anywhere in the
    // point's own block (quotes + indented lines that are not checklist lines).
    let end = target.lineNo + 1;
    while (end < out.length && AGENDA_QUOTE_RE.test(out[end])) end++;
    let blockEnd = target.lineNo + 1;
    while (blockEnd < out.length && (AGENDA_QUOTE_RE.test(out[blockEnd]) || (AGENDA_INDENTED_RE.test(out[blockEnd]) && !AGENDA_CHECK_RE.test(out[blockEnd])))) blockEnd++;
    let noteAt = -1;
    for (let i = target.lineNo + 1; i < blockEnd; i++) {
      if (AGENDA_NOTE_RE.test(out[i])) { noteAt = i; break; }
    }
    const clean = typeof note === 'string' ? note.replace(/\s*\r?\n\s*/g, ' ').trim() : '';
    if (clean) {
      const noteLine = AGENDA_NOTE_PREFIX + clean;
      if (noteAt >= 0) out[noteAt] = noteLine;
      else out.splice(end, 0, noteLine);
    } else if (noteAt >= 0) {
      out.splice(noteAt, 1);
    }
  }

  return out.join(eol);
}

/**
 * Task Board Service
 *
 * Manages tasks and assignees for the internal task board
 */
class TaskService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  // ─── Assignees ───────────────────────────────────────────────────────

  /**
   * Get all assignees
   */
  async getAssignees() {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .select()
      .from(taskAssignees)
      .orderBy(taskAssignees.name);

    return result;
  }

  /**
   * Add a new assignee
   */
  async addAssignee(name) {
    if (!this.drizzle) this.initialize();

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Assignee name is required');
    }

    // Check if already exists
    const existing = await this.drizzle
      .select()
      .from(taskAssignees)
      .where(ilike(taskAssignees.name, trimmedName))
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    const [assignee] = await this.drizzle
      .insert(taskAssignees)
      .values({ name: trimmedName })
      .returning();

    return assignee;
  }

  /**
   * Seed default assignees if none exist
   */
  async seedDefaultAssignees() {
    if (!this.drizzle) this.initialize();

    const existing = await this.drizzle.select().from(taskAssignees).limit(1);
    if (existing.length > 0) return;

    await this.drizzle.insert(taskAssignees).values([
      { name: 'Shlomi' },
      { name: 'Kosta' },
    ]);
  }

  // ─── Tasks ───────────────────────────────────────────────────────────

  /**
   * Get all tasks with optional filters
   */
  async getTasks(filters = {}) {
    if (!this.drizzle) this.initialize();

    let query = this.drizzle.select().from(tasks);

    const conditions = [];
    if (filters.status) {
      conditions.push(eq(tasks.status, filters.status));
    }
    if (filters.assignee) {
      conditions.push(eq(tasks.assignee, filters.assignee));
    }
    if (filters.type) {
      conditions.push(eq(tasks.type, filters.type));
    }
    if (filters.priority) {
      conditions.push(eq(tasks.priority, filters.priority));
    }
    if (filters.domain) {
      conditions.push(eq(tasks.domain, filters.domain));
    }
    if (filters.crewMember) {
      conditions.push(eq(tasks.crewMember, filters.crewMember));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const result = await query.orderBy(desc(tasks.createdAt));
    return result;
  }

  /**
   * Get a single task by ID
   */
  async getTask(id) {
    if (!this.drizzle) this.initialize();

    const [task] = await this.drizzle
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);

    return task || null;
  }

  /**
   * Create a new task
   */
  async createTask(data) {
    if (!this.drizzle) this.initialize();

    const { title, description, status, priority, type, domain, assignee, dueDate, atRisk, isCompleted, dependsOn, linkedTasks, tags, crewMember, isDraft, createdBy, opener } = data;

    if (!title?.trim()) {
      throw new Error('Task title is required');
    }

    const [task] = await this.drizzle
      .insert(tasks)
      .values({
        title: title.trim(),
        description: description?.trim() || null,
        status: status || 'todo',
        priority: priority || 'medium',
        type: type || 'feature',
        domain: domain || 'general',
        assignee: assignee || null,
        dueDate: dueDate || null,
        atRisk: atRisk || false,
        isCompleted: isCompleted || false,
        dependsOn: dependsOn || null,
        linkedTasks: linkedTasks || [],
        tags: tags || [],
        crewMember: crewMember || null,
        isDraft: isDraft || false,
        createdBy: createdBy || null,
        opener: opener || null,
        doneAt: status === 'done' ? new Date() : null,
      })
      .returning();

    boardEventsService.emit({ type: 'task_created', task });

    // Notify assignee if assigned on creation (and not assigning themselves)
    if (assignee && assignee !== opener) {
      notificationsService.createNotification({
        recipient: assignee,
        taskId: task.id,
        commentId: null,
        type: opener ? `assigned_by:${opener}` : 'assigned',
      }).catch(err => console.error('[notifications] Failed to create task creation notification:', err));
    }

    if (task.priority === BLOCKER_PRIORITY) {
      this._alertBlocker(task, opener || null, 'created');
    }

    return task;
  }

  /**
   * Update a task
   */
  async updateTask(id, updates) {
    if (!this.drizzle) this.initialize();

    // Fetch current task before update to detect changes for notifications
    const [before] = await this.drizzle.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    const updatedBy = updates.updatedBy || null;

    const updateData = { updatedAt: new Date() };

    if (updates.title !== undefined) updateData.title = updates.title.trim();
    if (updates.description !== undefined) updateData.description = updates.description?.trim() || null;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.priority !== undefined) updateData.priority = updates.priority;
    if (updates.type !== undefined) updateData.type = updates.type;
    if (updates.domain !== undefined) updateData.domain = updates.domain || 'general';
    if (updates.assignee !== undefined) updateData.assignee = updates.assignee || null;
    if (updates.dueDate !== undefined) updateData.dueDate = updates.dueDate || null;
    if (updates.atRisk !== undefined) updateData.atRisk = updates.atRisk;
    if (updates.isCompleted !== undefined) updateData.isCompleted = updates.isCompleted;
    if (updates.dependsOn !== undefined) updateData.dependsOn = updates.dependsOn || null;
    if (updates.linkedTasks !== undefined) updateData.linkedTasks = updates.linkedTasks;
    if (updates.tags !== undefined) updateData.tags = updates.tags;
    if (updates.crewMember !== undefined) updateData.crewMember = updates.crewMember || null;
    if (updates.isDraft !== undefined) updateData.isDraft = updates.isDraft;
    if (updates.createdBy !== undefined) updateData.createdBy = updates.createdBy || null;
    if (updates.deployedAt !== undefined) updateData.deployedAt = updates.deployedAt || null;
    if (updates.deployedReviewedBy !== undefined) updateData.deployedReviewedBy = updates.deployedReviewedBy;
    if (updates.whatChanged !== undefined) updateData.whatChanged = typeof updates.whatChanged === 'string' ? (updates.whatChanged.trim() || null) : null;
    if (updates.whatsNewHeadline !== undefined) updateData.whatsNewHeadline = typeof updates.whatsNewHeadline === 'string' ? (updates.whatsNewHeadline.trim().slice(0, 255) || null) : null;
    if (updates.notForRelease !== undefined) updateData.notForRelease = !!updates.notForRelease;

    // Release flow: entering Done stamps done_at; leaving Done clears it and the
    // Not-for-release flag, so a task that comes back to Done is on the Release list again.
    if (before && updates.status !== undefined && updates.status !== before.status) {
      if (updates.status === 'done') {
        updateData.doneAt = new Date();
        updateData.notForRelease = false;
      } else if (before.status === 'done') {
        updateData.doneAt = null;
        updateData.notForRelease = false;
      }
    }

    const [task] = await this.drizzle
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, id))
      .returning();

    // Fire notifications asynchronously
    if (before) {
      this._createUpdateNotifications(before, task, updatedBy).catch(err =>
        console.error('[notifications] Failed to create task update notifications:', err)
      );
    }

    // Raised to Blocker (not every edit of a task that already is one)
    if (before && task && task.priority === BLOCKER_PRIORITY && before.priority !== BLOCKER_PRIORITY) {
      this._alertBlocker(task, updatedBy, 'raised');
    }

    boardEventsService.emit({ type: 'task_updated', task });
    return task;
  }

  /**
   * Agenda page: tick / untick one checklist line of an agenda topic, or set /
   * clear Shlomi's note under it — without overwriting lines that Claude
   * sessions add to the same description meanwhile.
   *
   * The line is addressed by `index` (0-based position among the description's
   * `- [ ]` / `- [x]` lines) AND `text` (the line's text after the box). If the
   * line at `index` doesn't carry that text, it is looked up by text; when the
   * text is gone or ambiguous we refuse (status 409) rather than tick the wrong
   * line. The write is compare-and-swap on the whole description, retried a few
   * times, so a concurrent edit is re-read and re-applied, never clobbered.
   *
   * note: string → writes / replaces `  > הערה: <text>` under the line;
   *       '' or null → removes that note line. Other `>` lines (decisions) are
   *       never touched. undefined → note left as is.
   */
  async updateAgendaLine(id, { index, text, checked, note } = {}) {
    if (!this.drizzle) this.initialize();
    if (!Number.isInteger(index) || index < 0 || typeof text !== 'string') {
      const err = new Error('index (number) and text (string) are required');
      err.status = 400;
      throw err;
    }
    if (checked === undefined && note === undefined) {
      const err = new Error('Nothing to change: pass checked and/or note');
      err.status = 400;
      throw err;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const [before] = await this.drizzle.select().from(tasks).where(eq(tasks.id, id)).limit(1);
      if (!before) return null;

      const original = before.description || '';
      const next = applyAgendaLineChange(original, { index, text, checked, note });
      if (next === original) return before; // already in that state

      const [task] = await this.drizzle
        .update(tasks)
        .set({ description: next, updatedAt: new Date() })
        .where(and(
          eq(tasks.id, id),
          before.description === null ? isNull(tasks.description) : eq(tasks.description, before.description),
        ))
        .returning();

      if (task) {
        boardEventsService.emit({ type: 'task_updated', task });
        return task;
      }
      // Someone saved the description between our read and write — re-read and retry.
    }
    const err = new Error('The topic keeps changing — try again');
    err.status = 409;
    throw err;
  }

  /**
   * Blocker alert — fire-and-forget, never throws into the API call.
   * Immediate email to BLOCKER_RECIPIENT plus the in-app notification
   * (marked as already emailed so the digest does not send it again).
   * Nothing when the recipient raised it themselves.
   */
  _alertBlocker(task, by, what) {
    const isSelf = by && by.toLowerCase() === BLOCKER_RECIPIENT.toLowerCase();
    if (isSelf) return;
    (async () => {
      let emailed = false;
      const to = emailScheduler.emailFor(BLOCKER_RECIPIENT);
      if (to) {
        try {
          await sendBlockerAlertEmail({ to, task, by, what });
          emailed = true;
          console.log(`[blocker] Alert email sent to ${BLOCKER_RECIPIENT} for task #${task.id} (${what} by ${by || 'unknown'})`);
        } catch (err) {
          console.error(`[blocker] Alert email FAILED for task #${task.id}:`, err.message);
        }
      } else {
        console.log(`[blocker] No email for task #${task.id}: board emails are off on this server or ${BLOCKER_RECIPIENT} has no address`);
      }
      await notificationsService.createNotification({
        recipient: BLOCKER_RECIPIENT,
        taskId: task.id,
        commentId: null,
        type: by ? `blocker_by:${by}` : 'blocker',
        alreadyEmailed: emailed,
      });
    })().catch(err => console.error(`[blocker] Alert failed for task #${task.id}:`, err.message));
  }

  /**
   * Notify assignee when task is assigned or status changes
   */
  async _createUpdateNotifications(before, after, updatedBy = null) {
    const newAssignee = after.assignee;
    // Case-insensitive check: is this person the one who made the change?
    const isSelf = (name) => !!(name && updatedBy && name.toLowerCase() === updatedBy.toLowerCase());

    // Assignee changed → notify the new assignee (unless they assigned themselves)
    if (newAssignee && newAssignee !== before.assignee && !isSelf(newAssignee)) {
      const assigner = updatedBy || after.opener || null;
      await notificationsService.createNotification({
        recipient: newAssignee,
        taskId: after.id,
        commentId: null,
        type: assigner ? `assigned_by:${assigner}` : 'assigned',
      });
    }

    // Status changed → notify assignee and opener
    if (after.status !== before.status) {
      const notificationType = `moved_to_${after.status}`;
      const notifiedLower = new Set();

      // Notify assignee (if same as before, not the one who changed it)
      if (newAssignee && newAssignee === before.assignee && !isSelf(newAssignee)) {
        await notificationsService.createNotification({
          recipient: newAssignee,
          taskId: after.id,
          commentId: null,
          type: notificationType,
        });
        notifiedLower.add(newAssignee.toLowerCase());
      }

      // Notify opener (if set, not the one who changed it, and not already notified)
      const opener = after.opener;
      if (opener && !isSelf(opener) && !notifiedLower.has(opener.toLowerCase())) {
        await notificationsService.createNotification({
          recipient: opener,
          taskId: after.id,
          commentId: null,
          type: notificationType,
        });
      }
    }
  }

  /**
   * Mark a task as deployed — sets deployedAt and notifies commenters/assignee/opener
   */
  async markDeployed(id, deployedBy) {
    if (!this.drizzle) this.initialize();

    const [task] = await this.drizzle
      .update(tasks)
      .set({ deployedAt: new Date(), deployedReviewedBy: [], updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();

    if (!task) return null;

    // Notify everyone involved (assignee, opener, commenters) except the deployer
    const { taskComments } = require('../db/schema');
    const comments = await this.drizzle.select({ author: taskComments.author }).from(taskComments).where(eq(taskComments.taskId, id));

    const recipients = new Set();
    if (task.assignee) recipients.add(task.assignee);
    if (task.opener) recipients.add(task.opener);
    for (const c of comments) {
      if (c.author) recipients.add(c.author);
    }
    if (deployedBy) recipients.delete(deployedBy);

    for (const recipient of recipients) {
      notificationsService.createNotification({
        recipient,
        taskId: id,
        commentId: null,
        type: 'deployed',
      }).catch(err => console.error('[notifications] Failed to create deploy notification:', err));
    }

    boardEventsService.emit({ type: 'task_updated', task });
    return task;
  }

  // ─── Release flow ────────────────────────────────────────────────────

  /**
   * Tasks waiting for release: Done, not released since they were done, not marked
   * Not for release. Newest "moved to Done" first; tasks done before done_at existed last.
   */
  async getReleaseCandidates() {
    if (!this.drizzle) this.initialize();

    return this.drizzle
      .select({
        id: tasks.id,
        title: tasks.title,
        type: tasks.type,
        assignee: tasks.assignee,
        doneAt: tasks.doneAt,
        whatsNewHeadline: tasks.whatsNewHeadline,
        whatChanged: tasks.whatChanged,
      })
      .from(tasks)
      .where(and(
        eq(tasks.status, 'done'),
        eq(tasks.notForRelease, false),
        eq(tasks.isDraft, false),
        notInArray(tasks.type, NON_RELEASE_TYPES),
        or(isNull(tasks.deployedAt), lt(tasks.deployedAt, tasks.doneAt)),
      ))
      .orderBy(sql`${tasks.doneAt} DESC NULLS LAST`, desc(tasks.id));
  }

  /**
   * Mark several tasks as deployed at once (the Release window). Same effect as
   * markDeployed per task: notifications, digest email, What's New.
   */
  async releaseTasks(taskIds, releasedBy) {
    const released = [];
    for (const id of taskIds) {
      const task = await this.markDeployed(id, releasedBy);
      if (task) released.push(task.id);
    }
    return released;
  }

  async _findPerson(identity) {
    const [person] = await this.drizzle
      .select()
      .from(taskAssignees)
      .where(sql`lower(${taskAssignees.name}) = lower(${identity})`)
      .limit(1);
    return person || null;
  }

  /**
   * Release history: every task ever released, newest first — the "all updates"
   * tab of What's New, so a release note can be read again after "Got it".
   * Same filters and fields as getWhatsNew, without the watermark.
   */
  async getReleaseHistory({ limit } = {}) {
    if (!this.drizzle) this.initialize();
    const max = Math.min(Math.max(Number(limit) || 300, 1), 1000);
    return this.drizzle
      .select({
        id: tasks.id,
        title: tasks.title,
        whatsNewHeadline: tasks.whatsNewHeadline,
        whatChanged: tasks.whatChanged,
        deployedAt: tasks.deployedAt,
      })
      .from(tasks)
      .where(and(
        isNotNull(tasks.deployedAt),
        eq(tasks.isDraft, false),
        notInArray(tasks.type, NON_RELEASE_TYPES),
      ))
      .orderBy(desc(tasks.deployedAt))
      .limit(max);
  }

  /**
   * What's New for one person: tasks deployed after their "seen until" watermark,
   * newest first. People without a watermark get nothing (no popup).
   *
   * Never selects `description` (can hold pasted base64 images) — this is polled.
   */
  async getWhatsNew(identity) {
    if (!this.drizzle) this.initialize();
    if (!identity) return { tasks: [], seenUntil: null };

    const person = await this._findPerson(identity);
    if (!person) return { tasks: [], seenUntil: null };
    const seenUntil = person.seenUntil || await this._startWatermark(person.id);
    if (!seenUntil) return { tasks: [], seenUntil: null };

    const items = await this.drizzle
      .select({
        id: tasks.id,
        title: tasks.title,
        whatsNewHeadline: tasks.whatsNewHeadline,
        whatChanged: tasks.whatChanged,
        deployedAt: tasks.deployedAt,
      })
      .from(tasks)
      .where(and(
        gt(tasks.deployedAt, seenUntil),
        eq(tasks.isDraft, false),
        notInArray(tasks.type, NON_RELEASE_TYPES),
      ))
      .orderBy(desc(tasks.deployedAt));

    return { tasks: items, seenUntil };
  }

  /**
   * A team member's first What's New: start their watermark just below the last
   * WHATS_NEW_START releases, so they see those and nothing older. Set in SQL so
   * deployed_at keeps its full precision; `seen_until IS NULL` keeps it one-time.
   */
  async _startWatermark(personId) {
    await this.drizzle.execute(sql`
      UPDATE task_assignees
      SET seen_until = COALESCE((
        SELECT deployed_at FROM tasks
        WHERE deployed_at IS NOT NULL AND is_draft = false
          AND type NOT IN (${sql.join(NON_RELEASE_TYPES.map(t => sql`${t}`), sql`, `)})
        ORDER BY deployed_at DESC OFFSET ${WHATS_NEW_START} LIMIT 1
      ), TIMESTAMP '2000-01-01')
      WHERE id = ${personId} AND seen_until IS NULL`);
    const [person] = await this.drizzle.select().from(taskAssignees).where(eq(taskAssignees.id, personId));
    return person?.seenUntil || null;
  }

  /**
   * "Got it": move a person's watermark forward to `until` (the newest item they saw).
   * Never moves backwards, never past now, never creates a watermark.
   */
  async markWhatsNewSeen(identity, until) {
    if (!this.drizzle) this.initialize();

    const untilDate = new Date(until);
    if (!identity || Number.isNaN(untilDate.getTime())) {
      throw new Error('identity and a valid until are required');
    }
    const now = new Date();
    const capped = untilDate > now ? now : untilDate;

    const person = await this._findPerson(identity);
    if (!person || !person.seenUntil) return null;
    if (capped <= person.seenUntil) return person.seenUntil;

    await this.drizzle
      .update(taskAssignees)
      .set({ seenUntil: capped })
      .where(eq(taskAssignees.id, person.id));
    return capped;
  }

  /**
   * Dismiss a deployed task from a user's "What's New" list
   */
  async dismissDeployed(id, identity) {
    if (!this.drizzle) this.initialize();

    const [task] = await this.drizzle.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task) return null;

    const reviewedBy = task.deployedReviewedBy || [];
    if (reviewedBy.includes(identity)) return task;

    const [updated] = await this.drizzle
      .update(tasks)
      .set({ deployedReviewedBy: [...reviewedBy, identity] })
      .where(eq(tasks.id, id))
      .returning();

    return updated;
  }

  /**
   * Delete a task
   */
  async deleteTask(id) {
    if (!this.drizzle) this.initialize();

    await this.drizzle.delete(tasks).where(eq(tasks.id, id));
  }
}

module.exports = new TaskService();
