/**
 * triggerEvaluator — finds the conversations a trigger should act on,
 * and explains, for any single conversation at any past moment, why it
 * did or didn't.
 *
 * See docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * ── The shape, and why it is this shape ────────────────────────────
 *
 * The obvious design for "nudge after 30 minutes of quiet" is a reminder
 * row per conversation holding a `next_due_at`. It was rejected: that
 * value is DERIVED, so the moment an author changes 30 minutes to 2
 * hours, every stored row is silently wrong and needs a rewrite. Here
 * the trigger instead FINDS its own conversations with one indexed
 * query, so changing the number means the next tick is simply correct.
 * There was never anything derived to go stale, and cost scales with
 * how often a trigger fires, not with how many conversations exist.
 *
 * Two stages, deliberately unequal:
 *
 *   1. `candidateSql` (the type's) narrows thousands of conversations to
 *      a handful with a cheap indexed scan. It may over-select.
 *   2. `evaluate` (the type's) is authoritative and pure. The tick runs
 *      it on the candidates; the explainer runs it on facts
 *      reconstructed for one conversation at one past moment. ONE
 *      implementation of the rule, so the two can never disagree — which
 *      is exactly the drift the prompt assembler once had between the
 *      client preview and the server.
 *
 * ── What "at a past moment" can and can't recover ──────────────────
 *
 * Reconstruction is honest because every input is immutable: message
 * timestamps and this trigger's own event rows. What it CANNOT recover
 * is the trigger's configuration at that time (it uses today's) or a
 * Filter that depended on memory which has since changed — which is why
 * the filter's evaluation trail is stored on the event row whenever it
 * ran, pass or fail.
 */

const db = require('../../services/db.pg');
const triggerRegistry = require('../triggers');
const conversationAudience = require('./conversationAudience');

/**
 * Scope: which conversations a trigger may ever touch.
 *
 * `agent_id` is the LEGACY agents row for this slug (that is what
 * `conversations.agent_id` points at, for both V1 and V2). The
 * `metadata->>'kind'` test is what keeps V1 conversations out: they are
 * tagged 'live' or 'builder-preview' only when born in a V2 surface, and
 * firing a V2 crew chain into a V1 conversation would run the wrong
 * engine against the wrong state.
 */
const SCOPE_SQL = `
  c.agent_id = $1
  AND c.status = 'active'
  AND c.kind = 'user'
  AND c.metadata->>'kind' IS NOT NULL
`;

/**
 * Optional restriction to certain conversation SURFACES.
 *
 * `metadata.kind` is 'live' for the customer-facing chat and
 * 'builder-preview' for the chat inside the builder.
 *
 * This exists because a local development server points at the SAME
 * database as production. Without it, a developer switching the clock on
 * to watch a trigger fire would nudge real customers from their laptop.
 * The local runner therefore restricts itself to 'builder-preview';
 * production passes nothing and sees every surface.
 *
 * Deliberately derived from the ENVIRONMENT rather than stored as a
 * setting: settings live in the shared database, so a "local only"
 * setting would be written by local and read by production too — the
 * exact confusion it is meant to prevent.
 */
function kindsClause(kinds, paramIndex) {
  if (!Array.isArray(kinds) || kinds.length === 0) return { sql: '', values: [] };
  return { sql: ` AND c.metadata->>'kind' = ANY($${paramIndex})`, values: [kinds] };
}

/**
 * The fact columns every trigger type evaluates against. Defined once,
 * here, so a type never writes SQL of its own beyond its narrowing —
 * and so `findDue` and `explainAt` compute the same numbers.
 *
 * `$2` is the trigger id in both subqueries.
 */
