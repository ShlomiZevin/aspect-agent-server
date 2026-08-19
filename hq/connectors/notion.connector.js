/**
 * Notion connector. See ./README.md for the interface.
 *
 * Everything Notion-specific lives here or in ../services/notion.service.js;
 * the sync engine never imports either.
 */

const notion = require('../services/notion.service');

module.exports = {
  id: 'notion',
  name: 'Notion',
  label: 'Notion workspace',
  defaultKind: 'doc',

  isConfigured: () => notion.isConfigured(),

  /**
   * Notion's search sorts by last edited time, so a watermark lets us stop
   * paginating at the first item older than it — one request instead of nine
   * when nothing has changed.
   */
  async list({ since = null } = {}, onProgress = null) {
    const { objects, reachedEnd } = await notion.listAllAccessible(
      p => onProgress?.(p), { since },
    );

    // Databases are containers, not content — but their titles name the
    // section every row below them belongs to, so keep them for the lookup.
    const nameById = new Map(objects.map(o => [o.id, notion.titleOf(o) || '']));

    const items = objects
      .filter(o => o.object === 'page')
      .map(page => {
        const p = page.parent || {};
        const parentTitle =
          p.type === 'database_id' ? nameById.get(p.database_id) || null
          : p.type === 'page_id'   ? nameById.get(p.page_id) || null
          : p.type === 'workspace' ? 'Workspace'
          : null;

        return {
          externalId: page.id,
          title: notion.titleOf(page) || '(untitled)',
          url: page.url || null,
          parentTitle,
          objectType: p.type === 'database_id' ? 'database_row' : 'page',
          mimeType: null,   // Notion has one content format; nothing to record.
          editedAt: page.last_edited_time || null,
        };
      });

    return { items, reachedEnd };
  },

  async fetch(item) {
    const doc = await notion.fetchPage(item.external_id);
    const comments = await notion.fetchComments(item.external_id);
    const body = comments.length
      ? `${doc.markdown}\n\n---\n\n## Comments\n\n${comments.map(c => `- ${c.text}`).join('\n')}`
      : doc.markdown;

    return {
      title: doc.title,
      body,
      externalId: doc.externalId,
      url: doc.url,
      people: doc.people,
      tags: doc.tags,
      occurredAt: doc.occurredAt,
    };
  },
};
