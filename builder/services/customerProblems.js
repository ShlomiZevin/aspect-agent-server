/**
 * Customer-chat problems (task #985) — what went wrong for CUSTOMERS, in
 * plain Hebrew, for people who are not technical.
 *
 * Read by the management center's errors page (client `/lybi/manage/<slug>`,
 * API `builder/routes/manageRoute.js`) and by the Builder MCP
 * (`GET /builder/mcp/agents/:slug/customer-problems`). Both print the
 * sentences from THIS file, so the page and an AI assistant say the same
 * words. Change wording here, nowhere else. The conversations page
 * (`/lybi/manage/<slug>/conversations`, MCP `…/customer-conversations`, #1001)
 * reads listConversations — the same problems, put on their conversations.
 *
 * ── What counts as a problem ───────────────────────────────────────
 *
 *  1. Error Center rows (builder/services/errorCenter.js) with
 *     `source = 'customer'` — the outside chat only, never the Builder's
 *     test chat or simulations. Groups an admin marked "Ignored" in
 *     Admin → Errors are left out (known and harmless). The rows of ONE
 *     customer turn (a model call that was retried, then the add-on, then
 *     the turn) become ONE problem: keyed by the turn's reply message, or
 *     — for errors with no reply message — by conversation + area + a
 *     10-minute bucket.
 *  2. "No reply" — computed at read time, nothing is written: a customer
 *     conversation (`metadata.kind = 'live'`) whose LAST customer message
 *     has no non-empty assistant message after it, NO_REPLY_MINUTES after
 *     it was sent. (The runtime reserves an empty assistant row at the
 *     start of every turn, so "non-empty" is what tells a real answer.)
 *     It catches what throws nothing: a turn killed with its instance, a
 *     reply that never got written. Skipped when an Error Center problem
 *     already covers that turn.
 *  3. "Slow reply" — the customer got an answer, but it took longer than
 *     SLOW_REPLY_MS: read from `messages.metadata.replyTiming`, which the
 *     runtime writes on every reply since round 3 (builder/runtime/replyTiming.js).
 *     Older replies have no timing and never show. Chip "nothing to do",
 *     unless the agent had SLOW_REPEAT_PER_DAY slow replies that day.
 *
 * Every row carries `audience` ('real' | 'test', #968, fail closed) so the
 * page can tag test conversations — rows are never hidden for it.
 *
 * Every error row also carries `detail` (#1001): WHICH part failed and why,
 * one plain line — the add-on's own name as the author sees it in the
 * Builder (or the area when there is no add-on) + a plain reason from
 * REASONS_BY_CODE / REASONS_BY_KIND. Never empty.
 *
 * ── The period and every conversation (#1001) ─────────────────────
 *
 *  The period is `today`, `week` (today + 6 days before) or a custom
 *  `from`–`to` (Israel days, inclusive, at most MAX_RANGE_DAYS, never past
 *  today). listConversations lists EVERY customer conversation with a customer
 *  message in the period — plus any conversation (or conversation-less
 *  problem) that only has a problem in it — each with its status:
 *  'act' (a problem someone should act on), 'info' (a problem, nothing to
 *  do) or 'ok', and the ids of its problems. At most MAX_CONVERSATIONS rows;
 *  the ones with a problem always make the cut.
 *
 * ── Did the customer get an answer? ────────────────────────────────
 *
 *  A turn's reply message with text → answered (the platform got past
 *  the error); missing or empty → no answer. Errors with no reply message:
 *  answered when an assistant message with text came after the error.
 *  Errors only in the background lanes (offline, Profiler, Live Brain)
 *  happen after the reply — the customer did not notice.
 *
 * Nothing here exposes codes, stacks or model names: the page links to
 * Admin → Errors for those.
 */

const db = require('../../services/db.pg');
const { audienceOf } = require('../runtime/conversationAudience');

/** A customer message still unanswered after this many minutes is a problem. */
const NO_REPLY_MINUTES = 3;
/** A reply that took longer than this (from the customer's message to the reply) is a "slow reply". */
const SLOW_REPLY_MS = 60 * 1000;
/** This many slow replies of one agent on one day (Israel time) = it repeats → call Shlomi. */
const SLOW_REPEAT_PER_DAY = 3;
const MAX_PROBLEMS = 200;
const LAST_MESSAGE_CHARS = 280;
const TZ = 'Asia/Jerusalem';
const RANGES = ['today', 'week', 'custom'];
/** A custom period: at most this many days (inclusive). */
const MAX_RANGE_DAYS = 92;
/** The conversations list: at most this many rows (problems always included). */
const MAX_CONVERSATIONS = 500;
/** How many conversations one read looks at (the tiles count all of them). */
const CONVERSATIONS_READ = 5000;

/** A refused period — the routes answer 400 { code: 'bad_range' }. */
class BadRangeError extends Error {
  constructor(message) { super(message); this.code = 'bad_range'; this.status = 400; }
}

// ─── The plain-language table — one place ──────────────────────────

/**
 * The "what to do" chips — EVERY row has one, so the reader always knows
 * whether to act. `tone: 'act'` = someone should act (pink); `'ok'` =
 * nothing to do (green).
 */
const ACTIONS = {
  customer:  { id: 'customer', text: 'כדאי לפנות ללקוח', tone: 'act' },
  shlomi:    { id: 'shlomi', text: 'פנו לשלומי', tone: 'act' },
  auto:      { id: 'auto', text: 'תוקן אוטומטית', tone: 'ok' },
  answered:  { id: 'answered', text: 'לא צריך לעשות כלום', tone: 'ok' },
  unnoticed: { id: 'unnoticed', text: 'לא צריך לעשות כלום', tone: 'ok' },
};

