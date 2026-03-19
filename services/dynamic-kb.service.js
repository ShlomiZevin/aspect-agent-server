/**
 * Dynamic KB Service
 *
 * Manages dynamic files that admins create/edit in the dashboard.
 * Files are stored as .md in GCS and auto-synced to all attached KB providers
 * (OpenAI vector store, Google File Search Store, Anthropic Files API) on save.
 */
const { eq, and, sql } = require('drizzle-orm');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const dbService = require('./db.pg');
const storageService = require('./storage.service');
const kbService = require('./kb.service');
const llmService = require('./llm');
const googleKBService = require('./kb.google.service');
const anthropicKBService = require('./kb.anthropic.service');

// Lazy-loaded schema to avoid circular deps at module load time
function getSchema() {
  const { dynamicKbFiles, dynamicKbAttachments, knowledgeBases, knowledgeBaseFiles, agents } = require('../db/schema');
  return { dynamicKbFiles, dynamicKbAttachments, knowledgeBases, knowledgeBaseFiles, agents };
}

function db() {
  return dbService.db;
}

// ─── Markdown conversion helpers ─────────────────────────────────────────────

/**
 * Convert table data to one-row-per-block markdown.
 * Each row becomes a self-contained section so vector stores never split
 * a row from its column headers.
 *
 * Output format:
 *   # {name}
 *   > Last updated: {date}
 *   > {N} items
 *
 *   ---
 *   ## {firstColValue}
 *   - Header1: Value1
 *   - Header2: Value2
 *   ---
 */
