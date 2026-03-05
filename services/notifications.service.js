const db = require('./db.pg');
const { taskNotifications } = require('../db/schema');
const { eq, and, desc } = require('drizzle-orm');

class NotificationsService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Get unread notifications for a recipient (their name identity)
   */
  async getNotifications(recipient) {
    if (!this.drizzle) this.initialize();

    return this.drizzle
      .select()
      .from(taskNotifications)
      .where(and(
        eq(taskNotifications.recipient, recipient),
        eq(taskNotifications.isRead, false)
      ))
      .orderBy(desc(taskNotifications.createdAt));
  }

  /**
   * Create a notification
   */
  async createNotification({ recipient, taskId, commentId, type }) {
    if (!this.drizzle) this.initialize();

    const [notification] = await this.drizzle
      .insert(taskNotifications)
      .values({ recipient, taskId, commentId: commentId || null, type })
      .returning();

    return notification;
  }

  /**
   * Mark a single notification as read
   */
  async markRead(id) {
    if (!this.drizzle) this.initialize();

    await this.drizzle
      .update(taskNotifications)
      .set({ isRead: true })
      .where(eq(taskNotifications.id, id));
  }

  /**
   * Mark all notifications for a recipient as read
   */
  async markAllRead(recipient) {
    if (!this.drizzle) this.initialize();

    await this.drizzle
      .update(taskNotifications)
      .set({ isRead: true })
      .where(and(
        eq(taskNotifications.recipient, recipient),
        eq(taskNotifications.isRead, false)
      ));
  }
}

module.exports = new NotificationsService();