/** The one line under the customer's message: how it ended. */
const OUTCOMES = {
  noAnswer:      'לא התקבלה תשובה לאחר מכן',
  answeredLater: 'בסוף הלקוח קיבל תשובה',
  answered:      'השיחה המשיכה כרגיל',
  background:    'השיחה המשיכה כרגיל',
  triggerFailed: 'ההודעה לא יצאה',
};

// The "for dummies" test, for every sentence below: say what the CUSTOMER
// experienced, never how the agent works inside (no "stage", "add-on",
// "model", "credit", "database"). One short sentence.
const SMALL_GLITCH = 'הלקוח קיבל תשובה, אבל משהו קטן מאחורי הקלעים לא עבד';
const TEMP_GLITCH = 'הייתה תקלה זמנית, והלקוח קיבל תשובה בכל זאת';
const BUSY_WAIT = 'הלקוח חיכה קצת יותר מהרגיל בגלל עומס';

/**
 * Per Error Center kind:
 *   problem   — what happened, when the customer got NO answer
 *   handled   — what happened, when the customer got an answer anyway
 *   ask       — who should act when there was no answer: 'customer' | 'shlomi'
 *   transient — passes by itself (so an answered turn reads "fixed automatically")
 *   icon      — the row's picture on the page
 */
const KINDS = {
  model_no_credit:    { problem: 'הסוכנת הפסיקה לענות ללקוחות', handled: SMALL_GLITCH, ask: 'shlomi', transient: false, icon: 'alert' },
  model_rate_limit:   { problem: 'הלקוח לא קיבל תשובה בגלל עומס', handled: BUSY_WAIT, ask: 'customer', transient: true, icon: 'busy' },
  model_timeout:      { problem: 'הלקוח חיכה ולא קיבל תשובה', handled: 'הלקוח חיכה לתשובה יותר מהרגיל', ask: 'customer', transient: true, icon: 'clock' },
  model_refusal:      { problem: 'הסוכנת לא הסכימה לענות ללקוח', handled: SMALL_GLITCH, ask: 'customer', transient: false, icon: 'alert' },
  model_bad_answer:   { problem: 'הלקוח קיבל תשובה ריקה או חלקית', handled: SMALL_GLITCH, ask: 'customer', transient: false, icon: 'alert' },
  model_other:        { problem: 'הסוכנת לא הצליחה לענות בגלל תקלה זמנית', handled: TEMP_GLITCH, ask: 'customer', transient: true, icon: 'busy' },
  database:           { problem: 'הלקוח לא קיבל תשובה בגלל תקלה במערכת', handled: SMALL_GLITCH, ask: 'shlomi', transient: false, icon: 'alert' },
  external:           { problem: 'הלקוח לא קיבל תשובה בגלל תקלה זמנית', handled: TEMP_GLITCH, ask: 'customer', transient: true, icon: 'busy' },
  server_unavailable: { problem: 'המערכת הייתה עמוסה וההודעה של הלקוח לא נקלטה', handled: BUSY_WAIT, ask: 'shlomi', transient: true, icon: 'busy' },
  user_input:         { problem: 'ההודעה של הלקוח לא נקלטה', handled: 'הלקוח קיבל תשובה, אבל חלק מההודעה שלו לא נקלט', ask: 'customer', transient: false, icon: 'message' },
  code:               { problem: 'הלקוח לא קיבל תשובה בגלל תקלה במערכת', handled: SMALL_GLITCH, ask: 'shlomi', transient: false, icon: 'alert' },
};

/** Any kind not in the table above — never an empty row. */
const FALLBACK = { problem: 'הלקוח לא קיבל תשובה בגלל תקלה', handled: SMALL_GLITCH, ask: 'shlomi', transient: false, icon: 'alert' };

/** Cases that are not a kind. */
const SPECIAL = {
  noReply:    { title: 'הלקוח שלח הודעה ולא קיבל תשובה', icon: 'message' },
  background: { title: SMALL_GLITCH, icon: 'sparkle' },
  trigger:    { title: 'הודעה שהיינו אמורים לשלוח ללקוח לא נשלחה', icon: 'bell' },
  slowReply:  { title: 'התשובה ללקוח לקחה יותר מדקה', icon: 'clock' },
};

/** "התשובה הגיעה אחרי 75 שניות" / "… אחרי 3 דקות" — the slow reply's outcome line. */
function slowOutcome(replyMs) {
  const sec = Math.round(Number(replyMs) / 1000);
  return sec < 120 ? `התשובה הגיעה אחרי ${sec} שניות` : `התשובה הגיעה אחרי ${Math.round(sec / 60)} דקות`;
}

// ─── The detail line (#1001): which part failed, and why ───────────
// "<part>: <reason>" — the part is the add-on's own name (the author knows
// it from the Builder), a trigger's name, or the area in words. The reason
// is plain Hebrew; a known error code says it most precisely, else the kind.