function factColumns() {
  return `
    c.id                    AS conversation_id,
    c.last_user_message_at  AS last_user_message_at,
    c.last_message_at       AS last_message_at,
    -- A NAIVE column holding UTC wall-clock (decision 16): read as UTC,
    -- or node-postgres takes it as the process's local time and a
    -- "created after the 09:00 slot" check is off by hours.
    (c.created_at AT TIME ZONE 'UTC') AS created_at,
    c.metadata->>'kind'     AS surface,
    c.metadata->>'audience' AS audience,
    (SELECT MAX(e.matched_at) FROM trigger_events e
      WHERE e.conversation_id = c.id AND e.trigger_id = $2) AS last_event_at,
    (SELECT COUNT(*)::int FROM trigger_events e
      WHERE e.conversation_id = c.id AND e.trigger_id = $2
        AND e.matched_at > COALESCE(c.last_user_message_at, to_timestamp(0))
    ) AS attempts_since_last_user_message,
    -- When this trigger actually DELIVERED a message, most recent first.
    -- Timestamps rather than a count because the window is authored and
    -- the count would have to be parameterised per trigger; a short list
    -- keeps evaluate a pure function of facts, config and now, which
    -- is what lets the tick and the explainer agree by construction.
    -- Bounded at 90 days, which is also the ceiling the window allows.
    (SELECT COALESCE(array_agg(e.matched_at ORDER BY e.matched_at DESC), '{}')
       FROM trigger_events e
      WHERE e.conversation_id = c.id AND e.trigger_id = $2
        AND e.outcome = 'spoke'
        AND e.matched_at > now() - interval '90 days'
    ) AS delivered_at
  `;
}

function rowToFacts(row) {
  return {
    conversationId:               row.conversation_id,
    lastUserMessageAt:            row.last_user_message_at,
    lastMessageAt:                row.last_message_at,
    createdAt:                    row.created_at,
    lastEventAt:                  row.last_event_at,
    attemptsSinceLastUserMessage: Number(row.attempts_since_last_user_message) || 0,
    deliveredAt:                  Array.isArray(row.delivered_at) ? row.delivered_at : [],
    surface:                      row.surface || null,
    // Raw metadata.audience (#968) — null when the conversation carries
    // no mark. The clause reads it fail-closed: only 'real' is real.
    audience:                     row.audience || null,
  };
}

/** Window bounds: at least a day, never past what `factColumns` fetches. */
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

/**
 * Envelope clauses — restrictions that belong to TRIGGERS, not to any
 * one type.
 *
 * Returned as ordinary clauses so everything downstream keeps working
 * unchanged: the blocked-reason counting, the "why nothing fired" line,
 * the Activity panel and the explainer all read clauses and none of them
 * needs to know this one came from somewhere else.
 *
 * Pure, like a type's own `evaluate`. That is what makes the tick and
 * the explainer incapable of disagreeing.
 */
function limitClauses({ trigger, facts, now }) {
  const lim = trigger?.limits?.perConversation;
  const max = Number(lim?.max);
  if (!Number.isFinite(max) || max < 1) return [];

  const rawDays = Number(lim?.days);
  const days = Number.isFinite(rawDays)
    ? Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.floor(rawDays)))
    : 7;

  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const sent = (facts.deliveredAt || [])
    .filter(t => new Date(t).getTime() > cutoff).length;

  const window = days === 7 ? 'week' : days === 1 ? 'day' : `${days} days`;
  return [{
    name: 'message cap',
    ok: sent < max,
    why: sent < max
      ? `${sent} of ${max} message${max === 1 ? '' : 's'} in the last ${window}`
      : `already ${sent} message${sent === 1 ? '' : 's'} in the last ${window}, max is ${max}`,
  }];
}

/**
 * A type's own verdict plus the envelope's.
 *
 * Every caller goes through here rather than calling `type.evaluate`
 * directly, so a limit cannot be enforced on the tick and forgotten by
 * the explainer — the failure that would make the explainer lie.
 *
 * Envelope clauses, in the order they are shown:
 *   - "real customer" (#968) — FIRST, because on a test conversation it
 *     is the whole answer to "will it trigger?"; every type inherits it.
 *     Also in gate 1's SQL (`REAL_SQL` in `buildFindDueSql`), so the
 *     sweep never even loads a test conversation.
 *   - the type's own clauses
 *   - "message cap" (limits.perConversation), when configured.
 */
function evaluateAll({ type, facts, trigger, now }) {
  const base = type.evaluate({ facts, trigger, config: trigger.config || {}, now });
  const audience = conversationAudience.audienceClause(facts);
  const extra = limitClauses({ trigger, facts, now });
  return {
    ...base,
    clauses: [audience, ...(base.clauses || []), ...extra],
    ok: !!base.ok && audience.ok && extra.every(c => c.ok),
  };
}

/**
 * Bind a type's `$NAME` placeholders onto positional params, continuing
 * from `startIndex`. Types write readable SQL (`$CUTOFF`) and never have
 * to know their position in the final parameter list.
 */
