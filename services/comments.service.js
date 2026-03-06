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
   * 2. comment_on_assigned notification for the task assignee (if not the author)
   * 3. comment_on_assigned notification for anyone previously @mentioned in this task (if not author/assignee/already notified)
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

    // Fetch task to check assignee
    const [task] = await this.drizzle.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

    // Track who already got notified to avoid duplicates
    const alreadyNotified = new Set(mentionedNames);
    alreadyNotified.add(author);

    // 2. Notify task assignee
    if (task?.assignee && !alreadyNotified.has(task.assignee)) {
      await notificationsService.createNotification({
        recipient: task.assignee,
        taskId,
        commentId,
        type: 'comment_on_assigned',
      });
      alreadyNotified.add(task.assignee);
    }

    // 3. Notify anyone previously @mentioned in this task's comments
    const previousComments = await this.drizzle
      .select({ content: taskComments.content })
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId));

    const previouslyMentioned = new Set();
    for (const { content: prevContent } of previousComments) {
      for (const name of extractMentions(prevContent)) {
        previouslyMentioned.add(name);
      }
    }

    for (const name of previouslyMentioned) {
      if (!alreadyNotified.has(name)) {
        await notificationsService.createNotification({
          recipient: name,
          taskId,
          commentId,
          type: 'comment_on_assigned',
        });
        alreadyNotified.add(name);
      }
    }
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
