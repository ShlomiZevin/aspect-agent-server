const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const gcsService = require('./gcs.service');

/**
 * Drive -> GCS sync service
 *
 * Mirrors each client's Google Drive source folder into the GCS bucket
 * (`aspect-clients-data`) that the data loaders read from. This closes the
 * previously-MANUAL "BI exports to Drive -> someone uploads to GCS" gap.
 *
 * Auth: a service account (storage-admin@aspect-agents) that is BOTH shared
 * (Viewer) on the client's Drive folder AND has write access to the bucket.
 * Drive scopes via gcloud ADC are blocked by Google ("App Blocked"), so we
 * authenticate with the same service-account key file that gcs.service uses.
 *
 * Only files whose content changed (md5) are re-uploaded, so a daily run is
 * cheap even with multi-GB files. Files stream Drive -> GCS directly (no local
 * disk), which matters on Cloud Run for the ~4 GB zer4u sales file.
 */

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

/**
 * Per-client sync configuration.
 *  - mode 'passthrough'    : upload each Drive .csv under its own name (loader
 *                            keys on the exact *_CSV.csv Drive names).
 *  - mode 'canonical-match': rename each Drive file to the matching canonical
 *                            name already present in GCS (loader needs clean
 *                            Hebrew/English names, e.g. מכירות.csv not מכירות_CSV.csv).
 */
const CLIENTS = {
  zer4u: {
    folderId: '1nvWho7jR0uKtATwKCG2hvXIAC_kxCkgA',
    gcsPrefix: 'zer4u/',
    mode: 'canonical-match',
    // Pure Qlik-export dead weight the loader ignores (SKIP_TABLES in
    // reload-zer4u-zero-downtime.js). ~2.3 GB we never want to transfer.
    skipStems: new Set(['linktable', 'shorot kbla']),
  },
  hypertoy: {
    folderId: '19PCeLwdNJv2VYsb6iUOriNa8PEJmUoVO',
    gcsPrefix: 'hyper-toy/',
    mode: 'passthrough',
    skipStems: new Set(),
  },
};

/**
 * Normalize a filename to a comparison stem:
 *   - drop the .csv extension
 *   - drop a trailing _CSV token (Reut's Drive naming convention)
 *   - lowercase, collapse runs of _/whitespace to a single space
 * Hyphens are preserved (INLFED.csv vs INLFED-1.csv stay distinct).
 */
function normalizeStem(basename) {
  return basename
    .replace(/\.csv$/i, '')
    .replace(/_csv$/i, '')
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();
}

/** Drive md5Checksum is hex; GCS md5Hash is base64 — convert to compare. */
function hexToBase64(hex) {
  return Buffer.from(hex, 'hex').toString('base64');
}

function getDriveClient() {
  const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(__dirname, '..', 'storage-service-account-api-key.json');

  const auth = fs.existsSync(keyFilePath)
    ? new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: DRIVE_SCOPES })
    : new google.auth.GoogleAuth({ scopes: DRIVE_SCOPES }); // ADC fallback (Cloud Run runtime SA)

  return google.drive({ version: 'v3', auth });
}

/** List all non-folder files in a Drive folder (handles pagination + shared drives). */
async function listDriveFiles(drive, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name, mimeType, md5Checksum, size, modifiedTime)',
      pageSize: 1000,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    files.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

/**
 * Build normalizedStem -> canonical GCS basename map from files already in the
 * bucket. These are the proven-correct names the loader expects, so we rename
 * Drive files to match them rather than guessing.
 */
async function buildCanonicalMap(gcsPrefix) {
  const gcsFiles = await gcsService.listCSVFiles(gcsPrefix);
  const map = new Map();
  const collisions = [];
  for (const f of gcsFiles) {
    const stem = normalizeStem(f.basename);
    if (map.has(stem) && map.get(stem) !== f.basename) {
      collisions.push(`${stem}: ${map.get(stem)} / ${f.basename}`);
    }
    map.set(stem, f.basename);
  }
  return { map, collisions };
}

/**
 * Sync one client's Drive folder into GCS.
 * @param {string} client - 'zer4u' | 'hypertoy'
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun] - plan only, upload nothing
 * @param {(line:string)=>void} [opts.log] - progress sink (default console.log)
 * @returns {Promise<Object>} report
 */
