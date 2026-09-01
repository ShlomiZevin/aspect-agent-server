/**
 * trigger-clock.service — the heartbeat that runs Builder V2 Triggers.
 *
 * See docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * ── What the clock is, and what it deliberately isn't ──────────────
 *
 * It knows NOTHING about what any trigger means. Once a minute it asks
 * each agent's enabled triggers "who's due?" and acts on what comes
 * back. All the intelligence — thresholds, caps, spacing, quiet hours —
 * lives in the trigger types, so adding a new kind of trigger never
 * touches this file.
 *
 * It is SYSTEM level, not per agent. A per-agent interval would not
 * decide when anything fires (each trigger decides that); it would only
 * decide how LATE a fire may be. Nobody wants to configure their own
 * sloppiness. The one thing worth saying out loud is the consequence:
 * **the tick interval is the precision floor of every trigger.** A
 * five-minute clock cannot honour "after one minute of silence".
 *
 * ── Why a lease and not a lock ─────────────────────────────────────
 *
 * Cloud Run runs 1–3 copies of this server (deploy.sh: --min-instances 1
 * --max-instances 3). One Cloud Scheduler job means one HTTP call, so
 * normally only one copy ticks — but a retry, an overlapping slow tick,
 * or a manual Step-once could still double up, and a double tick means a
 * customer nudged twice.
 *
 * A Postgres advisory lock is the textbook answer and is wrong here: it
 * is session-scoped, so it would have to hold a pooled connection open
 * for the whole sweep, and a sweep makes LLM calls and can run for
 * minutes. Instead the tick claims a short LEASE row with one atomic
 * conditional UPDATE. If the claim fails, another copy is already
 * ticking and this one returns immediately. A crashed holder's lease
 * simply expires — no stuck lock, no manual recovery.
 *
 * ── Two layers, and only one of them is authoritative ──────────────
 *
 * The lease stops ticks OVERLAPPING. It does not, and cannot, stop two
 * ticks running back to back — and it doesn't need to. The thing that
 * actually prevents a customer being nudged twice is the EVENT LOG: the
 * first fire writes a `trigger_events` row, and the spacing clause in
 * the trigger's own rules then refuses another attempt inside the
 * window. That guard holds no matter how the second sweep was started —
 * the clock, a manual Step once, or somebody pressing "Run now" on the
 * card.
 *
 * So: the lease is a COST guard (don't do the same expensive sweep
 * twice), the event log is the CORRECTNESS guard. Worth knowing before
 * anyone strengthens the lease thinking it is what stands between a
 * customer and a double message.
 */

const db = require('./db.pg');
const triggerDispatcher = require('../builder/runtime/triggerDispatcher');

/**
 * The clock's state is PER ENVIRONMENT, not global.
 *
 * A local server points at the same database as production. With one
 * shared row, switching the clock on to watch a trigger fire on your
 * laptop would also arm production — and setting a 10-second cadence for
 * testing would set it for real customers too.
 *
 * Cloud Run always sets `K_SERVICE`; nothing else does. So its absence
 * is a reliable "this is somebody's machine", and the key gets a
 * suffix. Local and production then have their own switch, their own
 * cadence, their own mode — and their own lease, so a slow local sweep
 * can never block the production tick.
 *
 * Derived rather than configured, for the same reason the local
 * conversation-surface restriction is: a setting to say "I am local"
 * would live in the shared database, which is the problem it was meant
 * to solve.
 */
const IS_CLOUD = !!process.env.K_SERVICE;
const ENV_SUFFIX = IS_CLOUD ? '' : ':local';

/**
 * What a tick is ALLOWED to touch, decided by where it is running.
 *
 * A laptop points at the same database as production, so anything that
 * fires locally can reach real customer conversations. This returns the
 * restriction rather than leaving it to each caller to remember: an
 * earlier version passed `conversationKinds: ['builder-preview']` from
 * the scheduled runner in server.js only, which left the "Step once"
 * button — the same tick, one HTTP call away — completely unwalled.
 * Guarding the door beats guarding each person who walks through it.
 *
 * Cloud is unrestricted: production SHOULD reach customers, that being
 * the entire point of the feature.
 */