/** The runtime's add-on failure codes (builder/runtime/addonRunner.js). */
const REASONS_BY_CODE = {
  empty_output:      'חזרה תשובה ריקה',
  output_cut_off:    'התשובה נקטעה באמצע',
  bad_json:          'חזרה תשובה לא תקינה',
  no_verdict:        'חזרה תשובה לא תקינה',
  bad_output_type:   'חזרה תשובה לא תקינה',
  no_model:          'לא נבחר מודל',
  assemble_failed:   'לא הצלחנו להרכיב את ההנחיות',
  unknown_plugin:    'סוג החלק לא מוכר למערכת',
  plugin_run_failed: 'תקלה בהרצה',
};
const REASONS_BY_KIND = {
  model_no_credit:    'נגמרה המכסה אצל ספק ה־AI',
  model_rate_limit:   'עומס אצל ספק ה־AI',
  model_timeout:      'עבר הזמן ולא חזרה תשובה',
  model_refusal:      'ה־AI סירב לענות',
  model_bad_answer:   'חזרה תשובה ריקה או לא תקינה',
  model_other:        'תקלה זמנית אצל ספק ה־AI',
  database:           'תקלה בשמירת הנתונים',
  external:           'תקלה בשירות חיצוני',
  server_unavailable: 'השרת היה עמוס',
  user_input:         'לא הצלחנו לקרוא את ההודעה של הלקוח',
  code:               'תקלה בקוד של המערכת',
};
const REASON_FALLBACK = 'תקלה לא מוכרת';
/** The part, when the row names no add-on / trigger. */
const AREA_PARTS = {
  turn: 'הטיפול בהודעה',
  server: 'השרת',
  model: 'הפנייה לספק ה־AI',
  addon: 'אחד החלקים של הסוכן',
  trigger: 'הודעה מתוזמנת',
  offline: 'עיבוד ברקע',
  profiler: 'הפרופיילר',
  'live-brain': 'ה־Live Brain',
  simulation: 'סימולציה',
};
const PART_FALLBACK = 'המערכת';
// FSI … PDI: an English add-on name stays one piece inside the Hebrew line.
const isolate = t => `⁨${t}⁩`;
const partOf = r => {
  const name = r.addon_label || r.trigger_name;
  return name ? isolate(String(name).trim()) : (AREA_PARTS[r.area] || PART_FALLBACK);
};
const reasonOf = r => REASONS_BY_CODE[r.error_code] || REASONS_BY_KIND[r.kind] || REASON_FALLBACK;
const moreParts = n => (n === 1 ? ' (ועוד חלק אחד)' : ` (ועוד ${n} חלקים)`);

const named = r => !!(r.addon_label || r.trigger_name);

/**
 * The detail line of one customer turn's errors: the most specific row (one
 * that names its add-on / trigger, most customer-visible area first; else the
 * turn's lead row) — its part and reason — plus how many OTHER named parts
 * failed on that turn. (A retried model call and the turn around it are the
 * same failure, so unnamed rows never count as "more parts".)
 * @param {object} lead   the row that speaks for the turn (groupErrors)
 * @param {object[]} rows every row of the turn, in AREA_ORDER or any order
 * @returns {string} never empty
 */
function detailOf(lead, rows = [lead]) {
  const rank = r => { const i = AREA_ORDER.indexOf(r.area); return i < 0 ? 99 : i; };
  const speaker = [...rows].filter(named).sort((a, b) => rank(a) - rank(b))[0] || lead;
  const part = partOf(speaker);
  const others = new Set(rows.filter(named).map(partOf).filter(p => p !== part)).size;
  return `${part}: ${reasonOf(speaker)}${others ? moreParts(others) : ''}`;
}

const BACKGROUND_AREAS = new Set(['offline', 'profiler', 'live-brain']);
/** Which row of a turn speaks for it: the most customer-visible area first. */
const AREA_ORDER = ['turn', 'server', 'model', 'addon', 'trigger', 'offline', 'profiler', 'live-brain', 'simulation'];

/**
 * The plain words for one problem.
 * @param {object} p
 * @param {'error'|'no_reply'|'slow_reply'} p.type
 * @param {number} [p.replyMs]          slow reply: how long it took
 * @param {boolean} [p.repeats]         slow reply: the agent had SLOW_REPEAT_PER_DAY or more that day
 * @param {string} [p.kind] [p.area]   the row that speaks for the turn
 * @param {boolean} [p.answered]        did the customer get an answer
 * @param {boolean} [p.backgroundOnly]  every error was in a background lane
 * @returns {{ title: string, action: {text,tone}, outcome: string, icon: string }}
 */
function plainWords({ type, kind, area, answered, backgroundOnly, replyMs, repeats }) {
  if (type === 'slow_reply') {
    return { title: SPECIAL.slowReply.title, action: repeats ? ACTIONS.shlomi : ACTIONS.answered, outcome: slowOutcome(replyMs), icon: SPECIAL.slowReply.icon };
  }
  if (type === 'no_reply') {
    return { title: SPECIAL.noReply.title, action: ACTIONS.customer, outcome: OUTCOMES.noAnswer, icon: SPECIAL.noReply.icon };
  }
  if (area === 'trigger') {
    return { title: SPECIAL.trigger.title, action: ACTIONS.customer, outcome: OUTCOMES.triggerFailed, icon: SPECIAL.trigger.icon };
  }
  if (backgroundOnly && answered) {
    return { title: SPECIAL.background.title, action: ACTIONS.unnoticed, outcome: OUTCOMES.background, icon: SPECIAL.background.icon };
  }
  const k = KINDS[kind] || FALLBACK;
  if (answered) {
    return k.transient
      ? { title: k.handled, action: ACTIONS.auto, outcome: OUTCOMES.answeredLater, icon: k.icon }
      : { title: k.handled, action: ACTIONS.answered, outcome: OUTCOMES.answered, icon: k.icon };
  }
  return { title: k.problem, action: ACTIONS[k.ask] || ACTIONS.shlomi, outcome: OUTCOMES.noAnswer, icon: k.icon };
}

// ─── Reads ─────────────────────────────────────────────────────────