async function syncClient(client, opts = {}) {
  const cfg = CLIENTS[client];
  if (!cfg) throw new Error(`Unknown client '${client}'. Known: ${Object.keys(CLIENTS).join(', ')}`);

  const dryRun = !!opts.dryRun;
  const log = opts.log || console.log;
  const startedAt = Date.now();

  log(`[drive-sync] ${client}: starting (${dryRun ? 'DRY RUN' : 'LIVE'}) folder=${cfg.folderId} -> ${cfg.gcsPrefix}`);

  const drive = getDriveClient();
  const driveFiles = (await listDriveFiles(drive, cfg.folderId))
    .filter(f => /\.csv$/i.test(f.name));
  log(`[drive-sync] ${client}: ${driveFiles.length} CSV file(s) in Drive`);

  let canonicalMap = null;
  let canonicalCollisions = [];
  if (cfg.mode === 'canonical-match') {
    const built = await buildCanonicalMap(cfg.gcsPrefix);
    canonicalMap = built.map;
    canonicalCollisions = built.collisions;
    if (canonicalCollisions.length) {
      log(`[drive-sync] ${client}: WARNING canonical-name collisions: ${canonicalCollisions.join('; ')}`);
    }
  }

  const report = {
    client, dryRun,
    uploaded: [], unchanged: [], skipped: [], unmapped: [], failed: [], missingCanonical: [],
  };
  const matchedStems = new Set();

  for (const file of driveFiles) {
    const stem = normalizeStem(file.name);

    if (cfg.skipStems.has(stem)) {
      report.skipped.push({ name: file.name, reason: 'skip-table' });
      continue;
    }

    // Resolve destination basename
    let targetBasename;
    if (cfg.mode === 'passthrough') {
      targetBasename = file.name;
    } else {
      targetBasename = canonicalMap.get(stem);
      if (!targetBasename) {
        report.unmapped.push({ name: file.name, stem });
        continue;
      }
      matchedStems.add(stem);
    }

    const targetPath = cfg.gcsPrefix + targetBasename;

    // Skip unchanged files (md5 match)
    try {
      const gcsMeta = await gcsService.getFileMetadata(targetPath);
      if (gcsMeta && file.md5Checksum && gcsMeta.md5Hash === hexToBase64(file.md5Checksum)) {
        report.unchanged.push({ name: file.name, target: targetBasename });
        continue;
      }

      if (dryRun) {
        report.uploaded.push({ name: file.name, target: targetBasename, bytes: file.size, planned: true });
        log(`[drive-sync] ${client}: WOULD upload ${file.name} -> ${targetBasename} (${file.size} bytes)`);
        continue;
      }

      const res = await drive.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      const up = await gcsService.uploadStream(res.data, targetPath, { contentType: 'text/csv' });
      report.uploaded.push({ name: file.name, target: targetBasename, bytes: up.size });
      log(`[drive-sync] ${client}: uploaded ${file.name} -> ${targetBasename} (${up.size} bytes)`);
    } catch (err) {
      report.failed.push({ name: file.name, target: targetBasename, error: err.message });
      log(`[drive-sync] ${client}: FAILED ${file.name} -> ${targetBasename}: ${err.message}`);
    }
  }

  // Validation: canonical GCS files that NO Drive file mapped to (skip-tables excluded)
  if (cfg.mode === 'canonical-match') {
    for (const [stem, basename] of canonicalMap.entries()) {
      if (cfg.skipStems.has(stem)) continue;
      if (!matchedStems.has(stem)) report.missingCanonical.push(basename);
    }
  }

  report.durationMs = Date.now() - startedAt;
  log(`[drive-sync] ${client}: done in ${(report.durationMs / 1000).toFixed(1)}s — `
    + `uploaded=${report.uploaded.length} unchanged=${report.unchanged.length} `
    + `skipped=${report.skipped.length} unmapped=${report.unmapped.length} `
    + `missingCanonical=${report.missingCanonical.length} failed=${report.failed.length}`);

  return report;
}

module.exports = { syncClient, CLIENTS, normalizeStem };
