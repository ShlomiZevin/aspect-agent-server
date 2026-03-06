const db = require('./db.pg');
const { taskNotifications } = require('../db/schema');
const { eq, and, desc } = require('drizzle-orm');

const DELIVERED_HISTORY = 10; // how many delivered notifications to return

class NotificationsService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Fetch notifications for a recipient (does NOT mark as delivered).
   * Returns: all undelivered + last DELIVERED_HISTORY delivered.
   */
  async getNotifications(recipient) {
    if (!this.drizzle) this.initialize();

    // All undelivered for this recipient
    const undelivered = await this.drizzle
      .select()
      .from(taskNotifications)
      .where(and(
        eq(taskNotifications.recipient, recipient),
        eq(taskNotifications.isDelivered, false)
      ))
      .orderBy(desc(taskNotifications.createdAt));

    // Last DELIVERED_HISTORY delivered (for history display)
    const delivered = await this.drizzle
      .select()
      .from(taskNotifications)
      .where(and(
        eq(taskNotifications.recipient, recipient),
        eq(taskNotifications.isDelivered, true)
      ))
      .orderBy(desc(taskNotifications.createdAt))
      .limit(DELIVERED_HISTORY);

    return [...undelivered, ...delivered].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  /**
   * Mark all undelivered notifications for a recipient as delivered.
   * Called when the user opens the notification panel.
   */
  async markDelivered(recipient) {
    if (!this.drizzle) this.initialize();

    await this.drizzle
      .update(taskNotifications)
      .set({ isDelivered: true })
      .where(and(
        eq(taskNotifications.recipient, recipient),
        eq(taskNotifications.isDelivered, false)
      ));
  }

  /**
   * Create a notification and store it in the DB.
   */
  async createNotification({ recipient, taskId, commentId, type }) {
    if (!this.drizzle) this.initialize();

    const [notification] = await this.drizzle
      .insert(taskNotifications)
      .values({ recipient, taskId, commentId: commentId || null, type })
      .returning();

    return notification;
  }
}

module.exports = new NotificationsService();