const iso = v => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const clip = s => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > LAST_MESSAGE_CHARS ? `${t.slice(0, LAST_MESSAGE_CHARS - 1)}…` : t;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day "YYYY-MM-DD" → its UTC midnight (ms), else NaN. */
function dayMs(d) {
  if (!DAY_RE.test(String(d || ''))) return NaN;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d ? ms : NaN;
}

/**
 * Check a custom period before any query: two real days, from ≤ to, at most
 * MAX_RANGE_DAYS. (Not after today is checked against the database's day.)
 * @throws {BadRangeError}
 */
function checkCustomDays(from, to) {
  const f = dayMs(from);
  const t = dayMs(to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) throw new BadRangeError('from and to must be days, YYYY-MM-DD');
  if (f > t) throw new BadRangeError('from is after to');
  if ((t - f) / 86400000 + 1 > MAX_RANGE_DAYS) throw new BadRangeError(`at most ${MAX_RANGE_DAYS} days`);
}

/**
 * Israel midnight today, six days before and tomorrow, the server's now,
 * today's Israel day — and, for a custom period, Israel midnight of `from`
 * and of the day after `to`.
 */
async function bounds(fromDay = null, toDay = null) {
  const { rows } = await db.query(
    `SELECT (date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}') AS today,
            ((date_trunc('day', now() AT TIME ZONE '${TZ}') - interval '6 days') AT TIME ZONE '${TZ}') AS week,
            ((date_trunc('day', now() AT TIME ZONE '${TZ}') + interval '1 day') AT TIME ZONE '${TZ}') AS tomorrow,
            to_char(now() AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS today_day,
            ($1::date::timestamp AT TIME ZONE '${TZ}') AS custom_from,
            (($2::date + 1)::timestamp AT TIME ZONE '${TZ}') AS custom_to,
            now() AS now`,
    [fromDay, toDay],
  );
  const r = rows[0];
  return {
    today: new Date(r.today), week: new Date(r.week), tomorrow: new Date(r.tomorrow), now: new Date(r.now),
    todayDay: r.today_day,
    customFrom: r.custom_from ? new Date(r.custom_from) : null,
    customTo: r.custom_to ? new Date(r.custom_to) : null,
  };
}

/** Builder agents' display names (active version), optionally one slug. */
async function agentNames(slug) {
  const { rows } = await db.query(
    `SELECT a.slug, COALESCE(NULLIF(v.body->>'name', ''), a.slug) AS name, a.archived_at
       FROM builder_agents a
       LEFT JOIN builder_agent_versions v ON v.id = a.active_version_id
      WHERE ($1::text IS NULL OR a.slug = $1)`,
    [slug || null],
  );
  return rows.map(r => ({ slug: r.slug, name: r.name, archived: !!r.archived_at }));
}

/** Does this agent exist in the Builder? */
async function agentExists(slug) {
  return (await agentNames(slug)).length > 0;
}

async function errorRows(from, to, slug, conversationId = null) {
  const { rows } = await db.query(
    `SELECT e.agent_slug, e.conversation_id, e.message_id, e.area, e.kind, e.created_at,
            e.detail->'addon'->>'label' AS addon_label,
            e.detail->'trigger'->>'name' AS trigger_name,
            e.detail->>'errorCode' AS error_code
       FROM error_events e
       LEFT JOIN error_groups g ON g.agent_slug = e.agent_slug AND g.fingerprint = e.fingerprint
      WHERE e.source = 'customer' AND e.created_at >= $1 AND e.created_at < $3
        AND ($2::text IS NULL OR e.agent_slug = $2)
        AND ($4::int IS NULL OR e.conversation_id = $4)
        AND g.status IS DISTINCT FROM 'ignored'
      ORDER BY e.created_at DESC
      LIMIT 2000`,
    [from, slug || null, to, conversationId],
  );
  return rows;
}

async function noReplyRows(from, to, slug, conversationId = null) {
  const { rows } = await db.query(
    `SELECT c.id AS conversation_id, a.url_slug AS agent_slug, lu.id AS user_msg_id, lu.content AS user_msg,
            c.last_user_message_at AS at
       FROM conversations c
       JOIN agents a ON a.id = c.agent_id
       CROSS JOIN LATERAL (
         SELECT m.id, m.content FROM messages m
          WHERE m.conversation_id = c.id AND m.role = 'user'
          ORDER BY m.id DESC LIMIT 1
       ) lu
      WHERE c.kind = 'user' AND c.metadata->>'kind' = 'live'
        AND c.last_user_message_at >= $1 AND c.last_user_message_at < $4
        AND c.last_user_message_at < now() - make_interval(mins => $3)
        AND ($2::text IS NULL OR a.url_slug = $2)
        AND ($5::int IS NULL OR c.id = $5)
        AND NOT EXISTS (
          SELECT 1 FROM messages r
           WHERE r.conversation_id = c.id AND r.role = 'assistant' AND r.id > lu.id AND r.content <> ''
        )
      ORDER BY c.last_user_message_at DESC
      LIMIT ${MAX_PROBLEMS}`,
    [from, slug || null, NO_REPLY_MINUTES, to, conversationId],
  );
  return rows;
}

/**
 * Customer conversations with a customer message in [from, to), per agent.
 * (`last_user_message_at >= from` only narrows the scan: a conversation
 * that had a customer message in the period was last written to after `from`.)
 */