function tableToMarkdown(name, headers, rows) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# ${name}`,
    `> Last updated: ${date}`,
    `> ${rows.length} items`,
    '',
  ];

  for (const row of rows) {
    lines.push('---');
    // First column value is used as the block heading
    const heading = row[0] || '(empty)';
    lines.push(`## ${heading}`);
    for (let i = 0; i < headers.length; i++) {
      lines.push(`- ${headers[i]}: ${row[i] ?? ''}`);
    }
    lines.push('');
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Parse one-row-per-block markdown back to { headers, rows }.
 * Returns { headers: string[], rows: string[][] }.
 */
function markdownToTable(md) {
  const headers = [];
  const rows = [];

  const blocks = md.split(/\n---\n/).filter(b => b.trim());
  // Skip the file header block (starts with "# ")
  const dataBlocks = blocks.filter(b => /^## /m.test(b));

  for (const block of dataBlocks) {
    const lineItems = block.split('\n').filter(l => l.startsWith('- '));
    const rowValues = lineItems.map(l => {
      const colonIdx = l.indexOf(': ');
      return colonIdx >= 0 ? l.slice(colonIdx + 2) : l.slice(2);
    });

    if (headers.length === 0) {
      // Extract headers from the first block
      lineItems.forEach(l => {
        const colonIdx = l.indexOf(': ');
        headers.push(colonIdx >= 0 ? l.slice(2, colonIdx) : '');
      });
    }

    rows.push(rowValues);
  }

  return { headers, rows };
}

// ─── Provider upload helper (mirrors server.js upload logic) ─────────────────

/**
 * Upload a buffer to all providers of a KB.
 * Returns { openaiFileId, googleDocumentId, anthropicFileId }.
 */
async function uploadBufferToKB(kb, buffer, fileName, mimetype) {
  let openaiFileId = null;
  let googleDocumentId = null;
  let anthropicFileId = null;

  if (kb.provider === 'openai' || kb.provider === 'both') {
    const result = await llmService.addFileToVectorStore(buffer, fileName, kb.vectorStoreId);
    openaiFileId = result.fileId;
    console.log(`✅ [DynamicKB] Uploaded to OpenAI: ${openaiFileId}`);
  }

  if (kb.provider === 'google' || kb.provider === 'both') {
    const result = await googleKBService.uploadFile(kb.googleCorpusId, buffer, fileName, mimetype);
    googleDocumentId = result.documentId;
    console.log(`✅ [DynamicKB] Uploaded to Google: ${googleDocumentId}`);
  }

  if (kb.provider === 'anthropic') {
    const result = await anthropicKBService.uploadFile(buffer, fileName, mimetype);
    anthropicFileId = result.fileId;
    console.log(`✅ [DynamicKB] Uploaded to Anthropic: ${anthropicFileId}`);
  }

  return { openaiFileId, googleDocumentId, anthropicFileId };
}

/**
 * Delete a KB file from all providers (mirrors server.js delete logic).
 */
async function deleteFileFromProviders(kb, kbFile) {
  if (kbFile.openaiFileId && kb.vectorStoreId) {
    try { await llmService.deleteVectorStoreFile(kb.vectorStoreId, kbFile.openaiFileId); }
    catch (err) { console.warn(`⚠️ [DynamicKB] Could not delete from OpenAI: ${err.message}`); }
  }
  if (kbFile.googleDocumentId) {
    try { await googleKBService.deleteDocument(kbFile.googleDocumentId); }
    catch (err) { console.warn(`⚠️ [DynamicKB] Could not delete from Google: ${err.message}`); }
  }
  if (kbFile.anthropicFileId) {
    try { await anthropicKBService.deleteFile(kbFile.anthropicFileId); }
    catch (err) { console.warn(`⚠️ [DynamicKB] Could not delete from Anthropic: ${err.message}`); }
  }
}

// ─── Service class ────────────────────────────────────────────────────────────

class DynamicKBService {

  // ── CRUD ────────────────────────────────────────────────────────────────────

  /**
   * Create a new dynamic file record in the DB.
   */
  async createFile(agentId, name, fileType) {
    const { dynamicKbFiles } = getSchema();
    const [file] = await db()
      .insert(dynamicKbFiles)
      .values({ agentId, name, fileType })
      .returning();
    console.log(`✅ [DynamicKB] Created file: ${file.id} (${fileType})`);
    return file;
  }

  /**
   * List all dynamic files for an agent, with attachment count.
   */
  async getFilesByAgent(agentId) {
    const { dynamicKbFiles, dynamicKbAttachments } = getSchema();
    const files = await db()
      .select()
      .from(dynamicKbFiles)
      .where(eq(dynamicKbFiles.agentId, agentId))
      .orderBy(dynamicKbFiles.updatedAt);

    // Fetch attachment counts separately
    const counts = await db()
      .select({
        dynamicFileId: dynamicKbAttachments.dynamicFileId,
        count: sql`COUNT(*)`.as('count'),
      })
      .from(dynamicKbAttachments)
      .groupBy(dynamicKbAttachments.dynamicFileId);

    const countMap = new Map(counts.map(c => [c.dynamicFileId, parseInt(c.count)]));

    return files.map(f => ({ ...f, attachmentCount: countMap.get(f.id) || 0 }));
  }

  /**
   * Get a single dynamic file by ID.
   */
  async getFileById(fileId) {
    const { dynamicKbFiles } = getSchema();
    const [file] = await db()
      .select()
      .from(dynamicKbFiles)
      .where(eq(dynamicKbFiles.id, fileId))
      .limit(1);
    return file || null;
  }

  /**
   * Rename a dynamic file.
   */
  async updateFile(fileId, { name }) {
    const { dynamicKbFiles } = getSchema();
    const [file] = await db()
      .update(dynamicKbFiles)
      .set({ name, updatedAt: new Date() })
      .where(eq(dynamicKbFiles.id, fileId))
      .returning();
    return file;
  }

  /**
   * Delete a dynamic file: removes from GCS, detaches from all KBs, deletes from DB.
   */
  async deleteFile(fileId) {
    const { dynamicKbFiles, dynamicKbAttachments } = getSchema();

    const file = await this.getFileById(fileId);
    if (!file) throw new Error(`Dynamic file not found: ${fileId}`);

    // Detach from all KBs (removes from providers)
    const attachments = await this.getAttachments(fileId);
    for (const att of attachments) {
      try { await this.detachFromKB(fileId, att.kbId); }
      catch (err) { console.warn(`⚠️ [DynamicKB] Detach failed for KB ${att.kbId}: ${err.message}`); }
    }

    // Delete from GCS
    if (file.gcsPath) {
      try { await storageService.deleteFile(file.gcsPath); }
      catch (err) { console.warn(`⚠️ [DynamicKB] GCS delete failed: ${err.message}`); }
    }

    // Delete from DB
    await db().delete(dynamicKbFiles).where(eq(dynamicKbFiles.id, fileId));
    console.log(`✅ [DynamicKB] Deleted file: ${fileId}`);
  }

  // ── Content ─────────────────────────────────────────────────────────────────

  /**
   * Save content to GCS and trigger auto-sync to attached KBs.
   *
   * @param {number} fileId
   * @param {string|Object} content - markdown string (text) or { headers, rows } (table)
   * @param {string} fileType - 'text' | 'table'
   * @returns {{ synced: boolean, syncedKBs: string[], failedKBs: string[] }}
   */
  async saveContent(fileId, content, fileType) {
    const { dynamicKbFiles } = getSchema();

    const file = await this.getFileById(fileId);
    if (!file) throw new Error(`Dynamic file not found: ${fileId}`);

    // Convert to markdown
    let markdown;
    if (fileType === 'table') {
      const { headers, rows } = content;
      markdown = tableToMarkdown(file.name, headers, rows);
    } else {
      markdown = content;
    }

    const buffer = Buffer.from(markdown, 'utf8');
    const gcsPath = `dynamic-files/${file.agentId}/${fileId}.md`;

    // Save to GCS
    try {
      await storageService.uploadDynamicFile(buffer, gcsPath);
    } catch (err) {
      console.warn(`⚠️ [DynamicKB] GCS save failed: ${err.message}`);
      // Store content in metadata as fallback (dev without GCS)
    }

    // Update DB record
    await db()
      .update(dynamicKbFiles)
      .set({ gcsPath, fileSize: buffer.length, updatedAt: new Date() })
      .where(eq(dynamicKbFiles.id, fileId));

    // Auto-sync to attached KBs
    const syncResult = await this.syncAttachedKBs(fileId, buffer, file.name);

    return syncResult;
  }

  /**
   * Load content from GCS.
   * Returns markdown string (text) or { headers, rows } (table).
   */
  async loadContent(fileId) {
    const file = await this.getFileById(fileId);
    if (!file) throw new Error(`Dynamic file not found: ${fileId}`);

    if (!file.gcsPath) return file.fileType === 'table' ? { headers: [], rows: [] } : '';

    let buffer;
    try {
      buffer = await storageService.downloadFile(file.gcsPath);
    } catch (err) {
      console.warn(`⚠️ [DynamicKB] GCS load failed: ${err.message}`);
      return file.fileType === 'table' ? { headers: [], rows: [] } : '';
    }

    const markdown = buffer.toString('utf8');

    if (file.fileType === 'table') {
      return markdownToTable(markdown);
    }
    return markdown;
  }

  // ── Import parsers ───────────────────────────────────────────────────────────

  /**
   * Parse a .doc/.docx buffer and return extracted plain text.
   */
  async parseDocx(buffer) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  /**
   * Parse a .csv/.xls/.xlsx buffer and return { headers, rows }.
   */
  parseSpreadsheet(buffer, mimeType) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!data || data.length === 0) return { headers: [], rows: [] };

    const headers = (data[0] || []).map(String);
    const rows = data.slice(1).map(row =>
      headers.map((_, i) => String(row[i] ?? ''))
    );

    return { headers, rows };
  }

  /**
   * Generate markdown preview for a table (same as tableToMarkdown, exposed for API).
   */
  previewTableMarkdown(name, headers, rows) {
    return tableToMarkdown(name, headers, rows);
  }

  // ── Attachments ──────────────────────────────────────────────────────────────

  /**
   * Get all KB attachments for a dynamic file.
   */
  async getAttachments(fileId) {
    const { dynamicKbAttachments, knowledgeBases } = getSchema();
    const rows = await db()
      .select({
        id: dynamicKbAttachments.id,
        kbId: dynamicKbAttachments.knowledgeBaseId,
        kbFileId: dynamicKbAttachments.kbFileId,
        kbName: knowledgeBases.name,
        kbProvider: knowledgeBases.provider,
      })
      .from(dynamicKbAttachments)
      .innerJoin(knowledgeBases, eq(dynamicKbAttachments.knowledgeBaseId, knowledgeBases.id))
      .where(eq(dynamicKbAttachments.dynamicFileId, fileId));
    return rows;
  }

  /**
   * Attach a dynamic file to a KB:
   * - Upload .md content to KB providers
   * - Create knowledge_base_files record
   * - Create dynamic_kb_attachments record
   */
  async attachToKB(fileId, kbId) {
    const { dynamicKbAttachments } = getSchema();

    const file = await this.getFileById(fileId);
    if (!file) throw new Error(`Dynamic file not found: ${fileId}`);

    const kb = await kbService.getKnowledgeBaseById(kbId);
    if (!kb) throw new Error(`KB not found: ${kbId}`);

    // Load markdown content from GCS
    let buffer;
    if (file.gcsPath) {
      try {
        buffer = await storageService.downloadFile(file.gcsPath);
      } catch (err) {
        throw new Error(`Cannot load dynamic file content from GCS: ${err.message}`);
      }
    } else {
      throw new Error('Dynamic file has no content yet. Save content before attaching.');
    }

    const fileName = `${file.name}.md`;
    const mimetype = 'text/markdown';

    // Upload to provider(s)
    const { openaiFileId, googleDocumentId, anthropicFileId } = await uploadBufferToKB(
      kb, buffer, fileName, mimetype
    );

    // Create knowledge_base_files record
    const dbFile = await kbService.addFile(
      kbId,
      fileName,
      buffer.length,
      'md',
      { openaiFileId, googleDocumentId, anthropicFileId, originalFileUrl: file.gcsPath },
      [],
      'completed'
    );

    // Create attachment record
    await db()
      .insert(dynamicKbAttachments)
      .values({ dynamicFileId: fileId, knowledgeBaseId: kbId, kbFileId: dbFile.id });

    await kbService.updateFileStats(kbId);
    console.log(`✅ [DynamicKB] Attached file ${fileId} to KB ${kbId}`);
    return dbFile;
  }

  /**
   * Detach a dynamic file from a KB:
   * - Delete from providers
   * - Delete knowledge_base_files record
   * - Delete attachment record
   */
  async detachFromKB(fileId, kbId) {
    const { dynamicKbAttachments, knowledgeBaseFiles } = getSchema();

    const [attachment] = await db()
      .select()
      .from(dynamicKbAttachments)
      .where(and(
        eq(dynamicKbAttachments.dynamicFileId, fileId),
        eq(dynamicKbAttachments.knowledgeBaseId, kbId)
      ))
      .limit(1);

    if (!attachment) return; // already detached

    const kb = await kbService.getKnowledgeBaseById(kbId);

    if (attachment.kbFileId) {
      const kbFile = await kbService.getFileById(attachment.kbFileId);
      if (kbFile) {
        await deleteFileFromProviders(kb, kbFile);
        await kbService.deleteFile(kbFile.id);
      }
    }

    await db()
      .delete(dynamicKbAttachments)
      .where(eq(dynamicKbAttachments.id, attachment.id));

    await kbService.updateFileStats(kbId);
    console.log(`✅ [DynamicKB] Detached file ${fileId} from KB ${kbId}`);
  }

  // ── Auto-sync ────────────────────────────────────────────────────────────────

  /**
   * Sync updated content to all attached KB providers.
   * Called automatically after saveContent.
   *
   * @returns {{ synced: boolean, syncedKBs: string[], failedKBs: string[] }}
   */
  async syncAttachedKBs(fileId, buffer, fileName) {
    const { dynamicKbAttachments, knowledgeBaseFiles } = getSchema();

    const attachments = await this.getAttachments(fileId);
    if (attachments.length === 0) {
      return { synced: false, syncedKBs: [], failedKBs: [] };
    }

    const syncedKBs = [];
    const failedKBs = [];
    const mdFileName = `${fileName}.md`;
    const mimetype = 'text/markdown';

    for (const att of attachments) {
      try {
        const kb = await kbService.getKnowledgeBaseById(att.kbId);

        // Delete old file from providers
        if (att.kbFileId) {
          const oldFile = await kbService.getFileById(att.kbFileId);
          if (oldFile) await deleteFileFromProviders(kb, oldFile);
        }

        // Upload new content to providers
        const { openaiFileId, googleDocumentId, anthropicFileId } = await uploadBufferToKB(
          kb, buffer, mdFileName, mimetype
        );

        // Update knowledge_base_files record with new provider IDs
        if (att.kbFileId) {
          await db()
            .update(knowledgeBaseFiles)
            .set({
              openaiFileId: openaiFileId || null,
              googleDocumentId: googleDocumentId || null,
              anthropicFileId: anthropicFileId || null,
              fileSize: buffer.length,
              updatedAt: new Date(),
            })
            .where(eq(knowledgeBaseFiles.id, att.kbFileId));
        }

        await kbService.updateFileStats(att.kbId);
        syncedKBs.push(att.kbName);
        console.log(`✅ [DynamicKB] Synced to KB: ${att.kbName}`);
      } catch (err) {
        console.error(`❌ [DynamicKB] Sync failed for KB ${att.kbName}: ${err.message}`);
        failedKBs.push(att.kbName);
      }
    }

    return { synced: syncedKBs.length > 0, syncedKBs, failedKBs };
  }
}

module.exports = new DynamicKBService();
