const db = require('./db.pg');
const { taskComments, tasks, taskAssignees } = require('../db/schema');
const { eq, asc } = require('drizzle-orm');
const notificationsService = require('./notifications.service');

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

    return comment;
  }

  /**
   * Create notifications for a new comment:
   * 1. @mention notifications for each @Name found in content
   * 2. comment_on_assigned notification for the task assignee (if not the author)
   */
  async _createNotifications(taskId, commentId, author, content) {
    if (!this.drizzle) this.initialize();

    // Fetch all known assignee names for mention matching
    const assigneeRows = await this.drizzle.select().from(taskAssignees);

    // Strip HTML tags and parse @mentions
    const plainText = content.replace(/<[^>]+>/g, ' ');
    const mentionRegex = /@([\w\u0080-\uFFFF]+(?:\s[\w\u0080-\uFFFF]+)?)/g;
    const mentionedNames = new Set();

    let match;
    while ((match = mentionRegex.exec(plainText)) !== null) {
      const mentioned = match[1].trim();
      const found = assigneeRows.find(a => a.name.toLowerCase() === mentioned.toLowerCase());
      if (found && found.name !== author) {
        mentionedNames.add(found.name);
      }
    }

    // Create mention notifications
    for (const name of mentionedNames) {
      await notificationsService.createNotification({ recipient: name, taskId, commentId, type: 'mention' });
    }

    // Fetch task to check assignee
    const [task] = await this.drizzle.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

    // Notify assignee if they're not the author and weren't already notified via @mention
    if (task?.assignee && task.assignee !== author && !mentionedNames.has(task.assignee)) {
      await notificationsService.createNotification({
        recipient: task.assignee,
        taskId,
        commentId,
        type: 'comment_on_assigned',
      });
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
