const { eq, desc, sql } = require('drizzle-orm');
const { dynamicKBFiles, dynamicKBAttachments, knowledgeBases, knowledgeBaseFiles, agents } = require('../db/schema');
const dbService = require('./db.pg');
const kbService = require('./kb.service');
const storageService = require('./storage.service');
const llmService = require('./llm');
const googleKBService = require('./kb.google.service');
const anthropicKBService = require('./kb.anthropic.service');

/**
 * Dynamic KB Service
 *
 * CRUD for dynamic files, content persistence on GCS,
 * KB attachment management, and auto-sync to providers.
 */
class DynamicKBService {

  // ── Table ↔ Markdown conversion ──────────────────────────────

  /**
   * Convert table data (headers + rows) to one-row-per-block markdown.
   *
   * Heading uses col1 + col2 for uniqueness (e.g. "## הפועלים — דיגיטל בסיסי").
   * Skips first two columns from list items (already in heading).
   * Skips completely empty rows.
   */
  tableToMarkdown(name, headers, rows, indexColumns = []) {
    const now = new Date().toISOString().split('T')[0];

    // Filter out completely empty rows
    const dataRows = rows.filter(row => {
      return row.some(c => c && c.trim());
    });

    // Store ALL header names + index columns in metadata for lossless round-trip
    const lines = [
      `# ${name}`,
      `> Last updated: ${now}`,
      `> ${dataRows.length} items`,
      `> Columns: ${headers.join(' | ')}`,
    ];
    if (indexColumns.length > 0) {
      lines.push(`> Index: ${indexColumns.join(',')}`);
    }
    lines.push('');

    for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
      const row = dataRows[rowIdx];
      lines.push('---');

      // Heading: use index column values if set, otherwise "Row N"
      let heading;
      if (indexColumns.length > 0) {
        const parts = indexColumns.map(i => (row[i] || '').trim()).filter(Boolean);
        heading = parts.length > 0 ? parts.join(' — ') : `Row ${rowIdx + 1}`;
      } else {
        heading = `Row ${rowIdx + 1}`;
      }
      lines.push(`## ${heading}`);

      // ALL columns as list items (no skipping)
      for (let i = 0; i < headers.length; i++) {
        const val = (row[i] || '').trim();
        if (val) {
          lines.push(`- ${headers[i]}: ${val}`);
        }
      }
    }

