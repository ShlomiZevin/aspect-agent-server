/**
 * Email Scheduler Service
 *
 * Batches task-board notifications into digest emails using a hybrid
 * debounce + max-wait strategy:
 *
 *   - DEBOUNCE_MS (5 min): reset the send timer on every new notification.
 *   - MAX_WAIT_MS (15 min): send regardless, so urgent items aren't held forever.
 *
 * Only recipients listed in EMAIL_RECIPIENTS receive emails.
 * Multiple notifications arriving in quick succession are bundled into one email.
 */

const { sendTaskAttentionEmail } = require('./email.service');

// How long to wait after the LAST notification before sending (debounce)
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

// Maximum wait from the FIRST notification regardless of ongoing activity
const MAX_WAIT_MS = 15 * 60 * 1000; // 15 minutes

// Per-recipient config: email address + allowed domains.
// Never include "aspect" domain for anyone.
const EMAIL_RECIPIENTS = {
  Shlomi: { email: process.env.GMAIL_USER,        domains: ['lybi', 'freeda', 'freeda-1.0', 'onboarding', 'engine'] },
  Noa:    { email: 'noa@lybi.ai',                 domains: ['lybi', 'onboarding', 'engine'] },
  Kosta:  { email: 'ziben.konstantin@gmail.com',  domains: ['lybi', 'freeda', 'freeda-1.0', 'onboarding', 'engine'] },
};

class EmailSchedulerService {
  constructor() {
    // pending[recipient] = { debounceTimer, maxWaitTimer, notificationIds: Set }
    this.pending = {};
    this.db = null;
  }

  initialize(db) {
    this.db = db;
  }

  /**
   * Called immediately after a notification is inserted into the DB.
   * @param {string} recipient - The notification recipient name
   * @param {number} notificationId - The new notification's DB id
   */
  schedule(recipient, notificationId) {
    if (!EMAIL_RECIPIENTS[recipient]) return; // not subscribed to emails

    if (!this.pending[recipient]) {
      this.pending[recipient] = {
        debounceTimer: null,
        maxWaitTimer: null,
        notificationIds: new Set(),
      };

      // Max-wait timer: fire at most MAX_WAIT_MS after the very first notification
      this.pending[recipient].maxWaitTimer = setTimeout(() => {
        this._send(recipient);
      }, MAX_WAIT_MS);
    }

    this.pending[recipient].notificationIds.add(notificationId);

    // Reset debounce timer
    clearTimeout(this.pending[recipient].debounceTimer);
    this.pending[recipient].debounceTimer = setTimeout(() => {
      this._send(recipient);
    }, DEBOUNCE_MS);
  }

  async _send(recipient) {
    if (!this.pending[recipient]) return;

    // Cancel both timers
    clearTimeout(this.pending[recipient].debounceTimer);
    clearTimeout(this.pending[recipient].maxWaitTimer);
    delete this.pending[recipient];

    try {
      await this._sendBatch(recipient);
    } catch (err) {
      console.error(`[EmailScheduler] Failed to send batch for ${recipient}:`, err.message);
    }
  }

  async _sendBatch(recipient) {
    if (!this.db) {
      console.warn('[EmailScheduler] DB not initialized, skipping email batch');
      return;
    }

    const config = EMAIL_RECIPIENTS[recipient];
    if (!config) return;
    const { email, domains } = config;

    // Fetch un-emailed notifications for this recipient from the last 24 hours only,
    // excluding tasks outside the allowed domains (never expose "aspect" domain).
    const result = await this.db.query(`
      SELECT
        n.id,
        n.type,
        n.created_at,
        t.id   AS task_id,
        t.title AS task_title,
        t.status AS task_status,
        t.domain AS task_domain,
        t.assignee,
        c.author AS comment_author,
        c.content AS comment_content
      FROM task_notifications n
      JOIN tasks t ON t.id = n.task_id
      LEFT JOIN task_comments c ON c.id = n.comment_id
      WHERE n.recipient = $1
        AND n.emailed_at IS NULL
        AND n.created_at >= NOW() - INTERVAL '24 hours'
        AND t.domain = ANY($2::text[])
      ORDER BY n.created_at ASC
    `, [recipient, domains]);

    const rows = result.rows;
    if (rows.length === 0) return;

    console.log(`[EmailScheduler] Sending ${rows.length} notification(s) to ${email}`);

    await sendTaskAttentionEmail({ recipientEmail: email, recipientName: recipient, notifications: rows });

    // Mark all as emailed
    const ids = rows.map(r => r.id);
    await this.db.query(`
      UPDATE task_notifications
      SET emailed_at = NOW()
      WHERE id = ANY($1::int[])
    `, [ids]);

    console.log(`[EmailScheduler] Email sent and ${ids.length} notification(s) marked as emailed.`);
  }
}

module.exports = new EmailSchedulerService();
