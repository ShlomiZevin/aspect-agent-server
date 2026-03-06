const db = require('./db.pg');
const { taskNotifications } = require('../db/schema');
const { eq, and, desc, sql, inArray } = require('drizzle-orm');

const DELIVERED_HISTORY = 10; // how many delivered notifications to return

class NotificationsService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Fetch notifications for a recipient, mark undelivered ones as delivered.
   *
   * Logic:
   *   - Count undelivered notifications for the recipient.
   *   - If undelivered > DELIVERED_HISTORY: return all undelivered + last DELIVERED_HISTORY delivered.
   *   - Otherwise: return the last DELIVERED_HISTORY notifications (mix of delivered + not).
   *   - After building the list, mark all undelivered in the list as delivered.
   *   - The returned rows contain the ORIGINAL isDelivered value (false = NEW for client).
   */
  async getNotifications(recipient) {
    if (!this.drizzle) this.initialize();

    // Count undelivered
    const [{ count }] = await this.drizzle
      .select({ count: sql`count(*)::int` })
      .from(taskNotifications)
      .where(and(
        eq(taskNotifications.recipient, recipient),
        eq(taskNotifications.isDelivered, false)
      ));

    let rows;

    if (count > DELIVERED_HISTORY) {
      // Fetch all undelivered
      const undelivered = await this.drizzle
        .select()
        .from(taskNotifications)
        .where(and(
          eq(taskNotifications.recipient, recipient),
          eq(taskNotifications.isDelivered, false)
        ))
        .orderBy(desc(taskNotifications.createdAt));

      // Fetch last DELIVERED_HISTORY delivered
      const delivered = await this.drizzle
        .select()
        .from(taskNotifications)
        .where(and(
          eq(taskNotifications.recipient, recipient),
          eq(taskNotifications.isDelivered, true)
        ))
        .orderBy(desc(taskNotifications.createdAt))
        .limit(DELIVERED_HISTORY);

      rows = [...undelivered, ...delivered].sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
    } else {
      // Return last DELIVERED_HISTORY overall (any delivery status)
      rows = await this.drizzle
        .select()
        .from(taskNotifications)
        .where(eq(taskNotifications.recipient, recipient))
        .orderBy(desc(taskNotifications.createdAt))
        .limit(DELIVERED_HISTORY);
    }

    // Mark undelivered rows as delivered (after we've captured the original state)
    const undeliveredIds = rows
      .filter(r => !r.isDelivered)
      .map(r => r.id);

    if (undeliveredIds.length > 0) {
      await this.drizzle
        .update(taskNotifications)
        .set({ isDelivered: true })
        .where(inArray(taskNotifications.id, undeliveredIds));
    }

    return rows;
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