    if (dataRows.length > 0) lines.push('---');
    return lines.join('\n') + '\n';
  }

  /**
   * Parse one-row-per-block markdown back to { headers, rows, indexColumns }.
   *
   * All columns are list items. Heading is ignored (it's derived from index columns or "Row N").
   */
  markdownToTable(mdString) {
    const lines = mdString.split('\n');
    const rows = [];
    let currentRow = null;

    // Extract ALL header names from metadata
    let allHeaders = [];
    let indexColumns = [];
    for (const line of lines) {
      if (line.startsWith('> Columns: ')) {
        allHeaders = line.substring(11).split(' | ');
      } else if (line.startsWith('> Index: ')) {
        indexColumns = line.substring(9).split(',').map(Number);
      }
    }

    for (const line of lines) {
      if (line.startsWith('## ')) {
        // Initialize row with empty cells for all columns
        currentRow = new Array(allHeaders.length).fill('');
      } else if (line.startsWith('- ') && currentRow !== null) {
        const item = line.substring(2);
        // Match against known headers (handles colons in header names)
        let matched = false;
        for (let i = 0; i < allHeaders.length; i++) {
          const prefix = allHeaders[i] + ': ';
          if (item.startsWith(prefix)) {
            currentRow[i] = item.substring(prefix.length);
            matched = true;
            break;
          }
        }
        // Fallback: split on first ': '
        if (!matched) {
          const colonIdx = item.indexOf(': ');
          if (colonIdx >= 0) {
            const key = item.substring(0, colonIdx);
            const value = item.substring(colonIdx + 2);
            const idx = allHeaders.indexOf(key);
            if (idx >= 0) {
              currentRow[idx] = value;
            }
          }
        }
      } else if (line === '---') {
        if (currentRow !== null) {
          rows.push(currentRow);
        }
        currentRow = null;
      }
    }
    // Flush last row
    if (currentRow !== null) {
      rows.push(currentRow);
    }

    return { headers: allHeaders, rows, indexColumns };
  }

  // ── CRUD ─────────────────────────────────────────────────────

  async createFile(agentId, name, fileType) {
    const [file] = await dbService.db
      .insert(dynamicKBFiles)
      .values({ agentId, name, fileType, metadata: {} })
      .returning();
    console.log(`✅ [DynamicKB] File created: ${file.id} (${name})`);
    return file;
  }

  async getFilesByAgent(agentId) {
    const files = await dbService.db
      .select({
        id: dynamicKBFiles.id,
        agentId: dynamicKBFiles.agentId,
        name: dynamicKBFiles.name,
        fileType: dynamicKBFiles.fileType,
        fileSize: dynamicKBFiles.fileSize,
        createdAt: dynamicKBFiles.createdAt,
        updatedAt: dynamicKBFiles.updatedAt,
        attachmentCount: sql`(SELECT COUNT(*) FROM dynamic_kb_attachments WHERE dynamic_file_id = ${dynamicKBFiles.id})::int`,
      })
      .from(dynamicKBFiles)
      .where(eq(dynamicKBFiles.agentId, agentId))
      .orderBy(desc(dynamicKBFiles.updatedAt));
    return files;
  }

  async getFileById(fileId) {
    const [file] = await dbService.db
      .select()
      .from(dynamicKBFiles)
      .where(eq(dynamicKBFiles.id, fileId))
      .limit(1);
    return file || null;
  }

  async updateFile(fileId, updates) {
    const oldFile = await this.getFileById(fileId);
    if (!oldFile) throw new Error(`Dynamic file not found: ${fileId}`);

    const setValues = { updatedAt: new Date() };
    if (updates.name !== undefined) setValues.name = updates.name;

    const [file] = await dbService.db
      .update(dynamicKBFiles)
      .set(setValues)
      .where(eq(dynamicKBFiles.id, fileId))
      .returning();

    // If name changed and file has content + attachments, re-sync to providers
    // (providers store the file with the name, so we need to delete old + upload new)
    if (updates.name && updates.name !== oldFile.name && oldFile.gcsPath) {
      const attachments = await this.getAttachments(fileId);
      if (attachments.length > 0) {
        const buffer = await storageService.downloadFile(oldFile.gcsPath);

        // Also update fileName in knowledge_base_files records
        for (const att of attachments) {
          if (att.kbFileId) {
            await dbService.db
              .update(knowledgeBaseFiles)
              .set({ fileName: `${updates.name}.md`, updatedAt: new Date() })
              .where(eq(knowledgeBaseFiles.id, att.kbFileId));
          }
        }

        // Re-sync: delete old provider files (old name) + upload new (new name)
        const syncedKBs = await this.syncAttachedKBs(fileId, buffer, updates.name);
        console.log(`✅ [DynamicKB] Rename synced to ${syncedKBs.length} KB(s)`);
      }
    }

    return file;
  }

  async deleteFile(fileId) {
    const file = await this.getFileById(fileId);
    if (!file) throw new Error(`Dynamic file not found: ${fileId}`);

    // Detach from all KBs first
    const attachments = await this.getAttachments(fileId);
    for (const att of attachments) {
      try {
        await this.detachFromKB(fileId, att.kbId);
      } catch (err) {
        console.warn(`⚠️ [DynamicKB] Could not detach from KB ${att.kbId}: ${err.message}`);
      }
    }

    // Delete from GCS
    if (file.gcsPath) {
      try {
        await storageService.deleteFile(file.gcsPath);
      } catch (err) {
        console.warn(`⚠️ [DynamicKB] Could not delete GCS file: ${err.message}`);
      }
    }

    // Delete from DB
    await dbService.db.delete(dynamicKBFiles).where(eq(dynamicKBFiles.id, fileId));
    console.log(`✅ [DynamicKB] File deleted: ${fileId}`);
    return true;
  }

  async getAgentByName(agentName) {
    const [agent] = await dbService.db
      .select()
      .from(agents)
      .where(eq(agents.name, agentName))
      .limit(1);
    if (!agent) throw new Error(`Agent not found: ${agentName}`);
    return agent;
  }

  // ── Content operations ───────────────────────────────────────

  async saveContent(fileId, content) {
    const file = await this.getFileById(fileId);
    if (!file) throw new Error(`Dynamic file not found: ${fileId}`);

    // Convert table data to markdown if table type
    let mdContent;
    if (file.fileType === 'table') {
      const { headers, rows, indexColumns } = typeof content === 'string' ? JSON.parse(content) : content;
      mdContent = this.tableToMarkdown(file.name, headers, rows, indexColumns || []);
    } else {
      mdContent = content;
    }

    const buffer = Buffer.from(mdContent, 'utf-8');
    const gcsPath = `dynamic-files/${file.agentId}/${file.id}.md`;

    // Upload to GCS (overwrite)
    const bucket = storageService.getBucket();
    const gcsFile = bucket.file(gcsPath);
    await gcsFile.save(buffer, {
      metadata: { contentType: 'text/markdown' },
    });

    // Update DB
    await dbService.db
      .update(dynamicKBFiles)
      .set({ gcsPath, fileSize: buffer.length, updatedAt: new Date() })
      .where(eq(dynamicKBFiles.id, fileId));

    console.log(`✅ [DynamicKB] Content saved: ${gcsPath} (${buffer.length} bytes)`);

    // Auto-sync to attached KBs
    const syncedKBs = await this.syncAttachedKBs(fileId, buffer, file.name);

    return { synced: syncedKBs.length > 0, syncedKBs };
  }

  async loadContent(fileId) {
    const file = await this.getFileById(fileId);
    if (!file) throw new Error(`Dynamic file not found: ${fileId}`);

    if (!file.gcsPath) {
      // No content yet
      return file.fileType === 'table' ? { headers: [], rows: [] } : '';
    }

    const buffer = await storageService.downloadFile(file.gcsPath);
    const mdContent = buffer.toString('utf-8');

    if (file.fileType === 'table') {
      return this.markdownToTable(mdContent);
    }
    return mdContent;
  }

  // ── Attachment operations ────────────────────────────────────

  async getAttachments(dynamicFileId) {
    const rows = await dbService.db
      .select({
        id: dynamicKBAttachments.id,
        kbId: dynamicKBAttachments.knowledgeBaseId,
        kbFileId: dynamicKBAttachments.kbFileId,
        kbName: knowledgeBases.name,
        kbProvider: knowledgeBases.providers,
      })
      .from(dynamicKBAttachments)
      .innerJoin(knowledgeBases, eq(dynamicKBAttachments.knowledgeBaseId, knowledgeBases.id))
      .where(eq(dynamicKBAttachments.dynamicFileId, dynamicFileId));
    return rows;
  }

  async attachToKB(dynamicFileId, knowledgeBaseId) {
    const file = await this.getFileById(dynamicFileId);
    if (!file) throw new Error(`Dynamic file not found: ${dynamicFileId}`);

    const kb = await kbService.getKnowledgeBaseById(knowledgeBaseId);

    // Check if attachment already exists (e.g. stale record from manual provider cleanup)
    const [existingAttachment] = await dbService.db
      .select()
      .from(dynamicKBAttachments)
      .where(
        sql`${dynamicKBAttachments.dynamicFileId} = ${dynamicFileId} AND ${dynamicKBAttachments.knowledgeBaseId} = ${knowledgeBaseId}`
      )
      .limit(1);

    // Load content from GCS
    if (!file.gcsPath) throw new Error('File has no content yet — save it first');
    const buffer = await storageService.downloadFile(file.gcsPath);
    const fileName = `${file.name}.md`;
    const mimetype = 'text/markdown';

    // Upload to provider(s)
    let openaiFileId = null;
    let googleDocumentId = null;
    let anthropicFileId = null;

    const { hasProvider } = require('./kb.helpers');
    if (hasProvider(kb, 'openai')) {
      const result = await llmService.addFileToVectorStore(buffer, fileName, kb.vectorStoreId);
      openaiFileId = result.fileId;
      console.log(`✅ [DynamicKB] Uploaded to OpenAI: ${openaiFileId}`);
    }

    if (hasProvider(kb, 'google')) {
      const result = await googleKBService.uploadFile(kb.googleCorpusId, buffer, fileName, mimetype);
      googleDocumentId = result.documentId;
      console.log(`✅ [DynamicKB] Uploaded to Google: ${googleDocumentId}`);
    }

    if (hasProvider(kb, 'anthropic')) {
      const result = await anthropicKBService.uploadFile(buffer, fileName, mimetype);
      anthropicFileId = result.fileId;
      console.log(`✅ [DynamicKB] Uploaded to Anthropic: ${anthropicFileId}`);
    }

    // Save to knowledge_base_files
    const kbFile = await kbService.addFile(
      knowledgeBaseId,
      fileName,
      buffer.length,
      'md',
      { openaiFileId, googleDocumentId, anthropicFileId },
      ['dynamic-kb'],
      'completed'
    );

    if (existingAttachment) {
      // Update existing attachment with new kb_file_id
      await dbService.db
        .update(dynamicKBAttachments)
        .set({ kbFileId: kbFile.id })
        .where(eq(dynamicKBAttachments.id, existingAttachment.id));
      console.log(`✅ [DynamicKB] Re-attached file ${dynamicFileId} to KB ${knowledgeBaseId} (updated existing)`);
    } else {
      // Create new attachment record
      await dbService.db
        .insert(dynamicKBAttachments)
        .values({ dynamicFileId, knowledgeBaseId, kbFileId: kbFile.id });
      console.log(`✅ [DynamicKB] Attached file ${dynamicFileId} to KB ${knowledgeBaseId}`);
    }

    return kbFile;
  }

  async detachFromKB(dynamicFileId, knowledgeBaseId) {
    // Find the attachment
    const [attachment] = await dbService.db
      .select()
      .from(dynamicKBAttachments)
      .where(
        sql`${dynamicKBAttachments.dynamicFileId} = ${dynamicFileId} AND ${dynamicKBAttachments.knowledgeBaseId} = ${knowledgeBaseId}`
      )
      .limit(1);

    if (!attachment) throw new Error('Attachment not found');

    // Delete the file from providers via the kb_file_id
    if (attachment.kbFileId) {
      const kbFile = await kbService.getFileById(attachment.kbFileId);
      if (kbFile) {
        const kb = await kbService.getKnowledgeBaseById(knowledgeBaseId);

        if (kbFile.openaiFileId && kb.vectorStoreId) {
          try { await llmService.deleteVectorStoreFile(kb.vectorStoreId, kbFile.openaiFileId); }
          catch (err) { console.warn(`⚠️ Could not delete from OpenAI: ${err.message}`); }
        }
        if (kbFile.googleDocumentId) {
          try { await googleKBService.deleteDocument(kbFile.googleDocumentId); }
          catch (err) { console.warn(`⚠️ Could not delete from Google: ${err.message}`); }
        }
        if (kbFile.anthropicFileId) {
          try { await anthropicKBService.deleteFile(kbFile.anthropicFileId); }
          catch (err) { console.warn(`⚠️ Could not delete from Anthropic: ${err.message}`); }
        }

        await kbService.deleteFile(kbFile.id);
      }
    }

    // Delete attachment record
    await dbService.db
      .delete(dynamicKBAttachments)
      .where(eq(dynamicKBAttachments.id, attachment.id));

    console.log(`✅ [DynamicKB] Detached file ${dynamicFileId} from KB ${knowledgeBaseId}`);
    return true;
  }

  // ── Auto-sync ────────────────────────────────────────────────

  /**
   * Re-sync a dynamic file to all attached KBs.
   * Called after saveContent when file has attachments.
   * Flow: delete old provider file → upload new content → update DB.
   */
  async syncAttachedKBs(dynamicFileId, buffer, fileName) {
    const attachments = await this.getAttachments(dynamicFileId);
    if (attachments.length === 0) return [];

    const syncedKBs = [];
    const mdFileName = `${fileName}.md`;
    const mimetype = 'text/markdown';

    for (const att of attachments) {
      try {
        const kb = await kbService.getKnowledgeBaseById(att.kbId);
        const oldFile = att.kbFileId ? await kbService.getFileById(att.kbFileId) : null;

        // Delete old from providers
        if (oldFile) {
          if (oldFile.openaiFileId && kb.vectorStoreId) {
            try { await llmService.deleteVectorStoreFile(kb.vectorStoreId, oldFile.openaiFileId); }
            catch (err) { console.warn(`⚠️ [Sync] OpenAI delete failed: ${err.message}`); }
          }
          if (oldFile.googleDocumentId) {
            try { await googleKBService.deleteDocument(oldFile.googleDocumentId); }
            catch (err) { console.warn(`⚠️ [Sync] Google delete failed: ${err.message}`); }
          }
          if (oldFile.anthropicFileId) {
            try { await anthropicKBService.deleteFile(oldFile.anthropicFileId); }
            catch (err) { console.warn(`⚠️ [Sync] Anthropic delete failed: ${err.message}`); }
          }
        }

        // Upload new content to providers
        let openaiFileId = null;
        let googleDocumentId = null;
        let anthropicFileId = null;

        const { hasProvider } = require('./kb.helpers');
    if (hasProvider(kb, 'openai')) {
          const result = await llmService.addFileToVectorStore(buffer, mdFileName, kb.vectorStoreId);
          openaiFileId = result.fileId;
        }
        if (hasProvider(kb, 'google')) {
          const result = await googleKBService.uploadFile(kb.googleCorpusId, buffer, mdFileName, mimetype);
          googleDocumentId = result.documentId;
        }
        if (hasProvider(kb, 'anthropic')) {
          const result = await anthropicKBService.uploadFile(buffer, mdFileName, mimetype);
          anthropicFileId = result.fileId;
        }

        // Update or create kb_file record
        if (oldFile) {
          await kbService.updateFileProviderIds(oldFile.id, {
            openaiFileId,
            googleDocumentId,
            status: 'completed',
          });
          // anthropicFileId not in updateFileProviderIds — update directly if needed
          if (anthropicFileId) {
            await dbService.db
              .update(knowledgeBaseFiles)
              .set({ anthropicFileId, updatedAt: new Date() })
              .where(eq(knowledgeBaseFiles.id, oldFile.id));
          }
        } else {
          // Edge case: attachment exists but kb_file was deleted — recreate
          const kbFile = await kbService.addFile(
            att.kbId, mdFileName, buffer.length, 'md',
            { openaiFileId, googleDocumentId, anthropicFileId },
            ['dynamic-kb'], 'completed'
          );
          await dbService.db
            .update(dynamicKBAttachments)
            .set({ kbFileId: kbFile.id })
            .where(eq(dynamicKBAttachments.id, att.id));
        }

        await kbService.updateFileStats(att.kbId);
        syncedKBs.push(att.kbName);
        console.log(`✅ [DynamicKB] Synced to KB: ${att.kbName}`);
      } catch (err) {
        console.error(`❌ [DynamicKB] Failed to sync to KB ${att.kbName}: ${err.message}`);
      }
    }

    return syncedKBs;
  }
}

module.exports = new DynamicKBService();
