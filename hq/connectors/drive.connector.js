/**
 * Google Drive connector. See ./README.md for the interface.
 *
 * SCOPE IS THE CREDENTIAL, NOT A FILTER. This uses its own service account
 * (`lybi-hq-drive`) that is a member of exactly one shared drive. The account
 * that mirrors client exports into GCS can reach zer4u's sales data; this one
 * cannot, by construction. Never point this at that account "temporarily" —
 * a filter is a rule someone forgets, membership isn't.
 */

const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const KEY_FILE = path.join(__dirname, '..', '..', 'lybi-hq-drive-service-account.json');
const DRIVE_ID = process.env.HQ_DRIVE_ID || '0AONx5K8axO-KUk9PVA';
const FOLDER = 'application/vnd.google-apps.folder';

/**
 * How each file is read, and what it's called in the UI.
 * `export` = a Google-native format with no bytes of its own; `download` = a
 * real file we fetch and extract; `null` = nothing to read.
 */
const TYPES = {
  'application/vnd.google-apps.document':     { kind: 'document',     via: 'export',   as: 'text/markdown' },
  'application/vnd.google-apps.spreadsheet':  { kind: 'spreadsheet',  via: 'export',   as: 'text/csv' },
  'application/vnd.google-apps.presentation': { kind: 'presentation', via: 'export',   as: 'text/plain' },
  'application/pdf':                          { kind: 'pdf',          via: 'download' },
  'text/plain':                               { kind: 'text',         via: 'download' },
  'text/markdown':                            { kind: 'text',         via: 'download' },
  'text/csv':                                 { kind: 'text',         via: 'download' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                                              { kind: 'document',     via: 'download' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
                                              { kind: 'spreadsheet',  via: 'download' },
  'application/vnd.ms-excel':                 { kind: 'spreadsheet',  via: 'download' },
  // PowerPoint has no extractor in the KB stack, so we unzip it below.
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
                                              { kind: 'presentation', via: 'download' },
  'text/html':                                { kind: 'text',         via: 'download' },
  'application/json':                         { kind: 'text',         via: 'download' },
  'application/rtf':                          { kind: 'text',         via: 'download' },
  'application/xml':                          { kind: 'text',         via: 'download' },
  'text/xml':                                 { kind: 'text',         via: 'download' },
};

/**
 * A .pptx is a zip of XML. The KB extractor doesn't cover it and there's no
 * library for it here, but the slide text sits in <a:t> elements, which is
 * enough to make a deck searchable — 153 of them in this drive.
 */
async function pptxText(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);

  const slides = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));

  const out = [];
  for (const name of slides) {
    const xml = await zip.files[name].async('string');
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
    const text = runs.join(' ').replace(/\s+/g, ' ').trim();
    if (text) out.push('--- Slide ' + (out.length + 1) + ' ---\n' + text);
  }
  return out.join('\n\n');
}

function typeOf(mimeType) {
  return TYPES[mimeType] || { kind: 'unreadable', via: null };
}

let cached = null;

function getDrive() {
  if (cached) return cached;

  const inline = process.env.HQ_DRIVE_SA_KEY;
  const auth = inline
    ? new google.auth.GoogleAuth({ credentials: JSON.parse(inline), scopes: SCOPES })
    : new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: SCOPES });

  cached = google.drive({ version: 'v3', auth });
  return cached;
}

/** Shared-drive calls need these three flags on every request or they see nothing. */
const SHARED = {
  corpora: 'drive',
  driveId: DRIVE_ID,
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
};

async function listAll(q, fields, onPage = null) {
  const drive = getDrive();
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      ...SHARED, q, fields: `nextPageToken, files(${fields})`,
      pageSize: 1000, pageToken,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
    onPage?.({ found: out.length });
  } while (pageToken);
  return out;
}

module.exports = {
  id: 'google_drive',
  name: 'Google Drive',
  label: 'Lybi Drive',
  defaultKind: 'doc',

  isConfigured: () => !!process.env.HQ_DRIVE_SA_KEY || fs.existsSync(KEY_FILE),

  /**
   * Drive filters by modified time server-side, so a watermarked pass asks for
   * only what changed rather than listing everything and discarding most of it.
   *
   * Folders are listed in full every time regardless of the watermark: there
   * are few of them, and they're what gives every file its "which folder"
   * label. A watermarked pass would otherwise return a changed file whose
   * folder isn't in the batch.
   */
  async list({ since = null } = {}, onProgress = null) {
    const folders = await listAll(
      `mimeType = '${FOLDER}' and trashed = false`,
      'id,name,parents',
    );
    const folderName = new Map(folders.map(f => [f.id, f.name]));

    let q = `mimeType != '${FOLDER}' and trashed = false`;
    if (since) q += ` and modifiedTime > '${new Date(since).toISOString()}'`;

    const files = await listAll(
      q, 'id,name,mimeType,modifiedTime,parents,webViewLink,size',
      p => onProgress?.(p),
    );

    const items = files.map(f => {
      const type = typeOf(f.mimeType);
      const parentId = (f.parents || [])[0];
      return {
        externalId: f.id,
        title: f.name,
        url: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
        parentTitle: parentId === DRIVE_ID ? 'Drive root' : folderName.get(parentId) || null,
        // Doubles as the "Kind" filter, so unreadable files are visible and
        // skippable rather than quietly missing from the list.
        objectType: type.kind,
        // The label collapses formats; this is how the file is actually read.
        mimeType: f.mimeType,
        editedAt: f.modifiedTime || null,
      };
    });

    return { items, reachedEnd: !since };
  },

  async fetch(item) {
    const drive = getDrive();

    // Read by mime type, never by the display label: "document" covers both a
    // Google Doc (exported) and an uploaded .docx (downloaded), and guessing
    // from the label sent .docx down the export path for a 403.
    const how = typeOf(item.mime_type || '');
    if (!how.via) {
      throw new Error(`HQ can't read this kind of file (${item.object_type || item.mime_type})`);
    }

    let text;
    if (how.via === 'export') {
      const res = await drive.files.export(
        { fileId: item.external_id, mimeType: how.as, supportsAllDrives: true },
        { responseType: 'text' },
      );
      text = typeof res.data === 'string' ? res.data : String(res.data);
    } else {
      const res = await drive.files.get(
        { fileId: item.external_id, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      const buffer = Buffer.from(res.data);

      if (/\.pptx$/i.test(item.title)) {
        text = await pptxText(buffer);
      } else {
        // Reuse the KB extractor — it covers PDF, Word, Excel, CSV and text.
        // NOTE: it returns `{ text, pages }`, not a string.
        const chunker = require('../../services/kb.chunker.service');
        const result = await chunker.extractText(buffer, item.title, null);
        text = typeof result === 'string' ? result : result?.text || '';
      }
    }

    return {
      title: item.title,
      body: (text || '').trim(),
      externalId: item.external_id,
      url: item.url,
      people: [],
      tags: item.parent_title ? [item.parent_title] : [],
      occurredAt: item.remote_edited_at || null,
    };
  },
};
