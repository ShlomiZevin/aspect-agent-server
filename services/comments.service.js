const db = require('./db.pg');
const { taskComments } = require('../db/schema');
const { eq, asc } = require('drizzle-orm');

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
   * Add a comment to a task
   */
  async addComment(taskId, author, content) {
    if (!this.drizzle) this.initialize();

    if (!author?.trim()) throw new Error('Author is required');
    if (!content?.trim()) throw new Error('Content is required');

    const [comment] = await this.drizzle
      .insert(taskComments)
      .values({ taskId, author: author.trim(), content: content.trim() })
      .returning();

    return comment;
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
