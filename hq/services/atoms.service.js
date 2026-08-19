/**
 * HQ — atoms & sources persistence.
 *
 * Everything HQ knows normalises into one `hq_atoms` row, so retrieval,
 * timeline, dedup and permissions stay a single code path and connectors
 * stay thin. See docs/guides/LYBI_HQ.md §4.
 */

const crypto = require('crypto');
const db = require('../../services/db.pg');

function hashContent(text) {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

// ─── Sources ─────────────────────────────────────────────────────────────────

async function createSource({ kind, label, config = {}, syncMode = 'once' }) {
  const { rows } = await db.query(
    `INSERT INTO hq_sources (kind, label, config, sync_mode)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [kind, label, JSON.stringify(config), syncMode]
  );
  return rows[0];
}

/**
 * The one long-lived source row for a whole provider (as opposed to the
 * per-link rows Drop creates). Integrations sync against this.
 */
async function getOrCreateProviderSource(kind, label) {
  const { rows } = await db.query(
    `SELECT * FROM hq_sources WHERE kind = $1 AND config->>'provider' = 'true' LIMIT 1`,
    [kind]
  );
  if (rows[0]) return rows[0];

  const { rows: created } = await db.query(
    `INSERT INTO hq_sources (kind, label, config, sync_mode)
     VALUES ($1, $2, '{"provider":"true"}'::jsonb, 'watch') RETURNING *`,
    [kind, label]
  );
  return created[0];
}

async function findSourceByConfigKey(kind, key, value) {
  const { rows } = await db.query(
    `SELECT * FROM hq_sources WHERE kind = $1 AND config->>$2 = $3 LIMIT 1`,
    [kind, key, value]
  );
  return rows[0] || null;
}

async function updateSource(id, { lastStatus, lastError, atomCount, lastSyncAt }) {
  const { rows } = await db.query(
    `UPDATE hq_sources
        SET last_status  = COALESCE($2, last_status),
            last_error   = $3,
            atom_count   = COALESCE($4, atom_count),
            last_sync_at = COALESCE($5, last_sync_at),
            updated_at   = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, lastStatus || null, lastError || null, atomCount ?? null, lastSyncAt || null]
  );
  return rows[0];
}

async function listSources() {
  const { rows } = await db.query(`SELECT * FROM hq_sources ORDER BY created_at DESC`);
  return rows;
}

async function deleteSource(id) {
  await db.query(`DELETE FROM hq_sources WHERE id = $1`, [id]);
}

// ─── Atoms ───────────────────────────────────────────────────────────────────

/**
 * Insert or update an atom keyed on `external_id`. Re-syncing the same Notion
 * page is therefore idempotent — and because we compare `content_hash`, an
 * unchanged page is reported as `changed: false` so the caller can skip the
 * expensive re-embed entirely.
 */
