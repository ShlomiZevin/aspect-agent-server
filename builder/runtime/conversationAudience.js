/**
 * conversationAudience — is a conversation a REAL customer's, or a test? (task #968)
 *
 * Triggers (Silence, Schedule, every future type) reach REAL customers
 * only. Everything else — the builder's own chat, simulations started
 * through the Builder MCP, a teammate trying the customer chat — is a
 * test, and a trigger must never spend a model call on it or message it
 * by itself.
 *
 * ── Where the mark lives ───────────────────────────────────────────
 *
 *   conversations.metadata.audience = 'real' | 'test'
 *
 * In the existing jsonb, no column, no migration. Decided ONCE, when the
 * conversation is created (`audienceAtCreation`), and stored on the
 * conversation — so unchecking a user's "Real customer" box later does
 * NOT rewrite their past conversations, and the trigger query never has
 * to join `users`.
 *
 * ── Fail closed ────────────────────────────────────────────────────
 *
 * Only the exact string 'real' is real. No mark, 'test', a typo, a
 * conversation older than this feature: all TEST. A message nobody
 * should have received is worse than one not sent.
 *
 * ── Who becomes real ───────────────────────────────────────────────
 *
 * A conversation started in the CUSTOMER chat (`metadata.kind = 'live'`)
 * by a user an admin marked "Real customer" in Admin → Users
 * (`users.metadata.realCustomer === true`). Customers reach that chat
 * only through users created there. Anything else starts as test and
 * can be flipped by hand (builder chat header, Admin → Conversations,
 * or the MCP for a simulation).
 */

const REAL = 'real';
const TEST = 'test';

/** The one SQL condition gate 1 adds (conversations aliased `c`). A
 *  plain jsonb text compare on rows the agent / activity indexes have
 *  already narrowed — no join, no subquery. */
const REAL_SQL = `c.metadata->>'audience' = 'real'`;
/** Its exact complement (no mark counts as test) — the status line's count. */
const NOT_REAL_SQL = `COALESCE(c.metadata->>'audience', '') <> 'real'`;

/** Was this user marked "Real customer" in Admin → Users? Strictly `true`. */
function isRealCustomerUser(user) {
  return !!(user && user.metadata && user.metadata.realCustomer === true);
}

/**
 * The mark a NEW conversation is born with.
 *
 * @param {object} a
 * @param {string} a.surface  metadata.kind: 'live' | 'builder-preview' | 'simulation'
 * @param {object} [a.user]   the owning users row (only `metadata` is read)
 * @returns {'real'|'test'}
 */
function audienceAtCreation({ surface, user } = {}) {
  return surface === 'live' && isRealCustomerUser(user) ? REAL : TEST;
}

/** A conversation's mark, read fail-closed. */
function audienceOf(metadata) {
  return metadata && metadata.audience === REAL ? REAL : TEST;
}

/** Parse what a caller asked to set — only 'real' and 'test' exist. */
function parseAudience(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return v === REAL || v === TEST ? v : null;
}

/**
 * The trigger-envelope clause. Pure, like every clause: the tick, Check,
 * "Will it trigger?" and the explainer all read it from `evaluateAll`.
 *
 * `facts.audience` is the raw `metadata->>'audience'` (null when absent).
 */
function audienceClause(facts) {
  const raw = facts ? facts.audience : null;
  const real = raw === REAL;
  return {
    name: 'real customer',
    ok: real,
    why: real
      ? 'a real customer\'s conversation'
      : raw === TEST
        ? 'a test conversation — triggers reach only real customers (mark it real to include it)'
        : 'not marked real, so it counts as a test — triggers reach only real customers',
  };
}

module.exports = {
  REAL,
  TEST,
  REAL_SQL,
  NOT_REAL_SQL,
  isRealCustomerUser,
  audienceAtCreation,
  audienceOf,
  parseAudience,
  audienceClause,
};