function environmentKinds() {
  return IS_CLOUD ? null : ['builder-preview'];
}

const SETTINGS_KEY = `triggers_clock_settings${ENV_SUFFIX}`;
const LEASE_KEY    = `triggers_clock_lease${ENV_SUFFIX}`;

/**
 * How long a claimed tick is considered "in progress". Long enough to
 * cover a sweep that is making LLM calls; short enough that a copy
 * killed mid-tick doesn't block the next one for long.
 */
const LEASE_MS = 5 * 60 * 1000;

/** One prefix for everything the clock says, so `grep '[triggers]'`
 *  gives the whole story of a tick and nothing else. */
function log(msg) { console.log(`[triggers] ${msg}`); }

/** The cadence choices. Seconds, because local development wants to see
 *  a trigger fire now, not in a minute. Anything under a minute is
 *  local-only in practice — Cloud Scheduler's floor is 60s. */
const INTERVAL_CHOICES = [5, 10, 30, 60, 300, 900];

const DEFAULT_SETTINGS = {
  /** Master switch. Off by default: the clock is the one part of this
   *  feature that acts without anybody watching, so it should never
   *  start running because a deploy happened. Somebody turns it on. */
  enabled: false,
  /**
   * How often the in-process (local) runner ticks. Re-read every cycle,
   * so changing it in the UI takes effect without a restart.
   *
   * In production the real cadence is the Cloud Scheduler job and this
   * is only the number the UI quotes as the precision floor — Cloud
   * Scheduler cannot go below 60s whatever this says.
   */
  intervalSeconds: 60,
  /**
   * Which agent version the clock reads triggers from.
   *
   *   'published' — the published pointer, falling back to active then
   *                 viewing. What customers are actually served, and the
   *                 default.
   *   'active'    — the active pointer, falling back to published. What
   *                 a human has deliberately promoted, whether or not
   *                 they went on to publish it.
   *
   * Neither runs an unsaved draft. An earlier version offered 'viewing'
   * for that, which was a mistake: the clock messages real customers and
   * should never act on something nobody has promoted.
   *
   * The choice exists at all because the first local run reported
   * "watching 0 agents" with no hint why — the agent HAD a published
   * version, from before triggers existed, so the clock was faithfully
   * reading a body with no triggers in it. A silent zero is the worst
   * possible answer, so `modeHint` in `health()` now explains it.
   */
  mode: 'published',
};

