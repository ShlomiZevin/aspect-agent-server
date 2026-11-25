/**
 * Lybi Gate — the traffic and audit log (gate_log).
 * Every call in and out and every admin change gets one row. A row holds
 * field names, actions and counts — never a value. Writing a log row never
 * fails the call it describes.
 */

const db = require('../../services/db.pg');

async function write(e) {
  try {
    await db.query(
      `INSERT INTO gate_log (kind, direction, status, http_status, actor, connection_id, record_id, policy_version, summary, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.kind, e.direction, e.status, e.httpStatus ?? null, e.actor ?? null, e.connectionId ?? null,
        e.recordId ?? null, e.policyVersion ?? null, JSON.stringify(e.summary || {}), e.durationMs ?? null],
    );
  } catch (err) {
    console.error('[gate] log write failed:', err.message);
  }
}

async function list({ limit = 100, kind = null } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const { rows } = kind
    ? await db.query(`SELECT * FROM gate_log WHERE kind = $1 ORDER BY id DESC LIMIT $2`, [kind, n])
    : await db.query(`SELECT * FROM gate_log ORDER BY id DESC LIMIT $1`, [n]);
  return rows.map(r => ({
    id: Number(r.id), at: r.at, kind: r.kind, direction: r.direction, status: r.status, httpStatus: r.http_status,
    actor: r.actor, connectionId: r.connection_id, recordId: r.record_id, policyVersion: r.policy_version,
    summary: r.summary, durationMs: r.duration_ms,
  }));
}

/** Counts of each action across a transformed record — what a log row carries. */
function actionCounts(data) {
  const c = {};
  for (const v of Object.values(data || {})) c[v.a] = (c[v.a] || 0) + 1;
  return c;
}

module.exports = { write, list, actionCounts };