function bindNamed(where, paramsMap, startIndex) {
  const values = [];
  let i = startIndex;
  const bound = where.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
    if (!(name in paramsMap)) throw new Error(`candidateSql referenced $${name} but did not supply it`);
    values.push(paramsMap[name]);
    return `$${i++}`;
  });
  return { bound, values };
}

/**
 * Gate 1's query, built without touching the database — so the offline
 * battery can assert its shape (the "real customer" condition above all).
 *
 * Scope (agent, active, V2) AND real customers only AND the type's own
 * narrowing AND, off-cloud, the surface wall.
 *
 * @returns {{ sql: string, params: any[] }}
 */
function buildFindDueSql({ legacyAgentId, trigger, now = new Date(), limit = 200, conversationKinds = null, countTest = false }) {
  const type = triggerRegistry.getTriggerType(trigger.typeId);
  if (!type) throw new Error(`Unknown trigger type "${trigger.typeId}"`);

  const { where, params } = type.candidateSql({ trigger, config: trigger.config || {}, now });
  const { bound, values } = bindNamed(where, params, 3);
  // Numbered after the type's own params so a type never has to know
  // whether a surface restriction is in play.
  const kinds = kindsClause(conversationKinds, 3 + values.length);

  // REAL_SQL: triggers reach REAL customers only (#968). On the
  // envelope rather than in each type, like quiet hours and the message
  // limit, so a new type cannot forget it. It is a column compare on
  // rows the agent / activity indexes already narrowed — no join.
  const allParams = [legacyAgentId, String(trigger.id), ...values, ...kinds.values];
  if (countTest) {
    // The status line's "N test conversations skipped": the SAME scope
    // and narrowing with the audience test flipped. One COUNT, no facts.
    // `$2` is still referenced so the parameter list stays identical.
    const sql = `
    SELECT COUNT(*)::int AS n
      FROM conversations c
     WHERE ${SCOPE_SQL}
       AND ${conversationAudience.NOT_REAL_SQL}
       AND $2::text IS NOT NULL
       AND (${bound})${kinds.sql}
  `;
    return { sql, params: allParams, type };
  }
  const sql = `
    SELECT ${factColumns()}
      FROM conversations c
     WHERE ${SCOPE_SQL}
       AND ${conversationAudience.REAL_SQL}
       AND (${bound})${kinds.sql}
     ORDER BY c.last_user_message_at ASC
     LIMIT ${Number(limit)}
  `;
  return { sql, params: allParams, type };
}

/**
 * How many TEST conversations the type's narrowing would have picked —
 * the "N test conversations skipped" on the status line (#968), so
 * "working, but everything here is a test" doesn't read as "nobody was
 * quiet enough". Same narrowing as gate 1, so it can over-count exactly
 * as `candidateSql` over-selects (Silence's spacing / cap are not in SQL).
 */
async function countSkippedTest({ legacyAgentId, trigger, now = new Date(), conversationKinds = null }) {
  const { sql, params } = buildFindDueSql({ legacyAgentId, trigger, now, conversationKinds, countTest: true });
  const { rows } = await db.query(sql, params);
  return Number(rows[0] && rows[0].n) || 0;
}

/**
 * Find the conversations this trigger should act on right now.
 *
 * @param {object} args
 * @param {number} args.legacyAgentId  `conversations.agent_id` for this agent's slug
 * @param {object} args.trigger        the authored AgentTrigger
 * @param {Date}   [args.now]
 * @param {number} [args.limit]        safety cap on one sweep
 * @returns {Promise<Array<{ facts, evaluation }>>} only conversations
 *   `evaluate()` accepted, each with its clause trail so the caller can
 *   record WHY it matched.
 */
