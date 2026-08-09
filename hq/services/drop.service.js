/**
 * HQ — Drop.
 *
 * One entry point for "here, take this". You paste a link or some text and HQ
 * works out what it is and what to do with it. Drop is deliberately the first
 * thing built: it's the universal fallback for every connector, so nothing
 * downstream is ever on the critical path (docs/guides/LYBI_HQ.md §4).
 */

const notion = require('./notion.service');
const atomsService = require('./atoms.service');
const ingest = require('./ingest.service');

/** What kind of thing is this string? */
function classifyInput(input) {
  const value = (input || '').trim();
  if (!value) return { type: 'empty' };

  if (/notion\.(so|site)|app\.notion\.com/i.test(value) || notion.extractNotionId(value)) {
    const id = notion.extractNotionId(value);
    if (id) return { type: 'notion', id, raw: value };
  }
  if (/^https?:\/\//i.test(value)) return { type: 'url', url: value };
  return { type: 'text', text: value };
}

/**
 * Ingest a Notion page or database.
 *
 * A database link is the high-value case: one paste pulls every row, so the
 * whole meeting archive lands in a single action instead of link by link.
 *
 * @param {function} [onProgress] - called as ({ done, total, title })
 */
async function dropNotion(notionId, { kind = 'auto', onProgress = null, since = null } = {}) {
  const { type, object } = await notion.resolveObject(notionId);
  const label = notion.titleOf(object);

  // One source row per Notion object, reused across re-syncs so history and
  // atom counts stay attached to the same thing.
  let source = await atomsService.findSourceByConfigKey('notion', 'notionId', object.id);
  if (!source) {
    source = await atomsService.createSource({
      kind: 'notion',
      label,
      config: { notionId: object.id, notionType: type, url: object.url || null },
      syncMode: 'watch',
    });
  }
  await atomsService.updateSource(source.id, { lastStatus: 'syncing', lastError: null });

  try {
    const pages = type === 'database'
      ? await notion.listDatabasePages(object.id, { since })
      : [object];

    // A "Meetings" database is the expected shape, so default its rows to
    // meetings — that's what routes them to the Scribe.
    const resolvedKind = kind !== 'auto'
      ? kind
      : (type === 'database' && /meeting|סיכום|פגיש|call|session/i.test(label) ? 'meeting' : 'doc');

    const results = [];
    let done = 0;

    for (const stub of pages) {
      let doc;
      try {
        doc = await notion.fetchPage(stub.id);
      } catch (err) {
        results.push({ ok: false, title: stub.id, error: err.message });
        done++;
        continue;
      }

      const comments = await notion.fetchComments(stub.id);
      const body = comments.length
        ? `${doc.markdown}\n\n---\n\n## Comments\n\n${comments.map(c => `- ${c.text}`).join('\n')}`
        : doc.markdown;

      try {
        const { atom, skipped } = await ingest.ingestDocument({
          kind: resolvedKind,
          title: doc.title,
          body,
          externalId: doc.externalId,
          externalUrl: doc.url,
          participants: doc.people,
          projects: doc.tags,
          occurredAt: doc.occurredAt,
        }, {
          sourceId: source.id,
          // Notion pages are usually already AI-written notes with their own
          // "participants" / "action items" sections — running the Scribe over
          // one summarises a summary, at real cost (~$0.13 per 50k-char Hebrew
          // page). Ask doesn't need it either: retrieval runs over the body,
          // which is indexed regardless. Left to a per-meeting button instead.
          runScribe: false,
        });

        results.push({ ok: true, atomId: atom.id, title: atom.title, skipped });
      } catch (err) {
        results.push({ ok: false, title: doc.title, error: err.message });
      }

      done++;
      if (onProgress) onProgress({ done, total: pages.length, title: doc.title });
    }

    const ingested = results.filter(r => r.ok).length;
    await atomsService.updateSource(source.id, {
      lastStatus: 'ok',
      atomCount: ingested,
      lastSyncAt: new Date(),
    });

    return { source, type, label, total: pages.length, ingested, results };
  } catch (err) {
    await atomsService.updateSource(source.id, { lastStatus: 'failed', lastError: err.message });
    throw err;
  }
}

/** Pasted text becomes a note (or whatever kind the caller names). */
async function dropText(text, { title = null, kind = 'note', sourceUrl = null } = {}) {
  const body = (text || '').trim();
  if (!body) throw new Error('nothing to save');

  // First markdown heading, else first line, else a timestamp — a note with no
  // title is unfindable later.
  const derived = (body.match(/^#{1,3}\s+(.+)$/m)?.[1] || body.split('\n')[0] || '').trim();
  const resolvedTitle = title || (derived.length > 3 ? derived.slice(0, 200) : `Note · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);

  const source = await atomsService.createSource({
    kind: sourceUrl ? 'url' : 'text',
    label: resolvedTitle,
    config: sourceUrl ? { url: sourceUrl } : {},
  });

  const { atom } = await ingest.ingestDocument({
    kind,
    title: resolvedTitle,
    body,
    externalUrl: sourceUrl,
    occurredAt: new Date(),
  }, { sourceId: source.id, runScribe: kind === 'meeting' });

  await atomsService.updateSource(source.id, { lastStatus: 'ok', atomCount: 1, lastSyncAt: new Date() });
  return { atom };
}

module.exports = { classifyInput, dropNotion, dropText };
