/**
 * Error center (task #903) — one way to record an error on the
 * conversation path, and the reads behind Admin → Errors.
 *
 *   record(err, ctx)    keep one error; never throws, never waits the caller
 *   classify(err)       what kind of error it is (model rate limit, database…)
 *   listGroups(…)       the agent's errors grouped by fingerprint
 *   listOccurrences(…)  every time one group happened
 *
 * ── The one rule ───────────────────────────────────────────────────
 *
 * Recording an error must never change or break a conversation. `record`
 * returns at once (the write happens after), swallows every failure of its
 * own, and the caller carries on exactly as it did before the hook existed.
 * Call it as `errorCenter.record(err, {...})` — no `await` needed.
 *
 * ── What is kept ───────────────────────────────────────────────────
 *
 * Where (area + the hook's code), which agent / conversation / message,
 * where the conversation came from (Builder · Customer · Simulation), the
 * kind, a scrubbed message, a few technical facts (error code, HTTP status,
 * a short stack) and a fingerprint. No keys, no prompts — the message and
 * add-on run the error links to hold the full story.
 *
 * ── Grouping ───────────────────────────────────────────────────────
 *
 * The fingerprint is area + kind + code + the message with its numbers and
 * ids blanked, so "conversation 1812 not found" and "conversation 1907 not
 * found" are one line. Groups are computed at read time — one table.
 *
 * ── Kept for a month ───────────────────────────────────────────────
 *
 * Older rows are deleted by the service itself, at most once an hour per
 * process, piggy-backed on recording and reading. No scheduler needed.
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const db = require('../../services/db.pg');

const KEEP_DAYS = 30;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const MAX_MESSAGE = 2000;
const STACK_LINES = 8;

const AREAS = ['turn', 'addon', 'model', 'offline', 'trigger', 'profiler', 'live-brain', 'simulation', 'server'];
// server_unavailable: our own server / its front door could not take the request
// (Cloud Run 429/5xx under load) — set by the caller that knows, never guessed.
const KINDS = ['model_rate_limit', 'model_timeout', 'model_refusal', 'model_bad_answer', 'model_other', 'database', 'external', 'server_unavailable', 'user_input', 'code'];
const SOURCES = ['builder', 'customer', 'simulation'];

// ─── Context and "already recorded" ────────────────────────────────
//
// A turn / add-on / background job runs inside withContext({...}) so that
// anything recording deeper down (a model call inside an add-on) knows the
// agent, conversation and add-on without being told. And an error is marked
// once recorded, so the layers above it (add-on → turn) don't count it twice.

const als = new AsyncLocalStorage();
const RECORDED = Symbol('errorCenterRecorded');

/** Run `fn` with these facts added to the current error context. */
function withContext(facts, fn) {
  const parent = als.getStore() || {};
  return als.run({ ...parent, ...facts, detail: { ...(parent.detail || {}), ...((facts && facts.detail) || {}) } }, fn);
}

function currentContext() {
  return als.getStore() || {};
}

function markRecorded(err) {
  if (err && typeof err === 'object') {
    try { Object.defineProperty(err, RECORDED, { value: true }); } catch { /* frozen */ }
  }
}

function wasRecorded(err) {
  return !!(err && typeof err === 'object' && err[RECORDED]);
}

// ─── What kind of error ────────────────────────────────────────────

/**
 * Best guess from the error itself. A hook that knows better passes
 * `ctx.kind` and this is skipped.
 */
function classify(err) {
  const e = err || {};
  const msg = String(e.message || e || '');
  const status = Number(e.status || e.statusCode || (e.response && e.response.status)) || 0;
  const code = String(e.code || (e.cause && e.cause.code) || '');

  // Postgres SQLSTATE codes are five characters (e.g. 23505, 42P01, 57014
  // statement timeout) — checked first so a slow query is not a "model timeout".
  if (/^[0-9A-Z]{5}$/.test(code) || /relation .* does not exist|duplicate key|violates .* constraint|database|connection terminated|too many clients/i.test(msg)) return 'database';
  if (status === 429 || /rate.?limit|too many requests|quota/i.test(msg)) return 'model_rate_limit';
  if (/ETIMEDOUT|ESOCKETTIMEDOUT/.test(code) || e.name === 'AbortError' || /timed? ?out|timeout/i.test(msg)) return 'model_timeout';
  if (/refus|content.?(policy|filter)|safety/i.test(msg)) return 'model_refusal';
  if (/overloaded|model.*(not found|does not exist)|(openai|anthropic|gemini|google).*error/i.test(msg) || status >= 500) return 'model_other';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/.test(code) || /fetch failed|socket hang up/i.test(msg)) return 'external';
  return 'code';
}