async function getSettings() {
  const { rows } = await db.query('SELECT value FROM provider_config WHERE key = $1 LIMIT 1', [SETTINGS_KEY]);
  if (!rows.length || !rows[0].value) return { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(rows[0].value);
    // Older rows carried `intervalMinutes`; carry them forward rather
    // than snapping a deliberate 15-minute cadence back to the default.
    if (saved.intervalSeconds === undefined && saved.intervalMinutes !== undefined) {
      saved.intervalSeconds = Math.max(1, parseInt(saved.intervalMinutes, 10) || 1) * 60;
    }
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  const seconds = parseInt(next.intervalSeconds, 10);
  const value = JSON.stringify({
    enabled: !!next.enabled,
    // Clamped, not rejected: a hand-edited row shouldn't be able to
    // spin the tick every 100ms or park it for a day.
    intervalSeconds: Math.min(3600, Math.max(5, Number.isFinite(seconds) ? seconds : 60)),
    mode: next.mode === 'active' ? 'active' : 'published',
  });
  await db.query(
    `INSERT INTO provider_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [SETTINGS_KEY, value],
  );
  return JSON.parse(value);
}

/**
 * Claim the tick. ONE atomic statement: the row is only written if the
 * existing lease has expired (or there is no row at all), so two copies
 * racing cannot both succeed.
 *
 * @returns {Promise<boolean>} true if this process may proceed
 */
async function claimLease(holder) {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS);
  const value = JSON.stringify({ holder, until: until.toISOString(), claimedAt: now.toISOString() });
  const { rows } = await db.query(
    `INSERT INTO provider_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()
      WHERE COALESCE((provider_config.value::jsonb ->> 'until')::timestamptz, to_timestamp(0)) < now()
     RETURNING key`,
    [LEASE_KEY, value],
  );
  return rows.length > 0;
}

/** Release early so a slow tick doesn't block the next minute. */
async function releaseLease() {
  await db.query(
    `UPDATE provider_config
        SET value = jsonb_set(value::jsonb, '{until}', to_jsonb(now()))::text, updated_at = now()
      WHERE key = $1`,
    [LEASE_KEY],
  ).catch(() => { /* the lease expires on its own; this is only politeness */ });
}

async function leaseInfo() {
  const { rows } = await db.query('SELECT value, updated_at FROM provider_config WHERE key = $1 LIMIT 1', [LEASE_KEY]);
  if (!rows.length || !rows[0].value) return null;
  try {
    const v = JSON.parse(rows[0].value);
    return { ...v, held: new Date(v.until).getTime() > Date.now() };
  } catch {
    return null;
  }
}

/**
 * Which agents have any enabled trigger at all.
 *
 * The jsonb test does the filtering in the database, so a platform with
 * hundreds of agents still costs one query.
 *
 * WHICH VERSION it reads is the `mode` setting, and it matters more than
 * it looks. In `published` mode the clock acts only on what customers
 * are actually served — correct in production, and never a draft
 * somebody is mid-edit on. But an agent that was published BEFORE
 * triggers existed has a published body with no triggers in it, so a
 * trigger you just saved is invisible and the clock reports "watching 0
 * agents" with no hint why. `viewing` mode is the local-development
 * answer: read what you are editing.
 *
 * Each mode falls back through the other pointers, so an agent that has
 * only ever been "activated" still works either way.
 */
async function agentsWithTriggers(mode = 'published') {
  // ONE version per agent — never a scan across every saved version, so
  // an agent can appear at most once and its triggers are evaluated
  // exactly once per tick.
  //
  // These expressions MUST match how `resolveAgentBody` resolves the
  // same mode, since that is what the sweep then reads the body with.
  // They briefly didn't — discovery used a wider fallback than
  // resolution, so an agent could be found here and then throw "Agent
  // has no version pointer" when the sweep tried to run it, once per
  // tick, forever.
  const pointer = mode === 'active'
    ? 'COALESCE(a.active_version_id, a.published_version_id)'
    : 'COALESCE(a.published_version_id, a.active_version_id, a.viewing_version_id)';
  const { rows } = await db.query(`
    SELECT a.slug
      FROM builder_agents a
      JOIN builder_agent_versions v
        ON v.id = ${pointer}
     WHERE a.archived_at IS NULL
       AND jsonb_typeof(v.body -> 'triggers' -> 'triggers') = 'array'
       AND jsonb_array_length(v.body -> 'triggers' -> 'triggers') > 0
       AND COALESCE(v.body -> 'triggers' ->> 'enabled', 'true') <> 'false'
     ORDER BY a.slug
  `);
  return rows.map(r => r.slug);
}

/**
 * One tick.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.force]   run even when the master switch is off
 *                                 (the admin "Step once" button)
 * @param {boolean} [opts.dryRun]  evaluate and report, launch nothing
 * @param {string}  [opts.mode]    override the configured version mode
 * @param {string}  [opts.holder]  identifies the claiming process in logs
 */
async function runTick({ force = false, dryRun = false, mode, holder = 'tick', conversationKinds = null } = {}) {
  const started = Date.now();
  const settings = await getSettings();
  // The setting is the default; an explicit argument still wins so a
  // caller can force one sweep against the other version.
  const useMode = mode || settings.mode || 'published';
  // Not `conversationKinds || environmentKinds()` — a caller must not be
  // able to widen the wall by passing null. Off-cloud it is forced.
  const kinds = IS_CLOUD ? conversationKinds : environmentKinds();

  if (!settings.enabled && !force) {
    return { skipped: 'clock is off', enabled: false, agents: 0, fired: 0, durationMs: Date.now() - started };
  }

  if (!(await claimLease(holder))) {
    // Not an error: another copy is mid-tick. Saying so plainly beats a
    // silent no-op when someone is reading the logs to work out why a
    // nudge didn't go out.
    log('skipped — another instance is mid-tick (lease held)');
    return { skipped: 'another instance holds the tick lease', agents: 0, fired: 0, durationMs: Date.now() - started };
  }

  const results = [];
  let fired = 0;
  let errors = 0;
  // Agents are the unit of DISCOVERY; triggers are the unit of WORK, and
  // one agent can hold many. A tick summary that counts only agents
  // hides how much actually ran.
  let triggers = 0;
  try {
    const slugs = await agentsWithTriggers(useMode);
    if (slugs.length === 0) {
      // The commonest confusion by far, so it says WHY rather than
      // just reporting a zero.
      const other = await agentsWithTriggers(useMode === 'active' ? 'published' : 'active');
      log(other.length > 0
        ? `no agent has an enabled trigger in its ${useMode} version — but ${other.length} do in the other one. Change Reads on the clock bar.`
        : `no agent has an enabled trigger in its ${useMode} version. Save + enable one, and switch the agent's Triggers master toggle on.`);
    } else {
      // Opens the tick. The per-trigger lines that follow each name
      // their own agent, so this is the frame, not the detail.
      log(`tick — reading ${useMode} versions · ${slugs.length} agent${slugs.length === 1 ? '' : 's'}: ${slugs.join(', ')}`);
    }
    for (const slug of slugs) {
      try {
        const r = await triggerDispatcher.sweepAgent({ agentSlug: slug, mode: useMode, dryRun, conversationKinds: kinds });
        for (const t of r.results || []) {
          fired += (t.fired || []).filter(f => f.outcome === 'spoke').length;
          triggers += 1;
        }
        results.push(r);
      } catch (err) {
        errors += 1;
        // One broken agent must never stop the sweep for the others.
        console.error(`[trigger-clock] agent "${slug}" failed:`, err.message);
        results.push({ agentSlug: slug, error: err.message });
      }
    }
  } finally {
    await releaseLease();
  }

  return {
    ranAt: new Date().toISOString(),
    dryRun,
    mode: useMode,
    agents: results.length,
    triggers,
    fired,
    errors,
    durationMs: Date.now() - started,
    results,
  };
}