async function servedCounts(from, to, slug) {
  const { rows } = await db.query(
    `SELECT a.url_slug AS slug, COUNT(*)::int AS n
       FROM conversations c JOIN agents a ON a.id = c.agent_id
      WHERE c.kind = 'user' AND c.metadata->>'kind' = 'live'
        AND c.last_user_message_at >= $1
        AND ($2::text IS NULL OR a.url_slug = $2)
        AND EXISTS (
          SELECT 1 FROM messages m
           WHERE m.conversation_id = c.id AND m.role = 'user' AND m.created_at >= $1 AND m.created_at < $3
        )
      GROUP BY 1`,
    [from, slug || null, to],
  );
  return new Map(rows.map(r => [r.slug, r.n]));
}

/**
 * Every customer conversation with a customer message in [from, to) — its
 * customer, real / test, and its last customer message in the period.
 * Newest first, light columns, up to CONVERSATIONS_READ — the counts are over
 * all of them; the list keeps MAX_CONVERSATIONS (buildConversations).
 */
async function conversationRows(from, to, slug) {
  const { rows } = await db.query(
    `SELECT c.id AS conversation_id, a.url_slug AS agent_slug, NULLIF(u.name, '') AS name,
            c.metadata->>'audience' AS audience, lm.created_at AS last_at, left(lm.content, ${LAST_MESSAGE_CHARS + 20}) AS last_msg
       FROM conversations c
       JOIN agents a ON a.id = c.agent_id
       LEFT JOIN users u ON u.id = c.user_id
       CROSS JOIN LATERAL (
         SELECT m.created_at, m.content FROM messages m
          WHERE m.conversation_id = c.id AND m.role = 'user' AND m.created_at >= $1 AND m.created_at < $3
          ORDER BY m.id DESC LIMIT 1
       ) lm
      WHERE c.kind = 'user' AND c.metadata->>'kind' = 'live'
        AND c.last_user_message_at >= $1
        AND ($2::text IS NULL OR a.url_slug = $2)
      ORDER BY lm.created_at DESC
      LIMIT ${CONVERSATIONS_READ}`,
    [from, slug || null, to],
  );
  return rows;
}