// ─── Scrubbing and fingerprint ─────────────────────────────────────

function scrub(text) {
  return String(text || '')
    .replace(/sk-(?:ant-)?[A-Za-z0-9_-]{10,}/g, 'sk-…')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer …')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1…@')
    .replace(/(password|passwd|secret|api[_-]?key|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2…');
}

/** The message with the parts that differ between repeats blanked out. */
function normalise(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[a-z]+_[a-z0-9]{6,}\b/g, '<id>')   // crew_x8k2…, run_…, ver_…
    .replace(/\b[0-9a-f]{16,}\b/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** `group` splits otherwise-equal errors (e.g. the same failure in two different add-ons). */
function fingerprintOf({ area, kind, code, message, group }) {
  return crypto.createHash('sha1')
    .update([area, kind, code || '', normalise(message), ...(group ? [group] : [])].join('|'))
    .digest('hex');
}

// ─── Record ────────────────────────────────────────────────────────

/** builder-preview → builder, live → customer, simulation → simulation. */
async function sourceOfConversation(conversationId) {
  if (!conversationId) return null;
  const { rows } = await db.query(
    "SELECT metadata->>'kind' AS kind FROM conversations WHERE id = $1 LIMIT 1",
    [Number(conversationId)],
  );
  const k = rows[0] && rows[0].kind;
  return k === 'live' ? 'customer' : k === 'builder-preview' ? 'builder' : k === 'simulation' ? 'simulation' : null;
}

let lastPrune = 0;
function pruneSoon() {
  if (Date.now() - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = Date.now();
  db.query(`DELETE FROM error_events WHERE created_at < now() - interval '${KEEP_DAYS} days'`)
    .catch(e => console.warn('[error-center] prune failed:', e.message));
}

async function write(err, ctxIn) {
  const ctx = ctxIn;
  const area = AREAS.includes(ctx.area) ? ctx.area : 'server';
  const kind = KINDS.includes(ctx.kind) ? ctx.kind : classify(err);
  const code = ctx.code ? String(ctx.code).slice(0, 60) : null;
  const message = scrub((err && err.message) || err || 'Unknown error').slice(0, MAX_MESSAGE) || 'Unknown error';
  const source = SOURCES.includes(ctx.source) ? ctx.source : await sourceOfConversation(ctx.conversationId).catch(() => null);

  const detail = {};
  if (err && err.code) detail.errorCode = String(err.code);
  const status = err && (err.status || err.statusCode);
  if (status) detail.httpStatus = Number(status) || String(status);
  if (err && err.name && err.name !== 'Error') detail.name = String(err.name);
  if (err && err.stack) detail.stack = scrub(String(err.stack).split('\n').slice(0, STACK_LINES).join('\n'));
  if (ctx.detail && typeof ctx.detail === 'object') Object.assign(detail, ctx.detail);

  await db.query(
    `INSERT INTO error_events
       (agent_slug, conversation_id, message_id, addon_run_id, source, area, kind, code, message, detail, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      ctx.agentSlug ? String(ctx.agentSlug).slice(0, 100) : null,
      Number.isInteger(Number(ctx.conversationId)) && ctx.conversationId ? Number(ctx.conversationId) : null,
      Number.isInteger(Number(ctx.messageId)) && ctx.messageId ? Number(ctx.messageId) : null,
      ctx.addonRunId ? String(ctx.addonRunId).slice(0, 64) : null,
      source,
      area,
      kind,
      code,
      message,
      JSON.stringify(detail),
      fingerprintOf({ area, kind, code, message, group: ctx.group }),
    ],
  );
  pruneSoon();
  return { area, kind, code, message, source, fingerprint: fingerprintOf({ area, kind, code, message, group: ctx.group }), agentSlug: ctx.agentSlug || null, conversationId: ctx.conversationId || null };
}

/**
 * Keep one error. Returns at once; the write happens after and can never
 * throw into the caller.
 *
 * @param {Error|string} err
 * @param {object} ctx
 * @param {string} ctx.area            turn | addon | model | offline | trigger | profiler | live-brain | simulation | server
 * @param {string} [ctx.code]          the hook's own name for it, e.g. 'runtime_failed'
 * @param {string} [ctx.agentSlug]
 * @param {number} [ctx.conversationId]
 * @param {number} [ctx.messageId]     the assistant message of the turn
 * @param {string} [ctx.addonRunId]
 * @param {string} [ctx.source]        builder | customer | simulation — read from the conversation when left out
 * @param {string} [ctx.kind]          overrides classify()
 * @param {object} [ctx.detail]        extra technical facts (no prompts, no secrets)
 */
function record(err, ctx = {}) {
  try {
    markRecorded(err);
    // The surrounding context fills what the caller did not say.
    const store = currentContext();
    const merged = { ...store, ...(ctx || {}), detail: { ...(store.detail || {}), ...((ctx && ctx.detail) || {}) } };
    setImmediate(() => {
      write(err, merged)
        .then(written => { if (written) afterWrite(written); })
        .catch(e => {
          // Never recurse into ourselves; the original error is already in the log.
          console.warn('[error-center] could not record an error:', e.message);
        });
    });
  } catch (e) {
    console.warn('[error-center] could not record an error:', e.message);
  }
}

/**
 * For a catch that logs and carries on ("best-effort"): keep the error
 * unless a deeper hook already did. Same guarantees as record().
 */
function swallowed(err, area, code, extra = {}) {
  if (!wasRecorded(err)) record(err, { area, code, ...extra });
}

/**
 * Same as record(), but resolves once the row is written (or after
 * `timeoutMs`) — for the crash catch-all, which must write before the
 * process exits. Never rejects.
 */
function recordNow(err, ctx = {}, timeoutMs = 2000) {
  markRecorded(err);
  const store = currentContext();
  const merged = { ...store, ...(ctx || {}), detail: { ...(store.detail || {}), ...((ctx && ctx.detail) || {}) } };
  return Promise.race([
    write(err, merged).catch(e => console.warn('[error-center] could not record an error:', e.message)),
    new Promise(r => setTimeout(r, timeoutMs).unref()),
  ]);
}

/** Hooks that run after a write (alerts) — registered by other modules, never throw into record(). */
const afterWriteHooks = [];
function onWrite(fn) { afterWriteHooks.push(fn); }
function afterWrite(written) {
  for (const fn of afterWriteHooks) {
    Promise.resolve().then(() => fn(written)).catch(e => console.warn('[error-center] after-write hook failed:', e.message));
  }
}

// ─── The catch-all (#8) ────────────────────────────────────────────
//
// Records what nothing else caught, then behaves exactly as before:
//  - a route error still goes on to Express's default handler (next(err));
//  - an unhandled rejection / uncaught exception still ends the process
//    with exit code 1, as Node's default does — after the record is
//    written (2 s at most).

/** /api/agents/<slug>/conversations/<id>/… → { agentSlug, conversationId } */
function errorFactsFromUrl(url) {
  const m = String(url || '').match(/^\/api\/agents\/([^/?]+)(?:\/conversations\/(\d+))?/);
  if (!m) return {};
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
  return { agentSlug: slug, ...(m[2] ? { conversationId: Number(m[2]) } : {}) };
}

/** Express error middleware — mount after the routes. */
function expressCatchAll() {
  return (err, req, res, next) => {
    if (!wasRecorded(err)) {
      record(err, {
        area: 'server',
        code: 'route_error',
        ...errorFactsFromUrl(req.originalUrl),
        detail: { route: `${req.method} ${String(req.originalUrl || '').split('?')[0].slice(0, 200)}` },
      });
    }
    next(err);
  };
}

let crashing = false;
function recordCrashThenExit(err, code) {
  if (crashing) return;
  crashing = true;
  console.error(`❌ ${code}:`, err);
  const e = err instanceof Error ? err : new Error(String(err));
  recordNow(e, { area: 'server', code }).finally(() => process.exit(1));
}

/** Process-level catch-all. Same outcome as Node's default (exit 1), recorded first. */
function installCrashHandlers() {
  process.on('unhandledRejection', reason => recordCrashThenExit(reason, 'unhandled_rejection'));
  process.on('uncaughtException', err => recordCrashThenExit(err, 'uncaught_exception'));
}

// ─── Read ──────────────────────────────────────────────────────────

/** Shared WHERE for the agent's errors in the kept window, plus filters. */
function filterSql({ slug, kind, area, source }, params) {
  params.push(slug);
  const where = [`agent_slug = $${params.length}`, `created_at > now() - interval '${KEEP_DAYS} days'`];
  if (kind && KINDS.includes(kind)) { params.push(kind); where.push(`kind = $${params.length}`); }
  if (area && AREAS.includes(area)) { params.push(area); where.push(`area = $${params.length}`); }
  if (source && SOURCES.includes(source)) { params.push(source); where.push(`source = $${params.length}`); }
  return where.join(' AND ');
}

const STATUSES = ['new', 'looking', 'handled', 'ignored'];

/**
 * The effective status of a group, in SQL: no decision yet = new; a group
 * marked handled whose errors came back after that = new again (reopened).
 * `g` is the aggregated group, `s` its error_groups row.
 */
const EFFECTIVE_STATUS = `CASE WHEN s.status IS NULL THEN 'new'
       WHEN s.status = 'handled' AND g.last_seen > s.status_at THEN 'new'
       ELSE s.status END`;

/**
 * The agent's error groups: what, where, how many times, first and last
 * seen, how the occurrences split across Builder / Customer / Simulation,
 * and what was decided about it (status + note).
 *
 * @param {object} a
 * @param {string} a.slug
 * @param {string} [a.kind] [a.area] [a.source] [a.status]   filters
 * @param {'recent'|'frequent'} [a.sort]
 */
async function listGroups({ slug, kind, area, source, status, sort, limit }) {
  pruneSoon();
  const params = [];
  const where = filterSql({ slug, kind, area, source }, params);
  params.push(slug);
  const slugParam = params.length;
  let statusWhere = '';
  if (status && STATUSES.includes(status)) { params.push(status); statusWhere = `WHERE ${EFFECTIVE_STATUS} = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  const order = sort === 'frequent' ? 'g.count DESC, g.last_seen DESC' : 'g.last_seen DESC';
  const { rows } = await db.query(
    `WITH g AS (
       SELECT fingerprint,
              MIN(area) AS area,
              MIN(kind) AS kind,
              MIN(code) AS code,
              (ARRAY_AGG(message ORDER BY created_at DESC))[1] AS message,
              (ARRAY_AGG(detail ORDER BY created_at DESC))[1] AS last_detail,
              COUNT(*)::int AS count,
              COUNT(DISTINCT conversation_id)::int AS conversations,
              COUNT(*) FILTER (WHERE source = 'builder')::int AS builder,
              COUNT(*) FILTER (WHERE source = 'customer')::int AS customer,
              COUNT(*) FILTER (WHERE source = 'simulation')::int AS simulation,
              MIN(created_at) AS first_seen,
              MAX(created_at) AS last_seen
         FROM error_events
        WHERE ${where}
        GROUP BY fingerprint
     )
     SELECT g.*, ${EFFECTIVE_STATUS} AS status,
            (s.status = 'handled' AND g.last_seen > s.status_at) AS reopened,
            s.note, s.status_by, s.status_at
       FROM g
       LEFT JOIN error_groups s ON s.agent_slug = $${slugParam} AND s.fingerprint = g.fingerprint
       ${statusWhere}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(r => ({
    fingerprint: r.fingerprint,
    area: r.area,
    kind: r.kind,
    code: r.code,
    message: r.message,
    count: r.count,
    conversations: r.conversations,
    sources: { builder: r.builder, customer: r.customer, simulation: r.simulation },
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    where: whereOf(r.area, r.last_detail),
    status: r.status,
    reopened: !!r.reopened,
    note: r.note || '',
    statusBy: r.status_by || null,
    statusAt: r.status_at || null,
  }));
}

/** The add-on / model / trigger a group is about, in words — "Profile extractor", "gemini-2.5-flash". */
function whereOf(area, detail) {
  const d = detail || {};
  if (d.addon && d.addon.label) return String(d.addon.label);
  if (d.model) return String(d.model);
  if (d.trigger && (d.trigger.name || d.trigger.id)) return String(d.trigger.name || d.trigger.id);
  if (d.route) return String(d.route);
  return null;
}

/** Day buckets (UTC dates, oldest first) for the last `days` days, filled from rows of { day, n }. */
function dayBuckets(rows, days) {
  const byDay = new Map(rows.map(r => [new Date(r.day).toISOString().slice(0, 10), Number(r.n)]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10);
    out.push({ day: d, count: byDay.get(d) || 0 });
  }
  return out;
}

/**
 * The strip at the top of Admin → Errors: how many groups per status
 * (effective — a handled group that came back counts as "back"), how many
 * customer conversations an error hit in the last 24 h, and errors per day
 * over the last 14 days.
 */
async function summary({ slug }) {
  const params = [];
  const where = filterSql({ slug }, params);
  params.push(slug);
  const { rows: st } = await db.query(
    `WITH g AS (
       SELECT fingerprint, MAX(created_at) AS last_seen FROM error_events WHERE ${where} GROUP BY fingerprint
     )
     SELECT CASE WHEN s.status = 'handled' AND g.last_seen > s.status_at THEN 'back'
                 ELSE COALESCE(s.status, 'new') END AS status, COUNT(*)::int AS n
       FROM g LEFT JOIN error_groups s ON s.agent_slug = $${params.length} AND s.fingerprint = g.fingerprint
      GROUP BY 1`,
    params,
  );
  const byStatus = { new: 0, back: 0, looking: 0, handled: 0, ignored: 0 };
  for (const r of st) byStatus[r.status] = r.n;
  const { rows: c } = await db.query(
    `SELECT COUNT(DISTINCT conversation_id)::int AS n FROM error_events
      WHERE agent_slug = $1 AND source = 'customer' AND created_at > now() - interval '24 hours'`,
    [slug],
  );
  const { rows: days } = await db.query(
    `SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day, COUNT(*)::int AS n FROM error_events
      WHERE agent_slug = $1 AND created_at > now() - interval '14 days' GROUP BY 1`,
    [slug],
  );
  return { byStatus, customerConversations24h: c[0] ? c[0].n : 0, perDay: dayBuckets(days, 14) };
}

/** One group's occurrences per day over the last 14 days. */
async function groupPerDay({ slug, fingerprint }) {
  const { rows } = await db.query(
    `SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day, COUNT(*)::int AS n FROM error_events
      WHERE agent_slug = $1 AND fingerprint = $2 AND created_at > now() - interval '14 days' GROUP BY 1`,
    [slug, String(fingerprint || '')],
  );
  return dayBuckets(rows, 14);
}

/** How many of the agent's groups are new (incl. reopened) — the Admin menu count. */
async function countNew({ slug }) {
  const params = [];
  const where = filterSql({ slug }, params);
  params.push(slug);
  const { rows } = await db.query(
    `WITH g AS (
       SELECT fingerprint, MAX(created_at) AS last_seen FROM error_events WHERE ${where} GROUP BY fingerprint
     )
     SELECT COUNT(*)::int AS n FROM g
       LEFT JOIN error_groups s ON s.agent_slug = $${params.length} AND s.fingerprint = g.fingerprint
      WHERE ${EFFECTIVE_STATUS} = 'new'`,
    params,
  );
  return rows[0] ? rows[0].n : 0;
}

/**
 * Decide about a group: New → Looking at it → Handled (or Ignored), with
 * a short note on what was done. Handled reopens by itself if the error
 * comes back; Ignored stays quiet.
 */
async function setGroupStatus({ slug, fingerprint, status, note, by }) {
  if (!STATUSES.includes(status)) {
    const e = new Error(`"status" is one of: ${STATUSES.join(', ')}.`);
    e.status = 400;
    throw e;
  }
  const fp = String(fingerprint || '');
  if (!/^[0-9a-f]{40}$/.test(fp)) {
    const e = new Error('Unknown error group.');
    e.status = 400;
    throw e;
  }
  const cleanNote = String(note ?? '').trim().slice(0, 1000);
  await db.query(
    `INSERT INTO error_groups (agent_slug, fingerprint, status, note, status_by, status_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (agent_slug, fingerprint)
     DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, status_by = EXCLUDED.status_by, status_at = now()`,
    [String(slug || ''), fp, status, cleanNote, by ? String(by).slice(0, 60) : null],
  );
  return { fingerprint: fp, status, note: cleanNote };
}

/**
 * Write only the note — the status and its time stay as they are, so a note
 * on a group that came back does not quietly mark it handled again.
 */
async function setGroupNote({ slug, fingerprint, note, by }) {
  const fp = String(fingerprint || '');
  if (!/^[0-9a-f]{40}$/.test(fp)) {
    const e = new Error('Unknown error group.');
    e.status = 400;
    throw e;
  }
  const cleanNote = String(note ?? '').trim().slice(0, 1000);
  await db.query(
    `INSERT INTO error_groups (agent_slug, fingerprint, status, note, status_by)
     VALUES ($1, $2, 'new', $3, $4)
     ON CONFLICT (agent_slug, fingerprint)
     DO UPDATE SET note = EXCLUDED.note, status_by = COALESCE(EXCLUDED.status_by, error_groups.status_by)`,
    [String(slug || ''), fp, cleanNote, by ? String(by).slice(0, 60) : null],
  );
  return { fingerprint: fp, note: cleanNote };
}

/** One group's decision row (or null) — used by alerts. */
async function readGroupRow({ slug, fingerprint }) {
  const { rows } = await db.query(
    'SELECT status, status_at, last_alert_at FROM error_groups WHERE agent_slug = $1 AND fingerprint = $2',
    [String(slug || ''), fingerprint],
  );
  return rows[0] || null;
}

/** How many times this group has happened (in the kept month). */
async function countOccurrences({ slug, fingerprint }) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n, MIN(created_at) AS first_seen FROM error_events
      WHERE agent_slug IS NOT DISTINCT FROM $1 AND fingerprint = $2 AND created_at > now() - interval '${KEEP_DAYS} days'`,
    [slug || null, fingerprint],
  );
  return rows[0] || { n: 0 };
}

/**
 * Claim the right to alert about this group, atomically — so two errors at
 * once (or two server instances) send one email. Allowed when the group is
 * brand new, or was marked handled and came back, and has not alerted
 * since that decision. "Looking at it" and "Ignored" never alert.
 * Resolves true when this caller won the claim.
 */
async function claimAlert({ slug, fingerprint }) {
  const { rows } = await db.query(
    `INSERT INTO error_groups (agent_slug, fingerprint, status, status_at, last_alert_at)
     VALUES ($1, $2, 'new', now(), now())
     ON CONFLICT (agent_slug, fingerprint) DO UPDATE SET last_alert_at = now()
      WHERE error_groups.status IN ('new', 'handled')
        AND (error_groups.last_alert_at IS NULL OR error_groups.last_alert_at < error_groups.status_at)
     RETURNING status`,
    [String(slug || ''), fingerprint],
  );
  return rows.length > 0;
}

/** Every occurrence of one group, newest first. */
async function listOccurrences({ slug, fingerprint, limit }) {
  const params = [];
  const where = filterSql({ slug }, params);
  params.push(String(fingerprint || ''));
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const { rows } = await db.query(
    `SELECT id, conversation_id, message_id, addon_run_id, source, area, kind, code, message, detail, created_at
       FROM error_events
      WHERE ${where} AND fingerprint = $${params.length - 1}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(r => ({
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    addonRunId: r.addon_run_id,
    source: r.source,
    area: r.area,
    kind: r.kind,
    code: r.code,
    message: r.message,
    detail: r.detail || {},
    createdAt: r.created_at,
  }));
}

module.exports = {
  record, recordNow, swallowed, classify, listGroups, listOccurrences,
  countNew, setGroupStatus, setGroupNote, readGroupRow, countOccurrences, claimAlert, summary, groupPerDay,
  withContext, currentContext, wasRecorded, markRecorded, onWrite,
  expressCatchAll, installCrashHandlers,
  // exported for the offline battery
  _internal: { scrub, normalise, fingerprintOf, write, errorFactsFromUrl },
  AREAS, KINDS, SOURCES, STATUSES, KEEP_DAYS,
};
