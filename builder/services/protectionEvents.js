/**
 * Data protection blocks (task #986) — the record of every customer
 * message a code detector stopped, and the reads behind the per-agent
 * report (MCP now, Admin next).
 *
 *   record({...})          one block → its id
 *   reportMistake({...})   the customer's "blocked by mistake" tap
 *   report({...})          counts per detector / side / surface + recent rows
 *   surfaceOf(metadata)    a conversation's surface as stored here
 *
 * The one rule: NEVER the sensitive value, a hash of it, or any text of
 * the message — detector ids, where and when. Nothing in this file takes
 * the message text as an argument, so nothing can store it by accident.
 *
 * Table: protection_events (migrations/071_protection_events.sql).
 */

const db = require('../../services/db.pg');

const SIDES = new Set(['client', 'server']);
const SURFACES = new Set(['live', 'builder', 'simulation', 'api']);
const LANGS = new Set(['he', 'en']);

/** A conversation's `metadata.kind` → the surface stored on a block. */
function surfaceOf(metadata) {
  const kind = metadata && metadata.kind;
  if (kind === 'live') return 'live';
  if (kind === 'builder-preview') return 'builder';
  if (kind === 'simulation') return 'simulation';
  return 'api';
}

/**
 * Keep one block. Throws on a bad argument or a database failure — the
 * caller decides (the server gate still blocks when the record fails).
 * @returns {Promise<number>} the new row id
 */
async function record({ agentSlug, conversationId = null, side, surface, detectors, lang = null }) {
  if (!agentSlug) throw new Error('protectionEvents.record: agentSlug is required');
  if (!SIDES.has(side)) throw new Error(`protectionEvents.record: bad side "${side}"`);
  if (!SURFACES.has(surface)) throw new Error(`protectionEvents.record: bad surface "${surface}"`);
  if (!Array.isArray(detectors) || detectors.length === 0) throw new Error('protectionEvents.record: detectors is required');
  const conv = Number.isInteger(Number(conversationId)) && Number(conversationId) > 0 ? Number(conversationId) : null;
  const { rows } = await db.query(
    `INSERT INTO protection_events (agent_slug, conversation_id, side, surface, detectors, lang)
     VALUES ($1, $2, $3, $4, $5::text[], $6) RETURNING id`,
    [String(agentSlug), conv, side, surface, detectors.map(String), LANGS.has(lang) ? lang : null],
  );
  return rows[0].id;
}

/**
 * The customer said "blocked by mistake". Only records — the message is
 * never let through. Idempotent: a second tap keeps the first time.
 * @returns {Promise<null | { id: number, alreadyReported: boolean }>} null = no such block on this agent
 */
async function reportMistake({ agentSlug, id }) {
  const blockId = Number(id);
  if (!Number.isInteger(blockId) || blockId <= 0) return null;
  const { rows } = await db.query(
    `UPDATE protection_events
        SET mistake_reported_at = COALESCE(mistake_reported_at, now())
      WHERE id = $1 AND agent_slug = $2
      RETURNING id, (mistake_reported_at < now()) AS already`,
    [blockId, String(agentSlug)],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, alreadyReported: !!rows[0].already };
}

/**
 * The report for one agent over the last `days` days.
 * @returns {Promise<{ days: number, total: number, mistakes: number,
 *   bySide: Record<string, number>, bySurface: Record<string, number>,
 *   byDetector: { id: string, blocks: number, mistakes: number }[],
 *   recent: { id: number, at: string, side: string, surface: string, detectors: string[],
 *             conversationId: number|null, lang: string|null, mistakeReportedAt: string|null }[] }>}
 */
async function report({ agentSlug, days = 30, recentLimit = 50 }) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  const lim = Math.min(Math.max(Number(recentLimit) || 50, 1), 500);
  const slug = String(agentSlug);
  const since = `now() - ($2::int * interval '1 day')`;

  const [totals, sides, surfaces, detectors, recent] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS total, count(mistake_reported_at)::int AS mistakes
         FROM protection_events WHERE agent_slug = $1 AND created_at >= ${since}`,
      [slug, d],
    ),
    db.query(
      `SELECT side, count(*)::int AS n FROM protection_events
        WHERE agent_slug = $1 AND created_at >= ${since} GROUP BY side`,
      [slug, d],
    ),
    db.query(
      `SELECT surface, count(*)::int AS n FROM protection_events
        WHERE agent_slug = $1 AND created_at >= ${since} GROUP BY surface`,
      [slug, d],
    ),
    db.query(
      `SELECT det AS id, count(*)::int AS blocks, count(mistake_reported_at)::int AS mistakes
         FROM protection_events, unnest(detectors) AS det
        WHERE agent_slug = $1 AND created_at >= ${since}
        GROUP BY det ORDER BY blocks DESC, det`,
      [slug, d],
    ),
    db.query(
      `SELECT id, created_at, side, surface, detectors, conversation_id, lang, mistake_reported_at
         FROM protection_events
        WHERE agent_slug = $1 AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT $3`,
      [slug, d, lim],
    ),
  ]);

  const toMap = (rows, key) => Object.fromEntries(rows.map(r => [r[key], r.n]));
  return {
    days: d,
    total: totals.rows[0] ? totals.rows[0].total : 0,
    mistakes: totals.rows[0] ? totals.rows[0].mistakes : 0,
    bySide: toMap(sides.rows, 'side'),
    bySurface: toMap(surfaces.rows, 'surface'),
    byDetector: detectors.rows.map(r => ({ id: r.id, blocks: r.blocks, mistakes: r.mistakes })),
    recent: recent.rows.map(r => ({
      id: r.id,
      at: new Date(r.created_at).toISOString(),
      side: r.side,
      surface: r.surface,
      detectors: r.detectors,
      conversationId: r.conversation_id,
      lang: r.lang,
      mistakeReportedAt: r.mistake_reported_at ? new Date(r.mistake_reported_at).toISOString() : null,
    })),
  };
}

module.exports = { record, reportMistake, report, surfaceOf, SURFACES };
