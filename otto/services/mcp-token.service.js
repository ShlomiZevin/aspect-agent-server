/**
 * Access tokens for the "build with your own AI" door (task #96).
 *
 * One token = one person in one client. It is an HMAC, not a stored row:
 *
 *   <base64url(viewerId)>.<hmac(clientSecret, slug + "\n" + viewerId)>
 *
 * - The SLUG is inside the signature, so a ZolStock token presented on any
 *   other client's URL fails verification — that is the cross-client
 *   isolation guarantee, and it does not depend on the route remembering to
 *   compare anything.
 * - The VIEWER id is the same anonymous per-browser id Otto stamps drafts
 *   with (`createdBy`, task #92). Screens saved through the door therefore
 *   belong to the person who copied the link, appear on THEIR shelf, and stay
 *   private to them until they press "Save to Apps".
 * - The SECRET is per client, random, and lives in the `ai-builder` module's
 *   binding. Switching the module off stops every token at once (the gate
 *   checks live-ness first); rotating the secret invalidates every link the
 *   client was ever given.
 */

const crypto = require('crypto');
const moduleService = require('../../modules/services/module.service');

const MODULE_ID = 'ai-builder';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function sign(secret, slug, viewerId) {
  return b64url(crypto.createHmac('sha256', secret).update(`${slug}\n${viewerId}`).digest()).slice(0, 32);
}

/** The client's signing secret, created on first use. */
async function secretFor(datasetId) {
  const state = await moduleService.getState(datasetId, MODULE_ID);
  if (state?.binding?.secret) return state.binding.secret;
  await moduleService.setBinding(datasetId, MODULE_ID, { secret: b64url(crypto.randomBytes(32)) }, null, 'ai-builder');
  // Re-read rather than trust our own value: two first requests racing would
  // each write a secret, and only the one that landed last is real.
  const after = await moduleService.getState(datasetId, MODULE_ID);
  return after.binding.secret;
}

/** Is the door open for this client? Both switches, read the one true way. */
async function doorOpen(datasetId) {
  const live = await moduleService.getLiveModules(datasetId);
  const ids = new Set(live.map(x => x.descriptor.id));
  return ids.has(MODULE_ID) && ids.has('otto');
}

async function issue(datasetId, viewerId) {
  const secret = await secretFor(datasetId);
  return `${b64url(viewerId)}.${sign(secret, datasetId, viewerId)}`;
}

/**
 * @returns {Promise<string|null>} the viewer id the token was issued to, or
 *   null when it is malformed, forged, or from another client.
 */
async function verify(datasetId, token) {
  const [idPart, sig] = String(token || '').split('.');
  if (!idPart || !sig) return null;
  let viewerId;
  try { viewerId = fromB64url(idPart); } catch { return null; }
  if (!viewerId || viewerId.length > 80) return null;

  const state = await moduleService.getState(datasetId, MODULE_ID);
  const secret = state?.binding?.secret;
  if (!secret) return null;

  const expected = Buffer.from(sign(secret, datasetId, viewerId));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return viewerId;
}

module.exports = { issue, verify, doorOpen, MODULE_ID };
