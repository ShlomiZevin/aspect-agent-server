/**
 * conversationMeta — the ONE way to write `conversations.metadata`.
 *
 * Every writer used to read the row, spread the copy and write the
 * whole object back (`{ ...convRow.metadata, currentCrewId }`). A turn
 * reads its copy when it starts and writes it back seconds later (a
 * transition, a crew override, the auto-name), so any key another
 * request wrote in between was silently put back. For most keys that
 * was a nuisance; for `audience` (#968) it is a safety bug: a person
 * marks a customer's conversation TEST, the in-flight turn writes its
 * old copy, and it is REAL again — triggers could message it.
 *
 * So writers send only the keys they change, and the database merges
 * them into whatever is there NOW:
 *
 *   metadata = COALESCE(metadata, '{}'::jsonb) || $patch::jsonb
 *
 * Top-level keys only (`||` is a shallow merge) — the same semantics as
 * the old spread, minus the stale copy.
 */

const { sql } = require('drizzle-orm');
const { conversations } = require('../../db/schema');

/**
 * The `.set({ metadata: … })` value that merges `patch` into the row's
 * CURRENT metadata. `patch` must hold only the keys being changed.
 */
function mergeMetadata(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('mergeMetadata: patch must be an object of the keys to change');
  }
  return sql`COALESCE(${conversations.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

module.exports = { mergeMetadata };