function describeInterval(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** Everything the clock bar needs, in one call. */
async function health() {
  const settings = await getSettings();
  const [lease, slugs, otherModeSlugs] = await Promise.all([
    leaseInfo(),
    agentsWithTriggers(settings.mode),
    // Peeked so a zero can explain itself: "nothing published, but your
    // saved version has one" is a completely different problem from
    // "you haven't made a trigger", and the first is the one that
    // silently wasted somebody's afternoon.
    agentsWithTriggers(settings.mode === 'active' ? 'published' : 'active'),
  ]);

  const every = describeInterval(settings.intervalSeconds);
  return {
    enabled: settings.enabled,
    // Which clock this is. Said out loud in the bar, because "the clock
    // is running" means something different on a laptop than in
    // production, and the two are now genuinely separate switches.
    environment: IS_CLOUD ? 'cloud' : 'local',
    intervalSeconds: settings.intervalSeconds,
    intervalChoices: INTERVAL_CHOICES,
    mode: settings.mode,
    precisionNote: `Triggers can only be as precise as the clock — a ${every} tick means a fire can be up to ${every} late.`,
    ticking: !!lease?.held,
    lastClaimedAt: lease?.claimedAt || null,
    agentsWithTriggers: slugs,
    /** Set when this mode sees nothing but the other one would. */
    modeHint: slugs.length === 0 && otherModeSlugs.length > 0
      ? (settings.mode === 'published'
          ? 'No PUBLISHED agent has an enabled trigger, but an ACTIVE one does. Publish the agent, or set Reads to Active while you are testing.'
          : 'No ACTIVE agent has an enabled trigger, but a PUBLISHED one does. Set Reads to Published.')
      : null,
  };
}

module.exports = {
  environmentKinds,
  runTick,
  // Exported for the battery: the atomicity of a claim is the whole
  // point of the lease, and it can only be tested by racing it
  // directly — two real ticks are usually too fast to overlap.
  claimLease,
  releaseLease,
  health,
  getSettings,
  setSettings,
  agentsWithTriggers,
  SETTINGS_KEY,
  LEASE_KEY,
  LEASE_MS,
};
