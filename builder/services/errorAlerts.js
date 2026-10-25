/**
 * Error center — email alerts (task #903, step 6).
 *
 * After every recorded error: if its kind is serious (errorRules `alert`)
 * and it happened in a CUSTOMER conversation or in the server itself, and
 * its group is brand new — or was marked handled and came back — email
 * Shlomi once. The claim in errorCenter.claimAlert makes it one email per
 * appearance even with many errors at once or several server instances.
 *
 * Builder and simulation errors never email: their author is watching the
 * screen, and a load test can produce many on purpose.
 *
 *   ERROR_ALERT_EMAIL   recipient (default shlomi@boostart.io, decided in #903)
 *   ERROR_ALERTS=off    switch alerts off (e.g. a local server)
 *   LYBI_APP_URL        where the Admin link points (default https://lybi.ai)
 *
 * Registered once, from server.js. Never throws into recording.
 */

const errorCenter = require('./errorCenter');
const errorRules = require('./errorRules');

const TO = process.env.ERROR_ALERT_EMAIL || 'shlomi@boostart.io';
const APP_URL = String(process.env.LYBI_APP_URL || 'https://lybi.ai').replace(/\/+$/, '');

/** Should this written error alert? Pure — exported for the battery. */
function isAlertable(w) {
  if (!errorRules.ruleFor(w.kind).alert) return false;
  return w.source === 'customer' || (w.source == null && w.area === 'server') || (w.source == null && !w.conversationId);
}

async function onWritten(w) {
  if (process.env.ERROR_ALERTS === 'off') return;
  if (!isAlertable(w)) return;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
  const before = await errorCenter.readGroupRow({ slug: w.agentSlug, fingerprint: w.fingerprint });
  const claimed = await errorCenter.claimAlert({ slug: w.agentSlug, fingerprint: w.fingerprint });
  if (!claimed) return;
  const { sendErrorCenterAlert } = require('../../services/email.service');
  await sendErrorCenterAlert({
    to: TO,
    agentSlug: w.agentSlug,
    what: before && before.status === 'handled' ? 'back' : 'new',
    error: w,
    link: w.agentSlug ? `${APP_URL}/${encodeURIComponent(w.agentSlug)}/builder/admin/errors` : null,
  });
  console.log(`[error-center] alert sent to ${TO}: ${w.agentSlug || 'server'} · ${w.message.slice(0, 80)}`);
}

let registered = false;
function register() {
  if (registered) return;
  registered = true;
  errorCenter.onWrite(onWritten);
}

module.exports = { register, isAlertable, _internal: { onWritten } };
