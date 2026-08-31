/**
 * Aspect Modules — notifications. Real interface, mocked delivery (D5).
 *
 * The settings, the events and the provider contract are real; the default
 * provider writes to `module_outbox` instead of sending anything, and the
 * admin tab renders those rows in the run report. Swapping in a real email
 * provider later is a provider change, not a rebuild — which is the whole
 * point of putting the seam here now rather than later.
 *
 * Provider contract:
 *   async send({ datasetId, moduleId, runId, event, payload, recipients })
 *
 * Nothing in here throws at the caller. A notification that cannot be
 * recorded must never fail the thing it was reporting on — an init that
 * succeeded and then blew up trying to announce itself would be reported as
 * a failure, which is worse than a missing notification.
 */

const db = require('../services/db.pg');
const { moduleOutbox } = require('../db/schema');
const moduleService = require('./services/module.service');

/** The mocked default: records what WOULD have been sent. */
const outboxProvider = {
  name: 'outbox',
  async send({ datasetId, moduleId, runId, event, payload, recipients }) {
    const drizzle = db.getDrizzle();
    const [row] = await drizzle.insert(moduleOutbox).values({
      datasetId, moduleId,
      runId: runId ?? null,
      event,
      recipients: recipients || [],
      payload: payload || {},
      provider: 'outbox',
    }).returning();
    return row;
  },
};

let activeProvider = outboxProvider;

/** Swap the provider (the push phase; also used by tests). */
function setProvider(provider) {
  activeProvider = provider || outboxProvider;
}
function getProviderName() {
  return activeProvider?.name || 'outbox';
}

/**
 * Emit one module event.
 *
 * Recipients and the per-event toggle come from the module's own settings, so
 * turning an event off in the admin tab genuinely stops it rather than
 * hiding it after the fact.
 *
 * @returns {{sent: boolean, reason?: string, row?: object}}
 */
async function emit({ datasetId, moduleId, runId, event, payload }) {
  try {
    const mod = await moduleService.getForDataset(datasetId, moduleId);
    if (!mod) return { sent: false, reason: 'unknown dataset or module' };

    // An event the module does not declare is a programming error, not
    // something to deliver — surface it in the log rather than silently
    // inventing a notification type.
    if (!mod.notificationEvents.includes(event)) {
      console.warn(`[modules] ${datasetId}/${moduleId}: undeclared event '${event}' — not sent`);
      return { sent: false, reason: 'undeclared event' };
    }

    const toggles = mod.settings?.notificationEvents;
    // Absent toggles mean "all on" — the settings field is optional and its
    // default is every event enabled.
    const enabled = !toggles || toggles[event] !== false;
    if (!enabled) return { sent: false, reason: 'event switched off' };

    const recipients = normaliseRecipients(mod.settings?.notificationEmails);
    if (!recipients.length) return { sent: false, reason: 'no recipients configured' };

    const row = await activeProvider.send({
      datasetId, moduleId, runId, event, payload, recipients,
    });
    console.log(`[modules] ${datasetId}/${moduleId}: ${event} -> ${recipients.join(', ')} (${getProviderName()})`);
    return { sent: true, row };
  } catch (err) {
    // Deliberately swallowed. See the file header.
    console.error(`[modules] notification for ${datasetId}/${moduleId} failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

function normaliseRecipients(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;\s]+/);
  return list.map(s => String(s).trim()).filter(Boolean);
}

/** What the admin tab's run report renders. */
async function listOutbox(datasetId, moduleId, limit = 50) {
  const drizzle = db.getDrizzle();
  // Parameters, not interpolation. The hand-escaping this replaces was correct,
  // but it was the one query in the module that had to be read to know that —
  // and the next person to copy it will not escape.
  const { rows } = await db.query(
    `SELECT id, run_id, event, recipients, payload, provider, created_at
       FROM module_outbox
      WHERE dataset_id = $1 AND module_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [String(datasetId), String(moduleId), Number(limit) || 50],
  );
  return rows;
}

module.exports = { emit, listOutbox, setProvider, getProviderName, outboxProvider, normaliseRecipients };
