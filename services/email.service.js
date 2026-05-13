const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendLybiContactEmail({ name, email, company, message }) {
  const recipients = 'noa@freeda.ai, noa@lybi.ai';

  const text = [
    `New contact form submission from Lybi landing page`,
    ``,
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Company: ${company || '—'}`,
    `Message: ${message || '—'}`,
  ].join('\n');

  await transporter.sendMail({
    from: `"Lybi Contact" <${process.env.GMAIL_USER}>`,
    to: recipients,
    subject: `New contact: ${name}`,
    text,
  });
}

// Friendly labels for notification types
const NOTIFICATION_TYPE_LABELS = {
  mention: 'You were mentioned',
  comment_on_assigned: 'New comment on your task',
  assigned: 'Task assigned to you',
  deployed: 'Task deployed',
};

function notificationTypeLabel(type) {
  if (NOTIFICATION_TYPE_LABELS[type]) return NOTIFICATION_TYPE_LABELS[type];
  if (type && type.startsWith('assigned_by:')) return `Assigned by ${type.slice(12)}`;
  if (type && type.startsWith('moved_to_')) return `Task moved to ${type.slice(9).replace(/_/g, ' ')}`;
  return type;
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Send a batched task-board attention email to a recipient.
 * @param {object} params
 * @param {string} params.recipientEmail
 * @param {string} params.recipientName
 * @param {Array}  params.notifications - rows from DB join (task_id, task_title, type, comment_author, comment_content, created_at)
 */
function deriveBoardName(notifications) {
  const domains = new Set(notifications.map(n => n.task_domain).filter(Boolean));
  if (domains.size === 1) {
    const d = [...domains][0];
    return `${d.charAt(0).toUpperCase() + d.slice(1)} Board`;
  }
  return 'Task Board';
}

async function sendTaskAttentionEmail({ recipientEmail, recipientName, notifications }) {
  const count = notifications.length;
  const boardName = deriveBoardName(notifications);
  const subject = count === 1
    ? `${boardName} - 1 item needs your attention`
    : `${boardName} - ${count} items need your attention`;

  // Group by task to avoid repeating task title
  const byTask = {};
  for (const n of notifications) {
    if (!byTask[n.task_id]) {
      byTask[n.task_id] = { id: n.task_id, title: n.task_title, status: n.task_status, events: [] };
    }
    byTask[n.task_id].events.push(n);
  }

  const taskRows = Object.values(byTask).map(task => {
    const eventLines = task.events.map(e => {
      const label = notificationTypeLabel(e.type);
      const snippet = e.comment_content ? ` — "${stripHtml(e.comment_content).slice(0, 120)}"` : '';
      const by = e.comment_author ? ` by ${e.comment_author}` : '';
      return `<li style="margin:4px 0;color:#374151;">${label}${by}${snippet}</li>`;
    }).join('');

    const statusBadge = {
      todo: '#6B7280',
      in_progress: '#2563EB',
      done: '#16A34A',
    }[task.status] || '#6B7280';

    return `
      <tr>
        <td style="padding:16px;border-bottom:1px solid #E5E7EB;vertical-align:top;">
          <div style="font-weight:600;font-size:15px;margin-bottom:6px;">
            <a href="https://lybi.ai/tasks/${task.id}" style="color:#2563EB;text-decoration:none;font-weight:600;">${task.title}</a>
            <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:${statusBadge};color:#fff;font-size:11px;font-weight:500;vertical-align:middle;">${task.status.replace('_', ' ')}</span>
          </div>
          <ul style="margin:0;padding-left:18px;">${eventLines}</ul>
        </td>
      </tr>`;
  }).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:#2563EB;padding:24px 32px;">
            <span style="color:#fff;font-size:20px;font-weight:700;">${boardName}</span>
            <span style="color:#BFDBFE;font-size:14px;margin-left:12px;">Attention needed</span>
          </td>
        </tr>

        <!-- Intro -->
        <tr>
          <td style="padding:24px 32px 8px;">
            <p style="margin:0;color:#374151;font-size:15px;">
              Hi ${recipientName}, you have <strong>${count} item${count > 1 ? 's' : ''}</strong> that need${count === 1 ? 's' : ''} your attention:
            </p>
          </td>
        </tr>

        <!-- Task list -->
        <tr>
          <td style="padding:8px 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:6px;overflow:hidden;">
              ${taskRows}
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #E5E7EB;background:#F9FAFB;">
            <p style="margin:0;color:#9CA3AF;font-size:12px;">
              This is an automated notification from your task board.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from: `"${boardName}" <${process.env.GMAIL_USER}>`,
    to: recipientEmail,
    subject,
    html,
  });
}

async function sendAgentErrorEmail({ agentName, contactEmails, errorMessage, conversationId }) {
  const recipients = contactEmails.filter(Boolean).join(', ');
  if (!recipients) return;

  const subject = `Agent error: ${agentName}`;
  const time = new Date().toUTCString();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);overflow:hidden;">

        <tr>
          <td style="background:#2563EB;padding:24px 32px;">
            <span style="color:#fff;font-size:20px;font-weight:700;">${agentName}</span>
            <span style="color:#BFDBFE;font-size:14px;margin-left:12px;">Error alert</span>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 32px 8px;">
            <p style="margin:0;color:#374151;font-size:15px;">A chat error occurred and the user received an error message.</p>
          </td>
        </tr>

        <tr>
          <td style="padding:8px 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:6px;overflow:hidden;">
              <tr>
                <td style="padding:16px;border-bottom:1px solid #E5E7EB;vertical-align:top;">
                  <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Error</div>
                  <div style="font-size:13px;color:#B91C1C;font-family:monospace;word-break:break-all;">${errorMessage || 'Unknown error'}</div>
                </td>
              </tr>
              <tr>
                <td style="padding:12px 16px;border-bottom:1px solid #E5E7EB;">
                  <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Conversation ID</div>
                  <div style="font-size:13px;color:#374151;font-family:monospace;">${conversationId || '—'}</div>
                </td>
              </tr>
              <tr>
                <td style="padding:12px 16px;">
                  <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Time</div>
                  <div style="font-size:13px;color:#374151;">${time}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 32px;border-top:1px solid #E5E7EB;background:#F9FAFB;">
            <p style="margin:0;color:#9CA3AF;font-size:12px;">Automated alert from your agent platform. Configure recipients in the agent admin dashboard.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from: `"${agentName} Alerts" <${process.env.GMAIL_USER}>`,
    to: recipients,
    subject,
    html,
    text: `An error occurred in the ${agentName} agent chat.\n\nError: ${errorMessage || 'Unknown error'}\nConversation: ${conversationId || '—'}\nTime: ${time}`,
  });
}

module.exports = { sendLybiContactEmail, sendTaskAttentionEmail, sendAgentErrorEmail };
