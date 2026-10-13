/**
 * ZolStock creative store inventory - nightly refresh + Reut's link (#106 / #107)
 *
 * refresh(): reads Reut's two creative files straight from Drive, runs the
 * calculation in creative-inventory.service.js and writes the daily table to
 * GCS. It is skipped when neither input changed since the last run (md5s are
 * kept on the output object), so calling it every night is cheap. It runs
 * after zolstock's nightly Drive sync (scheduler-tick.service.js).
 *
 * The files sit in their own Drive folder today; Reut was asked to move them
 * into the main ZolStock folder. Both folders are searched and the newest copy
 * of each file wins, so the move needs no code change.
 *
 * The link: https://aspect-agents.web.app/zolstock/creative-stock/<token>/<file>.csv
 * Hosting proxies it to Cloud Run, which checks the token and answers with a
 * 302 to a short-lived signed GCS URL. A redirect rather than streaming the
 * body: the table is ~1 GB and Hosting cuts a proxied Cloud Run response at
 * 60s. The backend address never appears - only the storage URL, which expires.
 *
 * The token is a random secret kept as a private object in the bucket, not in
 * env or the admin config list: one link, for one consumer (Reut's Qlik).
 * Replacing that object revokes the link.
 */

const crypto = require('crypto');
const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const gcsService = require('./gcs.service');
const providerConfigService = require('./provider-config.service');
const { writeDailyStock } = require('./creative-inventory.service');

const CREATIVE_FOLDER_ID = '1OHvMrdGc7ziRvdjylMso5RIJACOPjYAw';
const ENTRIES_FILE = 'CustomerOrdersCreativeMaterials.csv';
const EXITS_FILE = 'SalesCreativeMaterials.csv';

const BUCKET = 'aspect-clients-data';
// Outside zolstock/ on purpose: the loader and the Drive sync own that prefix.
const OUTPUT_PATH = 'exports/zolstock/creative_daily_stock.csv';
const TOKEN_PATH = 'exports/zolstock/.creative_stock_token';
const DOWNLOAD_NAME = 'ZolStock_Creative_Daily_Stock.csv';
const SIGNED_URL_MINUTES = 60;

// Same service account Drive sync uses: shared on the client's Drive folders,
// writes the bucket, and - being a key, not the Cloud Run metadata identity -
// can sign URLs without the iamcredentials API.
function saCredentials() {
  return process.env.DRIVE_SYNC_SA_KEY ? JSON.parse(process.env.DRIVE_SYNC_SA_KEY) : null;
}

function bucket() {
  const credentials = saCredentials();
  const storage = credentials ? new Storage({ credentials }) : gcsService.storage;
  return storage.bucket(BUCKET);
}

function driveClient() {
  const credentials = saCredentials();
  if (!credentials) throw new Error('DRIVE_SYNC_SA_KEY is not set - cannot read the creative files from Drive');
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  return google.drive({ version: 'v3', auth });
}

