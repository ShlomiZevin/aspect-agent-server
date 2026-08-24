/**
 * HQ — where everything a worker makes is kept.
 *
 * Bytes go to GCS (`lybi-hq-media`), the record goes to `hq_media`. Its own
 * bucket on purpose: `aspect-clients-data` holds client exports, and HQ must
 * not be able to write there — the separation is the point, and one shared
 * bucket would quietly erode it.
 *
 * Filing: every item remembers the conversation and job it came from, which is
 * how people actually look for things ("the images from the launch chat").
 * Folders exist on top of that for when you want to impose an order, and are
 * always optional.
 */

const { Storage } = require('@google-cloud/storage');
const path = require('path');
const db = require('../../services/db.pg');

const BUCKET = process.env.HQ_MEDIA_BUCKET || 'lybi-hq-media';

let storage = null;
function client() {
  if (storage) return storage;
  const keyFile = path.join(__dirname, '..', '..', 'storage-service-account-api-key.json');
  storage = require('fs').existsSync(keyFile)
    ? new Storage({ keyFilename: keyFile })
    : new Storage();
  return storage;
}

function slugify(name = '') {
  return String(name)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';
}

/**
 * Store bytes and record them.
 *
 * `makePublic` is deliberately false: the bucket is uniform-access and HQ is
 * internal, so the browser gets a signed URL instead of the file being
 * readable by anyone who guesses the path.
 */
async function store(buffer, {
  workerId = null, conversationId = null, jobId = null, folderId = null,
  title = null, kind = 'image', mimeType = 'image/jpeg', extension = 'jpg',
  width = null, height = null, prompt = null, model = null, costUsd = null,
  source = 'leonardo', metadata = {},
} = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const objectPath = `hq/${conversationId || 'loose'}/${stamp}-${slugify(title)}.${extension}`;

  const file = client().bucket(BUCKET).file(objectPath);
  await file.save(buffer, { contentType: mimeType, resumable: false });

  const { rows } = await db.query(
    `INSERT INTO hq_media
       (worker_id, conversation_id, job_id, folder_id, kind, title, gcs_path,
        mime_type, width, height, bytes, prompt, model, cost_usd, source, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [workerId, conversationId, jobId, folderId, kind, title, objectPath,
     mimeType, width, height, buffer.length, prompt, model, costUsd, source,
     JSON.stringify(metadata)]
  );

  return withUrl(rows[0]);
}

/**
 * Signed URLs expire, so they're minted on read rather than stored. A saved
 * URL would work in testing and be dead by the time anyone came back to it.
 */
async function signedUrl(gcsPath, minutes = 60 * 12) {
  const [url] = await client().bucket(BUCKET).file(gcsPath).getSignedUrl({
    version: 'v4', action: 'read', expires: Date.now() + minutes * 60 * 1000,
  });
  return url;
}

async function withUrl(row) {
  if (!row) return row;
  try {
    return { ...row, url: row.gcs_path ? await signedUrl(row.gcs_path) : row.url };
  } catch {
    return row;   // never let a signing hiccup hide the record itself
  }
}

async function list({ conversationId = null, folderId = null, jobId = null, workerId = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

  if (conversationId) add('conversation_id = $?', conversationId);
  if (folderId) add('folder_id = $?', folderId);
  if (jobId) add('job_id = $?', jobId);
  if (workerId) add('worker_id = $?', workerId);
  params.push(limit);

  const { rows } = await db.query(
    `SELECT * FROM hq_media
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return Promise.all(rows.map(withUrl));
}

/** The default browse view: newest conversations, each with its images. */
async function byConversation({ limit = 40 } = {}) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.updated_at, w.name AS worker_name, w.avatar,
            COUNT(m.id)::int AS media_count
       FROM hq_worker_conversations c
       JOIN hq_media m ON m.conversation_id = c.id
       LEFT JOIN hq_workers w ON w.id = c.worker_id
      GROUP BY c.id, c.title, c.updated_at, w.name, w.avatar
      ORDER BY c.updated_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function listFolders() {
  const { rows } = await db.query(
    `SELECT f.*, (SELECT COUNT(*)::int FROM hq_media m WHERE m.folder_id = f.id) AS media_count
       FROM hq_media_folders f ORDER BY f.name`);
  return rows;
}

async function createFolder(name, parentId = null) {
  const { rows } = await db.query(
    `INSERT INTO hq_media_folders (name, parent_id) VALUES ($1,$2) RETURNING *`, [name, parentId]);
  return rows[0];
}

async function moveToFolder(mediaIds, folderId) {
  await db.query(`UPDATE hq_media SET folder_id = $2 WHERE id = ANY($1::int[])`, [mediaIds, folderId]);
}

async function remove(id) {
  const { rows } = await db.query(`DELETE FROM hq_media WHERE id = $1 RETURNING gcs_path`, [id]);
  const gcsPath = rows[0]?.gcs_path;
  if (gcsPath) await client().bucket(BUCKET).file(gcsPath).delete().catch(() => {});
}

/** Raw bytes, for compositing — a signed URL cannot be inlined into a page. */
async function download(gcsPath) {
  const [buffer] = await client().bucket(BUCKET).file(gcsPath).download();
  return buffer;
}

module.exports = {
  BUCKET, store, list, byConversation, listFolders, createFolder, moveToFolder,
  remove, signedUrl, download,
};
