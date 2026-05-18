/**
 * Email Scheduler Service
 *
 * Batches task-board notifications into digest emails using a hybrid
 * debounce + max-wait strategy:
 *
 *   - DEBOUNCE_MS (5 min): reset the send timer on every new notification.
 *   - MAX_WAIT_MS (15 min): send regardless, so urgent items aren't held forever.
 *   - POLL_MS (10 min): periodic backlog sweep — catches any notifications missed
 *     due to server restarts (in-memory timers are lost on redeploy).
 *
 * Only recipients listed in EMAIL_RECIPIENTS receive emails.
 * Multiple notifications arriving in quick succession are bundled into one email.
 */

const { sendTaskAttentionEmail, sendDeployedDigestEmail } = require('./email.service');
// commentsService is loaded lazily inside _sendBatch — top-level require would
// create a cycle (commentsService → notifications.service → emailScheduler).

// How long to wait after the LAST notification before sending (debounce)
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

// Maximum wait from the FIRST notification regardless of ongoing activity
const MAX_WAIT_MS = 15 * 60 * 1000; // 15 minutes

// Periodic backlog sweep interval — catches notifications missed on server restart
const POLL_MS = 10 * 60 * 1000; // 10 minutes

// Separate digest for deployed tasks — fires every 3 hours, one email per recipient
// listing all deployed tasks they haven't dismissed from "What's New" yet.
const DEPLOYED_DIGEST_MS = 3 * 60 * 60 * 1000; // 3 hours

// Per-recipient config: email address + allowed domains.
// Never include "aspect" domain for anyone.
const EMAIL_RECIPIENTS = {
  Shlomi: { email: 'shlomi@boostart.io',          domains: ['lybi', 'freeda', 'freeda-1.0', 'banking', 'engine', 'general'] },
  Noa:    { email: 'noa@lybi.ai',                 domains: ['lybi', 'banking', 'engine', 'general'] },
  Kosta:  { email: 'ziben.konstantin@gmail.com',  domains: ['lybi', 'freeda', 'freeda-1.0', 'banking', 'engine', 'general'] },
};

class EmailSchedulerService {
  constructor() {
    // pending[recipient] = { debounceTimer, maxWaitTimer, notificationIds: Set }
    this.pending = {};
    this.db = null;
  }

  initialize(db) {
    this.db = db;
    // Run once immediately to catch any backlog from before restart
    setTimeout(() => this._sweepBacklog(), 30 * 1000); // 30s after startup
    // Then sweep every POLL_MS
    setInterval(() => this._sweepBacklog(), POLL_MS);

    // Deployed-tasks digest — first run 5 min after startup, then every 3 hours.
    setTimeout(() => this._sendDeployedDigests(), 5 * 60 * 1000);
    setInterval(() => this._sendDeployedDigests(), DEPLOYED_DIGEST_MS);
  }

  /**
   * Sweep DB for any un-emailed notifications missed due to server restart.
   * For each recipient that has pending un-emailed notifications, send immediately.
   */
  async _sweepBacklog() {
    if (!this.db) return;
    try {
      const result = await this.db.query(`
        SELECT DISTINCT n.recipient
        FROM task_notifications n
        JOIN tasks t ON t.id = n.task_id
        WHERE n.emailed_at IS NULL
          AND n.created_at >= NOW() - INTERVAL '24 hours'
          AND t.domain != 'aspect'
        ORDER BY n.recipient
      `);
      for (const row of result.rows) {
        const recipient = row.recipient;
        // Only send if not already queued by the debounce mechanism
        if (!this.pending[recipient] && EMAIL_RECIPIENTS[recipient]) {
          console.log(`[EmailScheduler] Backlog sweep: sending pending notifications for ${recipient}`);
          await this._sendBatch(recipient);
        }
      }
    } catch (err) {
      console.error('[EmailScheduler] Backlog sweep failed:', err.message);
    }
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

    // Also fetch "open items still needing your attention" — tasks where the
    // last comment is not by this recipient and they haven't interacted since.
    // Skip tasks already represented in this batch's notifications.
    const notificationTaskIds = new Set(rows.map(r => r.task_id));
    let needsAttention = [];
    try {
      const commentsService = require('./comments.service');
      const attentionIds = await commentsService.getTasksNeedingAttention(recipient);
      const remaining = attentionIds.filter(id => !notificationTaskIds.has(id));
      if (remaining.length > 0) {
        const attRes = await this.db.query(`
          SELECT id AS task_id, title AS task_title, status AS task_status, domain AS task_domain
          FROM tasks
          WHERE id = ANY($1::int[])
            AND domain = ANY($2::text[])
            AND is_completed = false
          ORDER BY updated_at DESC
        `, [remaining, domains]);
        needsAttention = attRes.rows;
      }
    } catch (err) {
      console.error(`[EmailScheduler] Failed to fetch needs-attention for ${recipient}:`, err.message);
    }

    console.log(`[EmailScheduler] Sending ${rows.length} notification(s) + ${needsAttention.length} needs-attention to ${email}`);

    await sendTaskAttentionEmail({ recipientEmail: email, recipientName: recipient, notifications: rows, needsAttention });

    // Mark all as emailed
    const ids = rows.map(r => r.id);
    await this.db.query(`
      UPDATE task_notifications
      SET emailed_at = NOW()
      WHERE id = ANY($1::int[])
    `, [ids]);

    console.log(`[EmailScheduler] Email sent and ${ids.length} notification(s) marked as emailed.`);
  }

  /**
   * Send a separate "What's New" digest email to each recipient listing every
   * deployed task they haven't dismissed yet. Mirrors the in-app What's New
   * list. Skips recipients whose list is empty.
   */
  async _sendDeployedDigests() {
    if (!this.db) return;
    for (const [recipient, config] of Object.entries(EMAIL_RECIPIENTS)) {
      try {
        const { email, domains } = config;
        const result = await this.db.query(`
          SELECT id AS task_id, title AS task_title, status AS task_status, domain AS task_domain, deployed_at
          FROM tasks
          WHERE deployed_at IS NOT NULL
            AND NOT (COALESCE(deployed_reviewed_by, '[]'::jsonb) ? $1)
            AND domain = ANY($2::text[])
          ORDER BY deployed_at DESC
        `, [recipient, domains]);

        if (result.rows.length === 0) continue;

        console.log(`[EmailScheduler] Sending deployed digest with ${result.rows.length} task(s) to ${email}`);
        await sendDeployedDigestEmail({ recipientEmail: email, recipientName: recipient, tasks: result.rows });
      } catch (err) {
        console.error(`[EmailScheduler] Deployed digest failed for ${recipient}:`, err.message);
      }
    }
  }
}

module.exports = new EmailSchedulerService();