/** Newest copy of each input file across the creative and main ZolStock folders. */
async function findInputs(drive) {
  const mainFolder = await providerConfigService.get('zolstock_drive_folder_id');
  const folders = [CREATIVE_FOLDER_ID, mainFolder].filter(Boolean);
  const found = {};
  for (const folderId of folders) {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and (name = '${ENTRIES_FILE}' or name = '${EXITS_FILE}')`,
      fields: 'files(id, name, md5Checksum, modifiedTime, size)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    for (const f of res.data.files) {
      if (!found[f.name] || f.modifiedTime > found[f.name].modifiedTime) found[f.name] = f;
    }
  }
  for (const name of [ENTRIES_FILE, EXITS_FILE]) {
    if (!found[name]) throw new Error(`${name} not found in Drive folders ${folders.join(', ')}`);
  }
  return { entries: found[ENTRIES_FILE], exits: found[EXITS_FILE] };
}

async function downloadText(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data).toString('utf8');
}

let running = null;

/**
 * Rebuilds the daily stock table in GCS when an input changed.
 * @param {Object} [opts]
 * @param {boolean} [opts.force] - rebuild even if the inputs are unchanged
 * @param {(line:string)=>void} [opts.log]
 */
function refresh(opts = {}) {
  // One run per instance at a time - the tick re-fires every minute of the
  // Drive sync window and a rebuild takes longer than that.
  if (!running) running = doRefresh(opts).finally(() => { running = null; });
  return running;
}

async function doRefresh({ force = false, log = console.log } = {}) {
  const drive = driveClient();
  const inputs = await findInputs(drive);
  const out = bucket().file(OUTPUT_PATH);

  if (!force) {
    const [exists] = await out.exists();
    if (exists) {
      const [meta] = await out.getMetadata();
      const m = meta.metadata || {};
      if (m.entriesMd5 === inputs.entries.md5Checksum && m.exitsMd5 === inputs.exits.md5Checksum) {
        return { action: 'unchanged' };
      }
    }
  }

  log(`[creative-stock] rebuilding from ${ENTRIES_FILE} (${inputs.entries.modifiedTime}) + ${EXITS_FILE} (${inputs.exits.modifiedTime})`);
  const [entriesCsv, exitsCsv] = await Promise.all([
    downloadText(drive, inputs.entries.id),
    downloadText(drive, inputs.exits.id),
  ]);

  const upload = out.createWriteStream({
    resumable: true,
    contentType: 'text/csv; charset=utf-8',
    metadata: {
      metadata: {
        entriesMd5: inputs.entries.md5Checksum,
        exitsMd5: inputs.exits.md5Checksum,
        entriesModified: inputs.entries.modifiedTime,
        exitsModified: inputs.exits.modifiedTime,
      },
    },
  });
  const done = new Promise((resolve, reject) => upload.on('finish', resolve).on('error', reject));
  const write = chunk => (upload.write(chunk) ? undefined : new Promise(r => upload.once('drain', r)));

  // BOM so Excel opens the Hebrew header correctly; Qlik ignores it.
  await write('﻿');
  const stats = await writeDailyStock(entriesCsv, exitsCsv, write);
  upload.end();
  await done;

  log(`[creative-stock] wrote ${stats.rowsWritten} rows, ${stats.pairs} store x item pairs, last date ${stats.lastDate}`);
  return { action: 'rebuilt', ...stats };
}

/** The link secret, created on first use. */
async function getToken() {
  const f = bucket().file(TOKEN_PATH);
  const [exists] = await f.exists();
  if (exists) {
    const [buf] = await f.download();
    return buf.toString('utf8').trim();
  }
  const token = crypto.randomBytes(24).toString('base64url');
  await f.save(token, { contentType: 'text/plain', resumable: false, preconditionOpts: { ifGenerationMatch: 0 } })
    .catch(async err => {
      // Lost a create race: someone else's token is the real one.
      if (err.code !== 412) throw err;
    });
  const [buf] = await f.download();
  return buf.toString('utf8').trim();
}

let cachedToken = null;

async function verifyToken(given) {
  if (!cachedToken) cachedToken = await getToken();
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(cachedToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Short-lived signed URL for the current table, or null when not built yet. */
async function signedDownloadUrl() {
  const out = bucket().file(OUTPUT_PATH);
  const [exists] = await out.exists();
  if (!exists) return null;
  const [url] = await out.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_MINUTES * 60 * 1000,
    responseDisposition: `attachment; filename="${DOWNLOAD_NAME}"`,
  });
  return url;
}

function publicLink(token, origin = 'https://aspect-agents.web.app') {
  return `${origin}/zolstock/creative-stock/${token}/${DOWNLOAD_NAME}`;
}

module.exports = { refresh, getToken, verifyToken, signedDownloadUrl, publicLink, OUTPUT_PATH };
