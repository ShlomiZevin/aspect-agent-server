const db = require('./db.pg');
const { taskNotifications } = require('../db/schema');
const { eq, and, desc } = require('drizzle-orm');

class NotificationsService {
  constructor() {
    this.drizzle = null;
    // SSE: identity -> Set of response objects
    this.sseClients = new Map();
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

  // ─── SSE ─────────────────────────────────────────────────────────────────

  addSSEClient(identity, res) {
    if (!this.sseClients.has(identity)) {
      this.sseClients.set(identity, new Set());
    }
    this.sseClients.get(identity).add(res);
  }

  removeSSEClient(identity, res) {
    const clients = this.sseClients.get(identity);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) this.sseClients.delete(identity);
    }
  }

  emitToClient(recipient, notification) {
    const clients = this.sseClients.get(recipient);
    if (!clients || clients.size === 0) return;
    const data = `data: ${JSON.stringify(notification)}\n\n`;
    for (const res of clients) {
      try { res.write(data); } catch { /* client disconnected */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a notification
   */
  async createNotification({ recipient, taskId, commentId, type }) {
    if (!this.drizzle) this.initialize();

    const [notification] = await this.drizzle
      .insert(taskNotifications)
      .values({ recipient, taskId, commentId: commentId || null, type })
      .returning();

    // Push to any connected SSE clients immediately
    this.emitToClient(recipient, notification);

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