async function findDue({ legacyAgentId, trigger, now = new Date(), limit = 200, conversationKinds = null }) {
  const { sql, params, type } = buildFindDueSql({ legacyAgentId, trigger, now, limit, conversationKinds });

  const { rows } = await db.query(sql, params);

  // `candidateSql` is only ever a superset — `evaluate` decides.
  //
  // Rejections are counted by which clause stopped them, because "due:
  // 0" on its own is a lie by omission. A conversation that is quiet but
  // has used up its attempts is a completely different situation from
  // one where nobody has gone quiet, and the status line said the latter
  // for both.
  const due = [];
  const blocked = {};
  for (const row of rows) {
    const facts = rowToFacts(row);
    const evaluation = evaluateAll({ type, facts, trigger, now });
    if (evaluation.ok) {
      due.push({ facts, evaluation });
    } else {
      const first = (evaluation.clauses || []).find(c => !c.ok);
      const name = first ? first.name : 'unknown';
      blocked[name] = (blocked[name] || 0) + 1;
    }
  }
  return { due, blocked, considered: rows.length };
}

/**
 * Evaluate one conversation, right now, WITHOUT the cheap narrowing —
 * the "Check" affordance. Answers "would this fire, and if not, which
 * clause stopped it", which is the question an author asks while tuning.
 */
async function checkOne({ trigger, conversationId, now = new Date() }) {
  const type = triggerRegistry.getTriggerType(trigger.typeId);
  if (!type) throw new Error(`Unknown trigger type "${trigger.typeId}"`);

  const { rows } = await db.query(
    `SELECT ${factColumns()} FROM conversations c WHERE c.id = $1`,
    [Number(conversationId), String(trigger.id)],
  );
  if (rows.length === 0) throw new Error(`Conversation ${conversationId} not found`);

  const facts = rowToFacts(rows[0]);
  const evaluation = evaluateAll({ type, facts, trigger, now });
  return { facts, evaluation, at: now };
}

/**
 * Explain one conversation at a PAST moment — "why did #412 get nothing
 * at 15:00?".
 *
 * Facts are reconstructed rather than looked up in a log: the customer's
 * last word as of `at` comes from the messages table, and this trigger's
 * attempts as of `at` from its own event rows. Both are immutable, so
 * the arithmetic is exactly what it was — which beats a log, because a
 * log would only record the verdict and this shows the working.
 *
 * Ceiling: the trigger's CONFIG is today's. Change the threshold and an
 * old moment is explained with the new number. Callers surface this
 * ("evaluated with current settings") rather than hiding it.
 */
async function explainAt({ trigger, conversationId, at }) {
  const type = triggerRegistry.getTriggerType(trigger.typeId);
  if (!type) throw new Error(`Unknown trigger type "${trigger.typeId}"`);
  const when = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(when.getTime())) throw new Error('explainAt: invalid `at`');

  const { rows } = await db.query(
    `
    SELECT
      c.id AS conversation_id,
      (c.created_at AT TIME ZONE 'UTC') AS created_at,
      c.metadata->>'kind' AS surface,
      -- The mark as it is NOW (#968): it has no history, so the
      -- explainer reports today's mark for a past moment too.
      c.metadata->>'audience' AS audience,
      -- messages.created_at is a NAIVE timestamp (UTC wall-clock)
      -- while $3 arrives as a real instant. Comparing them directly
      -- is off by the Node process's UTC offset — silently, and in a
      -- direction that makes "an hour ago" look like the future. The
      -- explicit AT TIME ZONE 'UTC' is what makes the comparison mean
      -- what it reads as. See migration 046.
      (SELECT MAX(m.created_at AT TIME ZONE 'UTC') FROM messages m
        WHERE m.conversation_id = c.id AND m.role = 'user'
          AND (m.created_at AT TIME ZONE 'UTC') <= $3
      ) AS last_user_message_at,
      (SELECT MAX(m.created_at AT TIME ZONE 'UTC') FROM messages m
        WHERE m.conversation_id = c.id AND (m.created_at AT TIME ZONE 'UTC') <= $3
      ) AS last_message_at,
      (SELECT MAX(e.matched_at) FROM trigger_events e
        WHERE e.conversation_id = c.id AND e.trigger_id = $2 AND e.matched_at <= $3
      ) AS last_event_at,
      (SELECT COUNT(*)::int FROM trigger_events e
        WHERE e.conversation_id = c.id AND e.trigger_id = $2 AND e.matched_at <= $3
          AND e.matched_at > COALESCE((
                SELECT MAX(m2.created_at AT TIME ZONE 'UTC') FROM messages m2
                 WHERE m2.conversation_id = c.id AND m2.role = 'user'
                   AND (m2.created_at AT TIME ZONE 'UTC') <= $3
              ), to_timestamp(0))
      ) AS attempts_since_last_user_message,
      -- As of $3, so the explainer answers about the moment asked about
      -- rather than about now.
      (SELECT COALESCE(array_agg(e.matched_at ORDER BY e.matched_at DESC), '{}')
         FROM trigger_events e
        WHERE e.conversation_id = c.id AND e.trigger_id = $2
          AND e.outcome = 'spoke'
          AND e.matched_at <= $3
          AND e.matched_at > $3 - interval '90 days'
      ) AS delivered_at
     FROM conversations c
    WHERE c.id = $1
    `,
    [Number(conversationId), String(trigger.id), when],
  );
  if (rows.length === 0) throw new Error(`Conversation ${conversationId} not found`);

  const facts = rowToFacts(rows[0]);
  const evaluation = evaluateAll({ type, facts, trigger, now: when });
  return {
    at: when,
    facts,
    evaluation,
    configCaveat: 'Evaluated with the trigger\'s current settings — if they were changed since, the numbers reflect today\'s rule, not the one that was live then.',
  };
}