async function upsertAtom(atom) {
  const {
    kind = 'doc', title, body = '', summary = null,
    sourceId = null, externalId = null, externalUrl = null,
    authors = [], participants = [], projects = [], entities = [],
    occurredAt = null, visibility = 'company',
  } = atom;

  const contentHash = hashContent(body);

  if (externalId) {
    const { rows: existing } = await db.query(
      `SELECT id, content_hash FROM hq_atoms WHERE external_id = $1`,
      [externalId]
    );
    if (existing.length) {
      const prev = existing[0];
      const changed = prev.content_hash !== contentHash;

      const { rows } = await db.query(
        `UPDATE hq_atoms
            SET kind = $2, title = $3, body = $4,
                source_id = COALESCE($5, source_id),
                external_url = $6,
                content_hash = $7,
                authors = $8, participants = $9, projects = $10, entities = $11,
                occurred_at = $12, visibility = $13,
                status = CASE WHEN $14 THEN 'pending' ELSE status END,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [prev.id, kind, title, body, sourceId, externalUrl, contentHash,
         JSON.stringify(authors), JSON.stringify(participants),
         JSON.stringify(projects), JSON.stringify(entities),
         occurredAt, visibility, changed]
      );
      return { atom: rows[0], changed, created: false };
    }
  }

  const { rows } = await db.query(
    `INSERT INTO hq_atoms
       (kind, title, body, summary, source_id, external_id, external_url, content_hash,
        authors, participants, projects, entities, occurred_at, visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [kind, title, body, summary, sourceId, externalId, externalUrl, contentHash,
     JSON.stringify(authors), JSON.stringify(participants),
     JSON.stringify(projects), JSON.stringify(entities), occurredAt, visibility]
  );
  return { atom: rows[0], changed: true, created: true };
}

async function getAtom(id) {
  const { rows } = await db.query(
    `SELECT a.*, s.kind AS source_kind, s.label AS source_label
       FROM hq_atoms a
       LEFT JOIN hq_sources s ON s.id = a.source_id
      WHERE a.id = $1`, [id]);
  return rows[0] || null;
}

async function getAtomsByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT id, kind, title, summary, external_url, occurred_at, participants
       FROM hq_atoms WHERE id = ANY($1::int[])`,
    [ids]
  );
  return rows;
}

async function listAtoms({ kind = null, search = null, limit = 100, offset = 0 } = {}) {
  const where = [`a.visibility = 'company'`];
  const params = [];

  if (kind)   { params.push(kind);            where.push(`a.kind = $${params.length}`); }
  if (search) { params.push(`%${search}%`);   where.push(`(a.title ILIKE $${params.length} OR a.body ILIKE $${params.length})`); }

  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT a.id, a.kind, a.title, a.summary, a.external_url, a.occurred_at, a.ingested_at,
            a.participants, a.projects, a.decisions, a.actions, a.questions,
            a.status, a.scribe_status, a.chunk_count, a.error,
            s.kind AS source_kind, s.label AS source_label
       FROM hq_atoms a
       LEFT JOIN hq_sources s ON s.id = a.source_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(a.occurred_at, a.ingested_at) DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function countAtoms() {
  const { rows } = await db.query(
    `SELECT kind, status, COUNT(*)::int AS count
       FROM hq_atoms WHERE visibility = 'company'
      GROUP BY kind, status`
  );
  return rows;
}

async function setAtomIndexed(id, { chunkCount, status = 'indexed', error = null }) {
  await db.query(
    `UPDATE hq_atoms SET chunk_count = $2, status = $3, error = $4, updated_at = NOW()
      WHERE id = $1`,
    [id, chunkCount ?? 0, status, error]
  );
}

async function setScribeResult(id, { summary, decisions, actions, questions, status = 'done' }) {
  const { rows } = await db.query(
    `UPDATE hq_atoms
        SET summary = COALESCE($2, summary),
            decisions = COALESCE($3, decisions),
            actions = COALESCE($4, actions),
            questions = COALESCE($5, questions),
            scribe_status = $6,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id,
     summary ?? null,
     decisions ? JSON.stringify(decisions) : null,
     actions ? JSON.stringify(actions) : null,
     questions ? JSON.stringify(questions) : null,
     status]
  );
  return rows[0];
}

/**
 * The Scribe is fire-and-forget, so anything in flight dies with the process —
 * a restart (or a one-off import script exiting) leaves atoms pinned at
 * `running` with nothing to ever clear them, and the UI spins forever.
 *
 * Mark those failed so they surface a retry instead of a permanent spinner.
 * `updated_at` is touched whenever the status is set, so it doubles as the
 * "started at" for a running pass.
 */
async function reclaimStaleScribes(staleMinutes = 15) {
  const { rows } = await db.query(
    `UPDATE hq_atoms
        SET scribe_status = 'failed',
            error = COALESCE(error, 'The summary was interrupted — re-run it.'),
            updated_at = NOW()
      WHERE scribe_status = 'running'
        AND updated_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(staleMinutes)]
  );
  if (rows.length) console.log(`[hq] reclaimed ${rows.length} stalled Scribe run(s)`);
  return rows.map(r => r.id);
}

async function setScribeStatus(id, status, error = null) {
  await db.query(
    `UPDATE hq_atoms SET scribe_status = $2, error = COALESCE($3, error), updated_at = NOW()
      WHERE id = $1`,
    [id, status, error]
  );
}

/** Free-form patch from the UI — the "everything must be correctable" rule. */
async function patchAtom(id, patch) {
  const allowed = {
    title: 'title', summary: 'summary', kind: 'kind',
    decisions: 'decisions', actions: 'actions', questions: 'questions',
    participants: 'participants', projects: 'projects', occurredAt: 'occurred_at',
    visibility: 'visibility',
  };
  const jsonCols = new Set(['decisions', 'actions', 'questions', 'participants', 'projects']);

  const sets = [];
  const params = [id];

  for (const [key, column] of Object.entries(allowed)) {
    if (patch[key] === undefined) continue;
    params.push(jsonCols.has(column) ? JSON.stringify(patch[key]) : patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return getAtom(id);

  const { rows } = await db.query(
    `UPDATE hq_atoms SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0];
}

async function deleteAtom(id) {
  await db.query(`DELETE FROM hq_atoms WHERE id = $1`, [id]);
}

module.exports = {
  hashContent,
  createSource, getOrCreateProviderSource, findSourceByConfigKey, updateSource, listSources, deleteSource,
  upsertAtom, getAtom, getAtomsByIds, listAtoms, countAtoms,
  setAtomIndexed, setScribeResult, setScribeStatus, reclaimStaleScribes, patchAtom, deleteAtom,
};
