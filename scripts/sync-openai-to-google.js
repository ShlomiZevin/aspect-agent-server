#!/usr/bin/env node
/**
 * One-time script: Sync files from OpenAI vector store to Google File Search Store
 *
 * For files that have openai_file_id but no google_document_id / original_file_url:
 *   1. Download file content from OpenAI Files API
 *   2. Save backup to GCS (optional, skipped if GCS not configured/accessible)
 *   3. Upload to Google File Search Store
 *   4. Update DB: google_document_id + original_file_url
 *
 * Requires:
 *   - Cloud SQL Proxy running on 127.0.0.1:5432
 *   - OPENAI_API_KEY, GEMINI_API_KEY, GCS_BUCKET_NAME in .env
 *   - DB_HOST_PROXY, DB_PORT_PROXY, DB_NAME, DB_USER, DB_PASSWORD in .env
 *
 * Usage:
 *   node scripts/sync-openai-to-google.js [kb-name]
 *   If kb-name omitted, processes "Freeda Medical KB"
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Pool } = require('pg');
const { OpenAI } = require('openai');
const { Storage } = require('@google-cloud/storage');

// ── DB via proxy ──────────────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST_PROXY || '127.0.0.1',
  port: parseInt(process.env.DB_PORT_PROXY || '5432', 10),
  database: process.env.DB_NAME || 'agents_platform_db',
  user: process.env.DB_USER || 'agent_admin',
  password: process.env.DB_PASSWORD,
});

// ── OpenAI client ─────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── GCS client (optional) ─────────────────────────────────────────────────────
const bucketName = process.env.GCS_BUCKET_NAME || 'aspect-kb-files';
let gcsEnabled = false;
let gcsBucket = null;
try {
  gcsBucket = new Storage().bucket(bucketName);
  gcsEnabled = true;
} catch {
  console.warn('⚠️  GCS not available — skipping GCS backup');
}

// ── Google GenAI (lazy import) ────────────────────────────────────────────────
let googleAI = null;
async function getGoogleClient() {
  if (googleAI) return googleAI;
  const { GoogleGenAI } = await import('@google/genai');
  googleAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return googleAI;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Download a file's raw bytes from OpenAI. */
async function downloadFromOpenAI(openaiFileId) {
  console.log(`  📥 Downloading from OpenAI: ${openaiFileId}`);
  const response = await openai.files.content(openaiFileId);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Upload buffer to GCS, return the GCS path (or null on failure). */
async function uploadToGCS(buffer, fileName, mimeType, kbId) {
  if (!gcsEnabled) return null;
  try {
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const gcsPath = `kb-files/${kbId}/${timestamp}-${safeName}`;
    await gcsBucket.file(gcsPath).save(buffer, {
      metadata: { contentType: mimeType || 'application/octet-stream' },
    });
    console.log(`  ✅ Saved to GCS: ${gcsPath}`);
    return gcsPath;
  } catch (err) {
    console.warn(`  ⚠️  GCS upload failed (skipping): ${err.message}`);
    return null;
  }
}

/** Upload buffer to Google File Search Store, return document ID. */
async function uploadToGoogle(storeId, buffer, fileName, mimeType) {
  const ai = await getGoogleClient();
  const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  console.log(`  📤 Uploading to Google store ${storeId}: ${fileName} (${buffer.length} bytes)`);

  const operation = await ai.fileSearchStores.uploadToFileSearchStore({
    fileSearchStoreName: storeId,
    file: blob,
    config: { displayName: fileName },
  });

  // Poll until done
  let result = operation;
  if (!result?.done && !result?.response) {
    if (typeof result?.wait === 'function') {
      result = await result.wait();
    } else if (result?.name) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          result = await ai.operations.get(result.name);
          if (result?.done) break;
        } catch { /* continue polling */ }
      }
    }
  }

  const documentId = result?.response?.name || result?.name || `${storeId}/documents/unknown`;
  console.log(`  ✅ Google document ID: ${documentId}`);
  return documentId;
}

/** Guess MIME type from file extension/type. */
function getMimeType(fileName, fileType) {
  const ext = (fileType || path.extname(fileName || '').replace('.', '') || '').toLowerCase();
  const map = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || 'application/octet-stream';
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  const kbName = process.argv[2] || 'Freeda Medical KB';
  console.log(`\n🔄 Syncing files to Google for KB: "${kbName}"\n`);

  const client = await pool.connect();
  try {
    // 1. Find the KB
    const kbRes = await client.query(
      `SELECT kb.id, kb.name, kb.google_corpus_id
       FROM knowledge_bases kb
       WHERE LOWER(kb.name) = LOWER($1)
       LIMIT 1`,
      [kbName]
    );
    if (kbRes.rows.length === 0) {
      console.error(`❌ KB not found: "${kbName}"`);
      process.exit(1);
    }
    const kb = kbRes.rows[0];
    console.log(`📚 KB found: id=${kb.id}, google_corpus_id=${kb.google_corpus_id}`);

    if (!kb.google_corpus_id) {
      console.error('❌ KB has no google_corpus_id — run Sync to Google first from the dashboard');
      process.exit(1);
    }

    // 2. Find files missing google_document_id
    const filesRes = await client.query(
      `SELECT id, file_name, file_type, file_size, openai_file_id, google_document_id, original_file_url
       FROM knowledge_base_files
       WHERE knowledge_base_id = $1 AND openai_file_id IS NOT NULL AND google_document_id IS NULL`,
      [kb.id]
    );
    console.log(`📄 Files to sync: ${filesRes.rows.length}\n`);

    if (filesRes.rows.length === 0) {
      console.log('✅ No files need syncing');
      return;
    }

    let success = 0;
    let failed = 0;

    for (const file of filesRes.rows) {
      console.log(`\n--- File: ${file.file_name} (id=${file.id}) ---`);
      try {
        // a. Download from OpenAI
        const buffer = await downloadFromOpenAI(file.openai_file_id);
        const mimeType = getMimeType(file.file_name, file.file_type);

        // b. GCS backup (optional)
        let gcsPath = file.original_file_url; // keep existing if already set
        if (!gcsPath) {
          gcsPath = await uploadToGCS(buffer, file.file_name, mimeType, kb.id);
        }

        // c. Upload to Google
        const documentId = await uploadToGoogle(kb.google_corpus_id, buffer, file.file_name, mimeType);

        // d. Update DB
        const updates = { google_document_id: documentId };
        if (gcsPath && !file.original_file_url) {
          updates.original_file_url = gcsPath;
        }

        const setClauses = Object.keys(updates)
          .map((k, i) => `${k} = $${i + 2}`)
          .join(', ');
        await client.query(
          `UPDATE knowledge_base_files SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
          [file.id, ...Object.values(updates)]
        );

        console.log(`  ✅ DB updated: google_document_id = ${documentId}`);
        success++;
      } catch (err) {
        console.error(`  ❌ Failed: ${err.message}`);
        failed++;
      }
    }

    console.log(`\n📊 Done: ${success} synced, ${failed} failed`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