/**
 * Is `now` inside the trigger's quiet-hours window?
 *
 * Evaluated AFTER a conversation has matched, on purpose. Folding it
 * into the query would mean nothing at 3am ever creates a row, and an
 * author would have no way to see that the trigger wanted to fire all
 * night. A handful of extra overnight rows is a cheap price for that.
 *
 * A window whose `to` is earlier than its `from` wraps midnight, which
 * is the common case (22:00 → 08:00).
 *
 * @returns {{ suppressed: boolean, why: string }}
 */
function checkQuietHours(quietHours, now = new Date()) {
  if (!quietHours || !quietHours.from || !quietHours.to) {
    return { suppressed: false, why: 'no quiet hours configured' };
  }
  const tz = quietHours.timezone || 'UTC';
  let hhmm;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const h = parts.find(p => p.type === 'hour').value;
    const m = parts.find(p => p.type === 'minute').value;
    hhmm = `${h}:${m}`;
  } catch {
    // An invalid timezone must not silently suppress every nudge, nor
    // silently ignore the author's intent — fail open and say so.
    return { suppressed: false, why: `unknown timezone "${tz}" — quiet hours not applied` };
  }

  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const nowMin  = toMin(hhmm);
  const fromMin = toMin(quietHours.from);
  const toMin_  = toMin(quietHours.to);

  const inside = fromMin <= toMin_
    ? (nowMin >= fromMin && nowMin < toMin_)          // same-day window
    : (nowMin >= fromMin || nowMin < toMin_);         // wraps midnight

  return {
    suppressed: inside,
    why: inside
      ? `${hhmm} ${tz} is inside quiet hours ${quietHours.from}–${quietHours.to}`
      : `${hhmm} ${tz} is outside quiet hours ${quietHours.from}–${quietHours.to}`,
  };
}

/**
 * When this trigger will next act, for types that fire on the calendar
 * (`type.nextFire`). Null for types without one (Silence: its next fire
 * differs per conversation) and for a schedule with nothing left.
 *
 * Quiet hours are applied here so the card never promises a send that
 * will be skipped: a slot inside the window is stepped over and counted
 * in `skippedForQuietHours`, so the card can say so.
 *
 * @returns {{ at: Date|null, skippedForQuietHours: number } | null}
 */
function nextFireOf(trigger, now = new Date()) {
  const type = triggerRegistry.getTriggerType(trigger?.typeId);
  if (!type || typeof type.nextFire !== 'function') return null;
  let from = now;
  let skipped = 0;
  for (let i = 0; i < 60; i++) {
    const at = type.nextFire({ trigger, config: trigger.config || {}, now: from });
    if (!at) return { at: null, skippedForQuietHours: skipped };
    if (!checkQuietHours(trigger.quietHours, at).suppressed) return { at, skippedForQuietHours: skipped };
    skipped += 1;
    from = new Date(at.getTime() + 1);
  }
  // Sixty slots in a row inside quiet hours: every time is in the window.
  return { at: null, skippedForQuietHours: skipped };
}

module.exports = {
  nextFireOf,
  findDue,
  checkOne,
  explainAt,
  checkQuietHours,
  evaluateAll,
  buildFindDueSql,
  countSkippedTest,
  SCOPE_SQL,
};
