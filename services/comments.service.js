const db = require('./db.pg');
const { taskComments, tasks, taskAssignees } = require('../db/schema');
const { eq, asc } = require('drizzle-orm');
const notificationsService = require('./notifications.service');
const boardEventsService = require('./boardEvents.service');

class CommentsService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Get all comments for a task, ordered by creation time (oldest first)
   */
  async getComments(taskId) {
    if (!this.drizzle) this.initialize();

    return this.drizzle
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt));
  }

  /**
   * Add a comment to a task and trigger notifications
   */
  async addComment(taskId, author, content) {
    if (!this.drizzle) this.initialize();

    if (!author?.trim()) throw new Error('Author is required');
    if (!content?.trim()) throw new Error('Content is required');

    const [comment] = await this.drizzle
      .insert(taskComments)
      .values({ taskId, author: author.trim(), content: content.trim() })
      .returning();

    // Fire notifications asynchronously (don't block comment response)
    this._createNotifications(taskId, comment.id, author.trim(), content).catch(err =>
      console.error('[notifications] Failed to create notifications:', err)
    );

    // Broadcast to all board clients for live comment updates
    boardEventsService.emit({ type: 'comment_added', taskId, comment });

    return comment;
  }

  /**
   * Create notifications for a new comment:
   * 1. @mention notifications for each @Name found in content
   * 2. comment notification for the task assignee (if not the author)
   * 3. comment notification for the task opener (if not the author)
   * 4. comment notification for anyone who previously commented on this task
   * 5. comment notification for anyone previously @mentioned in this task's comments
   */
  async _createNotifications(taskId, commentId, author, content) {
    if (!this.drizzle) this.initialize();

    // Fetch all known assignee names for mention matching
    const assigneeRows = await this.drizzle.select().from(taskAssignees);
    const validNames = new Map(assigneeRows.map(a => [a.name.toLowerCase(), a.name]));

    // Helper: extract @mentioned names from HTML content
    const extractMentions = (html) => {
      const plain = html.replace(/<[^>]+>/g, ' ');
      const regex = /@([\w\u00C0-\uFFFF]+)/g;
      const names = new Set();
      let m;
      while ((m = regex.exec(plain)) !== null) {
        const canonical = validNames.get(m[1].trim().toLowerCase());
        if (canonical) names.add(canonical);
      }
      return names;
    };

    // 1. @mentions in the new comment
    const mentionedNames = extractMentions(content);
    mentionedNames.delete(author); // don't notify yourself

    for (const name of mentionedNames) {
      await notificationsService.createNotification({ recipient: name, taskId, commentId, type: 'mention' });
    }

    // Fetch task to check assignee and opener
    const [task] = await this.drizzle.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

    // Track who already got notified to avoid duplicates
    const alreadyNotified = new Set(mentionedNames);
    alreadyNotified.add(author);

    const notify = async (recipient) => {
      if (recipient && !alreadyNotified.has(recipient)) {
        await notificationsService.createNotification({
          recipient,
          taskId,
          commentId,
          type: 'comment_on_assigned',
        });
        alreadyNotified.add(recipient);
      }
    };

    // 2. Notify task assignee
    if (task?.assignee) await notify(task.assignee);

    // 3. Notify task opener
    if (task?.opener) await notify(task.opener);

    // Fetch previous comments for steps 4 and 5
    const previousComments = await this.drizzle
      .select({ content: taskComments.content, author: taskComments.author })
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId));

    // 4. Notify anyone who previously commented on this task
    for (const { author: prevAuthor } of previousComments) {
      await notify(prevAuthor);
    }

    // 5. Notify anyone previously @mentioned in this task's comments
    for (const { content: prevContent } of previousComments) {
      for (const name of extractMentions(prevContent)) {
        await notify(name);
      }
    }
  }

  /**
   * Get task IDs that need attention from a specific identity.
   * A task needs attention if:
   * - The last comment @mentions the identity
   * - The identity hasn't commented after that mention
   */
  async getTasksNeedingAttention(identity) {
    if (!this.drizzle) this.initialize();
    if (!identity) return [];

    // Get all comments grouped by task, ordered by creation time
    const allComments = await this.drizzle
      .select({
        id: taskComments.id,
        taskId: taskComments.taskId,
        author: taskComments.author,
        content: taskComments.content,
        likedBy: taskComments.likedBy,
        createdAt: taskComments.createdAt,
      })
      .from(taskComments)
      .orderBy(asc(taskComments.createdAt));

    // Group by task
    const byTask = new Map();
    for (const c of allComments) {
      if (!byTask.has(c.taskId)) byTask.set(c.taskId, []);
      byTask.get(c.taskId).push(c);
    }

    const needsAttention = [];
    const identityLower = identity.toLowerCase();

    // Also fetch tasks to check opener and read tasks
    const allTasks = await this.drizzle.select({ id: tasks.id, opener: tasks.opener, type: tasks.type, assignee: tasks.assignee, isCompleted: tasks.isCompleted }).from(tasks);
    const openerMap = new Map();
    for (const t of allTasks) {
      if (t.opener) openerMap.set(t.id, t.opener.toLowerCase());
      // Unread "read" tasks assigned to this identity need attention
      if (t.type === 'read' && !t.isCompleted && t.assignee && t.assignee.toLowerCase() === identityLower) {
        needsAttention.push(t.id);
      }
    }

    for (const [taskId, comments] of byTask) {
      const lastComment = comments[comments.length - 1];
      const lastAuthorLower = lastComment.author.toLowerCase();

      // Skip if I wrote the last comment — nothing to respond to
      if (lastAuthorLower === identityLower) continue;

      const isOpener = openerMap.get(taskId) === identityLower;

      // Did I ever comment on this task?
      const myLastCommentIndex = (() => {
        for (let i = comments.length - 1; i >= 0; i--) {
          if (comments[i].author.toLowerCase() === identityLower) return i;
        }
        return -1;
      })();

      // Not opener and never commented — no attention needed
      if (!isOpener && myLastCommentIndex === -1) continue;

      // Find my last interaction: latest of my last comment or my last like
      let lastInteractionIndex = myLastCommentIndex;
      for (let i = comments.length - 1; i > lastInteractionIndex; i--) {
        const likedBy = (comments[i].likedBy || []).map(n => n.toLowerCase());
        if (likedBy.includes(identityLower)) {
          lastInteractionIndex = i;
          break;
        }
      }

      // Are there comments after my last interaction that aren't by me?
      const hasNewAfter = comments.slice(lastInteractionIndex + 1).some(
        c => c.author.toLowerCase() !== identityLower
      );

      if (hasNewAfter) {
        needsAttention.push(taskId);
      }
    }

    return needsAttention;
  }

  /**
   * Toggle like on a comment
   */
  async toggleLike(commentId, identity) {
    if (!this.drizzle) this.initialize();
    if (!identity?.trim()) throw new Error('Identity is required');

    const [comment] = await this.drizzle.select().from(taskComments).where(eq(taskComments.id, commentId)).limit(1);
    if (!comment) throw new Error('Comment not found');

    const likedBy = comment.likedBy || [];
    const alreadyLiked = likedBy.includes(identity.trim());
    const newLikedBy = alreadyLiked
      ? likedBy.filter(n => n !== identity.trim())
      : [...likedBy, identity.trim()];

    const [updated] = await this.drizzle
      .update(taskComments)
      .set({ likedBy: newLikedBy })
      .where(eq(taskComments.id, commentId))
      .returning();

    return updated;
  }

  /**
   * Delete a comment by ID
   */
  async deleteComment(commentId) {
    if (!this.drizzle) this.initialize();

    await this.drizzle
      .delete(taskComments)
      .where(eq(taskComments.id, commentId));
  }
}

module.exports = new CommentsService();