/** One customer turn's errors → one group. */
function groupErrors(rows) {
  const groups = new Map();
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    const key = r.message_id
      ? `m${r.message_id}`
      : `c${r.conversation_id || 0}-${r.area}-${Math.floor(t / 600000)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, agentSlug: r.agent_slug, conversationId: r.conversation_id, messageId: r.message_id, rows: [], first: t, last: t };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.first = Math.min(g.first, t);
    g.last = Math.max(g.last, t);
  }
  for (const g of groups.values()) {
    const rank = r => { const i = AREA_ORDER.indexOf(r.area); return i < 0 ? 99 : i; };
    g.lead = [...g.rows].sort((a, b) => rank(a) - rank(b))[0];
    g.backgroundOnly = g.rows.every(r => BACKGROUND_AREAS.has(r.area));
  }
  return [...groups.values()];
}

/** For each error group: did the customer get an answer, and their last message before it. */
async function turnFacts(groups) {
  const facts = new Map();
  if (!groups.length) return facts;
  const withConv = groups.filter(g => g.conversationId);
  if (!withConv.length) return facts;
  const { rows } = await db.query(
    `SELECT k.key,
            (SELECT m.content FROM messages m
              WHERE m.conversation_id = k.conv AND m.role = 'user'
                AND (k.before_id IS NULL OR m.id < k.before_id)
                AND (k.before_id IS NOT NULL OR m.created_at <= (k.before_ts AT TIME ZONE 'UTC'))
              ORDER BY m.id DESC LIMIT 1) AS last_user,
            CASE WHEN k.before_id IS NOT NULL
                 THEN EXISTS (SELECT 1 FROM messages r WHERE r.id = k.before_id AND r.content <> '')
                 ELSE EXISTS (SELECT 1 FROM messages r WHERE r.conversation_id = k.conv AND r.role = 'assistant'
                               AND r.content <> '' AND r.created_at > (k.before_ts AT TIME ZONE 'UTC'))
            END AS answered
       FROM unnest($1::text[], $2::int[], $3::int[], $4::timestamptz[]) AS k(key, conv, before_id, before_ts)`,
    [
      withConv.map(g => g.key),
      withConv.map(g => g.conversationId),
      withConv.map(g => g.messageId || null),
      withConv.map(g => new Date(g.first).toISOString()),
    ],
  );
  for (const r of rows) facts.set(r.key, { lastUser: r.last_user, answered: !!r.answered });
  return facts;
}

/**
 * Customer replies that took longer than SLOW_REPLY_MS (task #985, round 3) —
 * read from `messages.metadata.replyTiming` (builder/runtime/replyTiming.js),
 * so only replies since that was deployed. Customer chat only.
 */
async function slowReplyRows(from, to, slug, conversationId = null) {
  const { rows } = await db.query(
    `SELECT r.id AS reply_id, r.conversation_id, a.url_slug AS agent_slug,
            (r.metadata->'replyTiming'->>'replyMs')::numeric AS reply_ms,
            (r.metadata->'replyTiming'->>'receivedAt')::timestamptz AS at,
            to_char((r.metadata->'replyTiming'->>'receivedAt')::timestamptz AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day,
            (SELECT m.content FROM messages m
              WHERE m.conversation_id = r.conversation_id AND m.role = 'user' AND m.id < r.id
              ORDER BY m.id DESC LIMIT 1) AS user_msg
       FROM conversations c
       JOIN agents a ON a.id = c.agent_id
       JOIN messages r ON r.conversation_id = c.id
      WHERE c.kind = 'user' AND c.metadata->>'kind' = 'live'
        AND c.last_message_at >= $1
        AND ($2::text IS NULL OR a.url_slug = $2)
        AND r.role = 'assistant' AND r.metadata ? 'replyTiming'
        AND (r.metadata->'replyTiming'->>'replyMs')::numeric > $3
        AND (r.metadata->'replyTiming'->>'receivedAt')::timestamptz >= $1
        AND (r.metadata->'replyTiming'->>'receivedAt')::timestamptz < $4
        AND ($5::int IS NULL OR c.id = $5)
      ORDER BY r.id DESC
      LIMIT ${MAX_PROBLEMS}`,
    [from, slug || null, SLOW_REPLY_MS, to, conversationId],
  );
  return rows;
}

/** Per conversation: the customer's name and real / test (#968 — fail closed: no mark = test). */
async function customerInfo(conversationIds) {
  const ids = [...new Set(conversationIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT c.id, NULLIF(u.name, '') AS name, c.metadata->>'audience' AS audience
       FROM conversations c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map(r => [r.id, { name: r.name, audience: audienceOf({ audience: r.audience }) }]));
}

/**
 * The period of a read: today, this week, or a custom from–to (#1001).
 * @returns {{ r: 'today'|'week'|'custom', b: object, from: Date, to: Date, fromDay: string|null, toDay: string|null }}
 * @throws {BadRangeError}
 */
async function periodOf({ range = 'today', from: fromDay = null, to: toDay = null } = {}) {
  const custom = !!(fromDay || toDay);
  if (custom) checkCustomDays(fromDay, toDay);
  const r = custom ? 'custom' : (range === 'week' ? 'week' : 'today');
  const b = await bounds(custom ? fromDay : null, custom ? toDay : null);
  if (custom && toDay > b.todayDay) throw new BadRangeError('to is after today');
  return {
    r, b,
    from: r === 'custom' ? b.customFrom : r === 'today' ? b.today : b.week,
    to: r === 'custom' ? b.customTo : b.tomorrow,
    fromDay: custom ? fromDay : null,
    toDay: custom ? toDay : null,
  };
}

/** The period's own fields, the same on every read. */
const periodFields = p => ({
  range: p.r,
  from: p.from.toISOString(),
  to: p.to.toISOString(),
  fromDay: p.fromDay,
  toDay: p.toDay,
  maxRangeDays: MAX_RANGE_DAYS,
  checkedAt: p.b.now.toISOString(),
});

/**
 * Every problem of the scope that a period's read needs: `all` (also the
 * last 24 h, for "new") and `inRange` (the period, newest first, capped).
 * `conversationId` narrows every read to one conversation (its window).
 * Each problem carries `messageId` — the message it happened on: the
 * turn's reply (errors, slow replies; may be an empty, unsent reply) or the
 * unanswered customer message (no reply); null when unknown.
 */
async function readProblems(slug, p, conversationId = null) {
  const dayAgo = p.b.now.getTime() - 24 * 3600 * 1000;
  // One read covers both the period and "new" (24 h).
  const fetchFrom = new Date(Math.min(p.from.getTime(), dayAgo));
  const [errs, silent, slow, names] = await Promise.all([
    errorRows(fetchFrom, p.to, slug, conversationId),
    noReplyRows(fetchFrom, p.to, slug, conversationId),
    slowReplyRows(fetchFrom, p.to, slug, conversationId),
    agentNames(slug),
  ]);

  const groups = groupErrors(errs);
  const [facts, customers] = await Promise.all([
    turnFacts(groups),
    customerInfo([...groups.map(g => g.conversationId), ...silent.map(s => s.conversation_id), ...slow.map(s => s.conversation_id)]),
  ]);
  const who = id => (id && customers.get(id)) || { name: null, audience: null };
  const nameOf = new Map(names.map(n => [n.slug, n.name]));

  const all = [];
  for (const g of groups) {
    const f = facts.get(g.key) || { lastUser: null, answered: false };
    const words = plainWords({ type: 'error', kind: g.lead.kind, area: g.lead.area, answered: f.answered, backgroundOnly: g.backgroundOnly });
    all.push({
      id: g.key, type: 'error',
      at: new Date(g.first).toISOString(),
      messageId: g.messageId || null,
      agentSlug: g.agentSlug, agentName: nameOf.get(g.agentSlug) || g.agentSlug,
      conversationId: g.conversationId || null,
      customerName: who(g.conversationId).name,
      audience: who(g.conversationId).audience,
      lastCustomerMessage: f.lastUser ? clip(f.lastUser) : null,
      answered: f.answered,
      replyMs: null,
      ...words,
      detail: detailOf(g.lead, g.rows),
    });
  }
  for (const s of silent) {
    const at = new Date(s.at).getTime();
    const covered = groups.some(g => g.conversationId === s.conversation_id
      && ((g.messageId && g.messageId > s.user_msg_id) || (!g.messageId && g.last >= at - 10000)));
    if (covered) continue;
    all.push({
      id: `n${s.conversation_id}-${s.user_msg_id}`, type: 'no_reply',
      at: iso(s.at),
      messageId: s.user_msg_id,
      agentSlug: s.agent_slug, agentName: nameOf.get(s.agent_slug) || s.agent_slug,
      conversationId: s.conversation_id,
      customerName: who(s.conversation_id).name,
      audience: who(s.conversation_id).audience,
      lastCustomerMessage: clip(s.user_msg),
      answered: false,
      replyMs: null,
      ...plainWords({ type: 'no_reply' }),
      detail: null,
    });
  }
  // Slow replies — the customer got an answer, late. A turn that also has an
  // Error Center row is told by that row. "Repeats" = SLOW_REPEAT_PER_DAY or
  // more slow replies of the same agent on the same day.
  const slowPerDay = new Map();
  for (const s of slow) slowPerDay.set(`${s.agent_slug}|${s.day}`, (slowPerDay.get(`${s.agent_slug}|${s.day}`) || 0) + 1);
  for (const s of slow) {
    if (groups.some(g => g.messageId && g.messageId === s.reply_id)) continue;
    const replyMs = Math.round(Number(s.reply_ms));
    all.push({
      id: `s${s.reply_id}`, type: 'slow_reply',
      at: iso(s.at),
      messageId: s.reply_id,
      agentSlug: s.agent_slug, agentName: nameOf.get(s.agent_slug) || s.agent_slug,
      conversationId: s.conversation_id,
      customerName: who(s.conversation_id).name,
      audience: who(s.conversation_id).audience,
      lastCustomerMessage: s.user_msg ? clip(s.user_msg) : null,
      answered: true,
      replyMs,
      ...plainWords({ type: 'slow_reply', replyMs, repeats: (slowPerDay.get(`${s.agent_slug}|${s.day}`) || 0) >= SLOW_REPEAT_PER_DAY }),
      detail: null,
    });
  }
  all.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  for (const x of all) x.isNew = new Date(x.at).getTime() >= dayAgo;

  const inRange = all
    .filter(x => { const t = new Date(x.at).getTime(); return t >= p.from.getTime() && t < p.to.getTime(); })
    .slice(0, MAX_PROBLEMS);
  return { all, inRange, names, nameOf };
}

/** The row a problem belongs to on the conversations page: its conversation, or itself. */
const rowKey = x => (x.conversationId ? `c${x.conversationId}` : `p${x.id}`);

/**
 * The tile numbers (#1001) — conversations, not problem rows, so each tile's
 * number = the rows it opens on the conversations page.
 * @param {object[]} rows  [{ audience, problems: [...] }] — every row WITH a problem
 * @param {number} all     every row of the period (with a problem or not)
 */
function tally(rows, all) {
  const act = rows.filter(x => x.problems.some(y => y.action.tone === 'act')).length;
  return {
    all,
    act,
    ok: all - act,
    problems: rows.length,
    slow: rows.filter(x => x.problems.some(y => y.type === 'slow_reply')).length,
    test: rows.filter(x => x.audience === 'test').length,
  };
}

/** Of these conversations, the ones with a customer message in [from, to). */
async function servedAmong(ids, from, to) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Set();
  const { rows } = await db.query(
    `SELECT DISTINCT m.conversation_id AS id FROM messages m
      WHERE m.conversation_id = ANY($1::int[]) AND m.role = 'user' AND m.created_at >= $2 AND m.created_at < $3`,
    [list, from, to],
  );
  return new Set(rows.map(r => r.id));
}

/**
 * Every problem of ONE customer conversation, from its start until now —
 * the conversation window's markers (#1001 follow-up,
 * builder/services/manageConversation.js). Oldest first; each with `messageId`.
 * @param {{ slug: string, conversationId: number, since: Date|string }} a
 */
async function problemsOfConversation({ slug, conversationId, since }) {
  const b = await bounds();
  const from = since ? new Date(since) : b.week;
  const { inRange } = await readProblems(slug, { b, from, to: b.tomorrow }, conversationId);
  return inRange.filter(x => x.conversationId === conversationId).reverse();
}

/**
 * The problems page / MCP read.
 *
 * @param {object} a
 * @param {string|null} a.slug       one agent, or null for every agent
 * @param {'today'|'week'} [a.range] default 'today' (Israel time; week = today + 6 days before)
 * @param {string} [a.from] [a.to]   a custom period instead (#1001): Israel days
 *   "YYYY-MM-DD", inclusive, at most MAX_RANGE_DAYS, `to` not after today.
 *   Both or neither; a bad one throws BadRangeError (code 'bad_range').
 * @returns {Promise<{ range, from, to, fromDay, toDay, maxRangeDays, checkedAt, newCount,
 *   noReplyMinutes, slowReplySeconds, problems, conversationCounts, agents }>}
 *   problems newest first; `isNew` = in the last 24 h (no read-tracking; on a
 *   custom period only those inside it).
 *   conversationCounts: the tiles, in conversations — the same numbers
 *   listConversations gives.
 *   agents: [{ slug, name, archived, conversations, problems, needsAction }] — every
 *   Builder agent in scope with its customer conversations and problems in the range.
 */
async function listProblems({ slug = null, range = 'today', from = null, to = null } = {}) {
  const p = await periodOf({ range, from, to });
  const [{ all, inRange, names }, served] = await Promise.all([
    readProblems(slug, p),
    servedCounts(p.from, p.to, slug),
  ]);

  const problemsBySlug = new Map();
  const actBySlug = new Map();
  for (const x of inRange) {
    problemsBySlug.set(x.agentSlug, (problemsBySlug.get(x.agentSlug) || 0) + 1);
    if (x.action.tone === 'act') actBySlug.set(x.agentSlug, (actBySlug.get(x.agentSlug) || 0) + 1);
  }

  // Every Builder agent in scope, plus any slug that only shows up in the data.
  const agentSlugs = new Set([...names.map(n => n.slug), ...served.keys(), ...problemsBySlug.keys()]);
  const agents = [...agentSlugs].map(s => {
    const n = names.find(x => x.slug === s);
    return {
      slug: s,
      name: n ? n.name : s,
      archived: n ? n.archived : false,
      conversations: served.get(s) || 0,
      problems: problemsBySlug.get(s) || 0,
      // Rows whose chip says someone should act (contact the customer / call Shlomi).
      needsAction: actBySlug.get(s) || 0,
    };
  }).sort((x, y) => (y.conversations - x.conversations) || (y.problems - x.problems) || x.name.localeCompare(y.name));

  // The tiles in conversations: every customer conversation of the period,
  // plus each problem's row that had no customer message in it.
  const rows = new Map();
  for (const x of inRange) {
    const k = rowKey(x);
    if (!rows.has(k)) rows.set(k, { conversationId: x.conversationId, audience: x.audience, problems: [] });
    rows.get(k).problems.push(x);
  }
  const servedIds = await servedAmong([...rows.values()].map(x => x.conversationId), p.from, p.to);
  const extra = [...rows.values()].filter(x => !x.conversationId || !servedIds.has(x.conversationId)).length;
  const servedTotal = [...served.values()].reduce((n, v) => n + v, 0);

  return {
    ...periodFields(p),
    newCount: all.filter(x => x.isNew).length,
    noReplyMinutes: NO_REPLY_MINUTES,
    slowReplySeconds: SLOW_REPLY_MS / 1000,
    problems: inRange,
    conversationCounts: tally([...rows.values()], servedTotal + extra),
    agents,
  };
}

/**
 * The conversations page / MCP read (#1001): every conversation of the
 * period, newest first — the customer conversations with a customer message
 * in it, plus any conversation (or conversation-less problem) that only has
 * a problem in it. Each: status 'act' | 'info' | 'ok' and `problemIds` (the
 * one that speaks for it first). At most MAX_CONVERSATIONS rows, the ones
 * with a problem always included.
 *
 * @param {object} a  slug / range / from / to — as listProblems
 * @returns {Promise<{ range, from, to, fromDay, toDay, maxRangeDays, checkedAt,
 *   conversations, conversationCounts, truncated, problems }>}
 *   problems: the problems the rows point at (the same objects listProblems gives).
 */
async function listConversations({ slug = null, range = 'today', from = null, to = null } = {}) {
  const p = await periodOf({ range, from, to });
  const [{ inRange, nameOf }, convs] = await Promise.all([
    readProblems(slug, p),
    conversationRows(p.from, p.to, slug),
  ]);
  const { conversations, counts, truncated } = buildConversations(convs, inRange, nameOf);
  return {
    ...periodFields(p),
    conversations,
    conversationCounts: counts,
    truncated,
    problems: inRange,
  };
}

/** Which problem speaks for a conversation: someone should act, then error > no reply > slow, then newest. */
const TYPE_ORDER = { error: 0, no_reply: 1, slow_reply: 2 };
function problemRank(x, y) {
  return ((x.action.tone === 'act' ? 0 : 1) - (y.action.tone === 'act' ? 0 : 1))
    || ((TYPE_ORDER[x.type] ?? 9) - (TYPE_ORDER[y.type] ?? 9))
    || (x.at < y.at ? 1 : x.at > y.at ? -1 : 0);
}

/**
 * The rows of listConversations — see there. `counts` are over ALL rows
 * (tally), the list keeps MAX_CONVERSATIONS.
 */
function buildConversations(convRows, problems, nameOf) {
  const byKey = new Map();
  for (const c of convRows) {
    byKey.set(`c${c.conversation_id}`, {
      id: `c${c.conversation_id}`,
      conversationId: c.conversation_id,
      agentSlug: c.agent_slug,
      agentName: nameOf.get(c.agent_slug) || c.agent_slug,
      customerName: c.name || null,
      audience: audienceOf({ audience: c.audience }),
      at: iso(c.last_at),
      lastCustomerMessage: c.last_msg ? clip(c.last_msg) : null,
      status: 'ok',
      problemIds: [],
      problems: [],
    });
  }
  for (const x of problems) {
    const key = rowKey(x);
    let e = byKey.get(key);
    if (!e) {
      e = {
        id: key,
        conversationId: x.conversationId,
        agentSlug: x.agentSlug,
        agentName: x.agentName,
        customerName: x.customerName,
        audience: x.audience,
        at: x.at,
        lastCustomerMessage: x.lastCustomerMessage,
        status: 'ok',
        problemIds: [],
        problems: [],
      };
      byKey.set(key, e);
    }
    e.problems.push(x);
    if (x.at > e.at) e.at = x.at;
  }
  const every = [...byKey.values()];
  for (const e of every) {
    e.problems.sort(problemRank);
    e.problemIds = e.problems.map(x => x.id);
    e.status = !e.problems.length ? 'ok' : e.problems.some(x => x.action.tone === 'act') ? 'act' : 'info';
  }
  const withProblem = every.filter(e => e.problems.length);
  const counts = tally(withProblem, every.length);
  const newest = (x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0);
  const clean = every.filter(e => !e.problems.length).sort(newest);
  const kept = [...withProblem, ...clean.slice(0, Math.max(MAX_CONVERSATIONS - withProblem.length, 0))]
    .sort(newest)
    .map(({ problems: _p, ...row }) => row);
  return { conversations: kept, counts, truncated: kept.length < every.length };
}

module.exports = {
  listProblems, listConversations, problemsOfConversation, agentExists, plainWords, detailOf, BadRangeError,
  ACTIONS, OUTCOMES, KINDS, FALLBACK, SPECIAL, RANGES, NO_REPLY_MINUTES, SLOW_REPLY_MS, SLOW_REPEAT_PER_DAY,
  MAX_RANGE_DAYS, MAX_CONVERSATIONS, REASONS_BY_CODE, REASONS_BY_KIND,
  _internal: { groupErrors, buildConversations },
};
