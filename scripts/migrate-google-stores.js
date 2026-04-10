#!/usr/bin/env node
/**
 * Migrate Google File Search Stores from one API key to another.
 *
 * Reads all KBs that have a google_corpus_id, downloads documents from
 * the OLD key's stores, creates new stores under the NEW key, uploads
 * the documents, and updates the DB mapping.
 *
 * Requires:
 *   GEMINI_API_KEY      — the new key (current .env value)
 *   Files are downloaded from GCS (service account) or OpenAI — the old
 *   Google API key is NOT needed.
 *
 * Usage:
 *   node scripts/migrate-google-stores.js
 *   node scripts/migrate-google-stores.js "KB Name"
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'agents_platform_db',
  user: process.env.DB_USER || 'agent_admin',
  password: process.env.DB_PASSWORD,
});

const NEW_KEY = process.env.GEMINI_API_KEY;

if (!NEW_KEY) {
  console.error('❌ Set GEMINI_API_KEY in .env to the new API key');
  process.exit(1);
}

let newClient = null;

async function getNewClient() {
  if (newClient) return newClient;
  const { GoogleGenAI } = await import('@google/genai');
  newClient = new GoogleGenAI({ apiKey: NEW_KEY });
  return newClient;
}

async function run() {
  const filterKbName = process.argv[2] || null;
  console.log(`\n🔄 Migrating Google File Search Stores from old key to new key`);
  if (filterKbName) console.log(`   Filtering: "${filterKbName}"`);
  console.log();

  const client = await pool.connect();
  try {
    // 1. Find KBs with google stores
    const query = filterKbName
      ? `SELECT id, name, google_corpus_id FROM knowledge_bases WHERE google_corpus_id IS NOT NULL AND LOWER(name) = LOWER($1)`
      : `SELECT id, name, google_corpus_id FROM knowledge_bases WHERE google_corpus_id IS NOT NULL ORDER BY id`;
    const params = filterKbName ? [filterKbName] : [];
    const kbRes = await client.query(query, params);

    if (kbRes.rows.length === 0) {
      console.log('No KBs with google_corpus_id found');
      return;
    }

    console.log(`Found ${kbRes.rows.length} KB(s) to migrate:\n`);

    const newAI = await getNewClient();

    for (const kb of kbRes.rows) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`📚 KB: "${kb.name}" (id=${kb.id})`);
      console.log(`   Old store: ${kb.google_corpus_id}`);

      // 2. Get file records from DB (we download from GCS or OpenAI, not old Google store)
      const filesRes = await client.query(
        `SELECT id, file_name, file_type, google_document_id, original_file_url, openai_file_id
         FROM knowledge_base_files WHERE knowledge_base_id = $1`,
        [kb.id]
      );
      const filesByDocId = {};
      for (const f of filesRes.rows) {
        if (f.google_document_id) filesByDocId[f.google_document_id] = f;
      }

      // 3. Create new store
      let newStoreId;
      try {
        const newStore = await newAI.fileSearchStores.create({ displayName: kb.name });
        newStoreId = newStore.name;
        console.log(`   ✅ New store created: ${newStoreId}`);
      } catch (err) {
        console.error(`   ❌ Failed to create new store: ${err.message}`);
        continue;
      }

      // 4. For each file, download from GCS/OpenAI and upload to new store
      let migrated = 0;
      let failed = 0;

      for (const dbFile of filesRes.rows) {
        console.log(`\n   --- ${dbFile.file_name} ---`);

        let buffer = null;
        let mimeType = 'application/octet-stream';

        // Try GCS first (most reliable — original file bytes)
        // Check both original_file_url (regular files) and dynamic KB attachments (dynamic files)
        let gcsPath = dbFile.original_file_url;
        if (!gcsPath) {
          // Check if this is a dynamic KB file — look up GCS path via attachments
          try {
            const dynRes = await client.query(
              `SELECT d.gcs_path FROM dynamic_kb_attachments a
               JOIN dynamic_kb_files d ON d.id = a.dynamic_file_id
               WHERE a.kb_file_id = $1 LIMIT 1`,
              [dbFile.id]
            );
            if (dynRes.rows.length > 0) {
              gcsPath = dynRes.rows[0].gcs_path;
            }
          } catch { /* ignore */ }
        }

        if (gcsPath) {
          try {
            const { Storage } = require('@google-cloud/storage');
            const keyFilePath = path.join(__dirname, '../storage-service-account-api-key.json');
            const bucket = new Storage({ keyFilename: keyFilePath }).bucket(process.env.GCS_BUCKET_NAME || 'aspect-kb-files');
            const [data] = await bucket.file(gcsPath).download();
            buffer = data;
            console.log(`   📥 Downloaded from GCS: ${gcsPath} (${buffer.length} bytes)`);
          } catch (err) {
            console.warn(`   ⚠️ GCS download failed: ${err.message}`);
          }
        }

        // Fallback: try OpenAI
        if (!buffer && dbFile.openai_file_id) {
          try {
            const { OpenAI } = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const response = await openai.files.content(dbFile.openai_file_id);
            const arrayBuffer = await response.arrayBuffer();
            buffer = Buffer.from(arrayBuffer);
            console.log(`   📥 Downloaded from OpenAI (${buffer.length} bytes)`);
          } catch (err) {
            console.warn(`   ⚠️ OpenAI download failed: ${err.message}`);
          }
        }

        if (!buffer) {
          console.error(`   ❌ No source to download file from — skipping`);
          failed++;
          continue;
        }

        // Guess MIME type
        const ext = (dbFile.file_type || path.extname(dbFile.file_name || '').replace('.', '') || '').toLowerCase();
        const mimeMap = {
          pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          csv: 'text/csv', html: 'text/html',
        };
        mimeType = mimeMap[ext] || mimeType;

        // Upload to new store
        try {
          const blob = new Blob([buffer], { type: mimeType });
          const operation = await newAI.fileSearchStores.uploadToFileSearchStore({
            fileSearchStoreName: newStoreId,
            file: blob,
            config: { displayName: dbFile.file_name },
          });

          let result = operation;
          if (!result?.done && typeof result?.wait === 'function') {
            result = await result.wait();
          } else if (!result?.done && result?.name) {
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                result = await newAI.operations.get(result.name);
                if (result?.done) break;
              } catch { /* continue */ }
            }
          }

          const newDocId = result?.response?.name || result?.name || `${newStoreId}/documents/unknown`;
          console.log(`   ✅ Uploaded to new store: ${newDocId}`);

          // Update DB
          await client.query(
            `UPDATE knowledge_base_files SET google_document_id = $1, updated_at = NOW() WHERE id = $2`,
            [newDocId, dbFile.id]
          );
          migrated++;
        } catch (err) {
          console.error(`   ❌ Upload failed: ${err.message}`);
          failed++;
        }
      }

      // 5. Update KB with new store ID
      await client.query(
        `UPDATE knowledge_bases SET google_corpus_id = $1, updated_at = NOW() WHERE id = $2`,
        [newStoreId, kb.id]
      );
      console.log(`\n   ✅ KB updated: google_corpus_id = ${newStoreId}`);
      console.log(`   📊 ${migrated} migrated, ${failed} failed`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log('\n✅ Migration complete');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
