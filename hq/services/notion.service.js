/**
 * HQ — Notion connector.
 *
 * Deliberately dependency-free: the Notion REST API is simple enough that
 * plain fetch beats pulling in `@notionhq/client` + `notion-to-md` (the latter
 * is thinly maintained — see docs/guides/LYBI_HQ.md §4). We convert only the
 * block types that actually show up in our pages, and fall back to plain text
 * for anything unknown rather than dropping it.
 *
 * Auth: one internal integration token for the whole workspace (NOTION_TOKEN).
 * The token is workspace-wide but Notion access is opt-in per page tree — a
 * page is only visible if it (or an ancestor) has been shared with the
 * integration. "Connected nothing" is the usual cause of an empty result.
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Notion rate-limits at ~3 requests/second. We pace slightly under that;
// a few hundred pages then costs ~10-15 minutes, which is fine for a backfill.
const REQUEST_INTERVAL_MS = 350;
let lastRequestAt = 0;

function getToken() {
  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (!token) {
    throw new Error(
      'NOTION_TOKEN not set. Create an internal integration at notion.so → Settings → ' +
      'Connections → Develop or manage integrations, then share your pages with it.'
    );
  }
  return token;
}

function isConfigured() {
  return !!(process.env.NOTION_TOKEN || process.env.NOTION_API_KEY);
}

async function pace() {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function notionFetch(pathname, { method = 'GET', body } = {}) {
  await pace();

  const res = await fetch(`${NOTION_API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch { /* keep raw */ }

    let message;
    if (res.status === 401) {
      message = 'Notion rejected the token (401). Check NOTION_TOKEN.';
    } else if (res.status === 404) {
      message =
        'Notion returned 404. The page exists but is not shared with the integration — ' +
        'open it in Notion → ⋯ → Connections → add your integration (this cascades to children).';
    } else if (res.status === 429) {
      message = 'Notion rate limit hit (429). Retry in a moment.';
    } else {
      message = `Notion API ${res.status}: ${detail}`;
    }

    // Callers branch on the status code, not on the prose — matching messages
    // with a regex is how the page-vs-database probe below broke.
    const err = new Error(message);
    err.status = res.status;
    err.notionMessage = detail;
    throw err;
  }

  return res.json();
}

// ─── URL / ID handling ───────────────────────────────────────────────────────

/**
 * Pull the 32-char object id out of any Notion URL (or accept a bare id).
 * Handles: notion.so/Title-<id>, notion.so/<workspace>/<id>?v=<viewId>,
 * dashed uuids, and ?p=<id> popup links.
 */
function extractNotionId(input) {
  if (!input) return null;
  const raw = String(input).trim();

  // A bare id, dashed or not.
  const bare = raw.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(bare)) return dashify(bare);

  // `?p=` wins when present: on a popup link the path id is the *parent*
  // database and `p` is the page you actually clicked.
  const pParam = raw.match(/[?&]p=([0-9a-f]{32})/i);
  if (pParam) return dashify(pParam[1]);

  // Otherwise take the last 32-hex run in the path (before any query string),
  // which is the object the URL points at.
  const path = raw.split('?')[0];
  const matches = path.match(/[0-9a-f]{32}/gi);
  if (matches && matches.length) return dashify(matches[matches.length - 1]);

  return null;
}

function dashify(id32) {
  const s = id32.replace(/-/g, '').toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * Ask Notion what an id actually is. A pasted link doesn't say whether it points
 * at a page or a database, so we probe the database endpoint and fall back.
 *
 * The fallback must accept **400 as well as 404**: fetching a page id from
 * `/databases/{id}` returns `400 — "Provided ID … is a page, not a database"`,
 * not a 404. An earlier version only caught 404, so pasting an ordinary page
 * link failed outright instead of falling through to the page endpoint.
 *
 * @returns {Promise<{ type: 'database'|'page', object: Object }>}
 */
async function resolveObject(id) {
  let databaseErr;
  try {
    const database = await notionFetch(`/databases/${id}`);
    return { type: 'database', object: database };
  } catch (err) {
    // 400 = wrong object type, 404 = not a database (or not shared). Both mean
    // "try it as a page". Anything else (401, 429, 5xx) is a real failure.
    if (err.status !== 400 && err.status !== 404) throw err;
    databaseErr = err;
  }

  try {
    const page = await notionFetch(`/pages/${id}`);
    return { type: 'page', object: page };
  } catch (err) {
    // Neither worked. A 404 on both almost always means "not shared with the
    // integration" — surface that rather than the database probe's noise.
    if (err.status === 404 || databaseErr?.status === 404) {
      throw new Error(
        `Notion can't see ${id}. Open it in Notion → ⋯ → Connections → add the ` +
        `Lybi HQ integration (it cascades to child pages), then try again.`
      );
    }
    throw err;
  }
}

// ─── Property helpers ────────────────────────────────────────────────────────

function plainFromRichText(rich = []) {
  return rich.map(t => t.plain_text || '').join('');
}

/** Title of a page or database, whatever the title property is called. */
function titleOf(obj) {
  if (obj.object === 'database') {
    return plainFromRichText(obj.title) || 'Untitled database';
  }
  const props = obj.properties || {};
  for (const value of Object.values(props)) {
    if (value?.type === 'title') {
      const t = plainFromRichText(value.title);
      if (t) return t;
    }
  }
  return 'Untitled';
}

/**
 * Flatten a page's properties into something useful: a date for `occurred_at`,
 * people for participants, and select/multi-select values as tags.
 */
function readProperties(page) {
  const out = { date: null, people: [], tags: [], fields: {} };
  const props = page.properties || {};

  for (const [name, value] of Object.entries(props)) {
    if (!value || !value.type) continue;

    switch (value.type) {
      case 'date':
        if (value.date?.start && !out.date) out.date = value.date.start;
        out.fields[name] = value.date?.start || null;
        break;
      case 'people': {
        const names = (value.people || []).map(p => p.name).filter(Boolean);
        out.people.push(...names);
        out.fields[name] = names;
        break;
      }
      case 'select':
        if (value.select?.name) { out.tags.push(value.select.name); out.fields[name] = value.select.name; }
        break;
      case 'multi_select': {
        const names = (value.multi_select || []).map(s => s.name);
        out.tags.push(...names);
        out.fields[name] = names;
        break;
      }
      case 'rich_text':
        out.fields[name] = plainFromRichText(value.rich_text);
        break;
      case 'title':
        out.fields[name] = plainFromRichText(value.title);
        break;
      case 'number':  out.fields[name] = value.number; break;
      case 'checkbox':out.fields[name] = value.checkbox; break;
      case 'url':     out.fields[name] = value.url; break;
      case 'email':   out.fields[name] = value.email; break;
      case 'status':  if (value.status?.name) out.fields[name] = value.status.name; break;
      default: break;
    }
  }

  // created_time is the fallback "when did this happen" when no date property
  // exists — better than nothing for ordering a timeline.
  if (!out.date && page.created_time) out.date = page.created_time;
  return out;
}

// ─── Blocks → markdown ───────────────────────────────────────────────────────

function richToMarkdown(rich = []) {
  return rich.map(t => {
    let text = t.plain_text || '';
    if (!text) return '';
    const a = t.annotations || {};
    if (a.code) text = `\`${text}\``;
    if (a.bold) text = `**${text}**`;
    if (a.italic) text = `*${text}*`;
    if (a.strikethrough) text = `~~${text}~~`;
    if (t.href) text = `[${text}](${t.href})`;
    return text;
  }).join('');
}

/** Fetch every child block of a block/page, following pagination. */
async function fetchChildren(blockId) {
  const blocks = [];
  let cursor;

  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const res = await notionFetch(`/blocks/${blockId}/children${qs}`);
    blocks.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return blocks;
}

/**
 * Recursively render a block tree as markdown.
 * Unknown block types degrade to their plain text rather than vanishing —
 * losing content silently is much worse than losing formatting.
 */
async function blocksToMarkdown(blockId, depth = 0) {
  if (depth > 6) return ''; // pathological nesting guard

  const blocks = await fetchChildren(blockId);
  const lines = [];
  let numberedIndex = 0;

  for (const block of blocks) {
    const type = block.type;
    const data = block[type] || {};
    const indent = '  '.repeat(depth);
    const text = richToMarkdown(data.rich_text || []);

    if (type !== 'numbered_list_item') numberedIndex = 0;

    switch (type) {
      case 'paragraph':         lines.push(text ? `${indent}${text}` : ''); break;
      case 'heading_1':         lines.push(`\n${indent}# ${text}`); break;
      case 'heading_2':         lines.push(`\n${indent}## ${text}`); break;
      case 'heading_3':         lines.push(`\n${indent}### ${text}`); break;
      case 'bulleted_list_item':lines.push(`${indent}- ${text}`); break;
      case 'numbered_list_item':lines.push(`${indent}${++numberedIndex}. ${text}`); break;
      case 'to_do':
        lines.push(`${indent}- [${data.checked ? 'x' : ' '}] ${text}`); break;
      case 'toggle':            lines.push(`${indent}- ${text}`); break;
      case 'quote':             lines.push(`${indent}> ${text}`); break;
      case 'callout':           lines.push(`${indent}> ${data.icon?.emoji || 'ℹ️'} ${text}`); break;
      case 'code':
        lines.push(`${indent}\`\`\`${data.language || ''}\n${text}\n${indent}\`\`\``); break;
      case 'divider':           lines.push(`${indent}---`); break;
      case 'child_page':        lines.push(`${indent}- 📄 ${data.title || 'Untitled'}`); break;
      case 'child_database':    lines.push(`${indent}- 🗂 ${data.title || 'Untitled database'}`); break;
      case 'bookmark':
      case 'embed':
      case 'link_preview':      if (data.url) lines.push(`${indent}[${data.url}](${data.url})`); break;
      case 'image': {
        const url = data.file?.url || data.external?.url;
        const caption = richToMarkdown(data.caption || []) || 'image';
        if (url) lines.push(`${indent}![${caption}](${url})`);
        break;
      }
      case 'table':
      case 'table_row':
        // Rendered via the generic cell path below.
        if (data.cells) {
          lines.push(`${indent}| ${data.cells.map(c => richToMarkdown(c)).join(' | ')} |`);
        }
        break;
      case 'unsupported':       break;
      default:
        if (text) lines.push(`${indent}${text}`);
        break;
    }

    // Recurse into anything with children (toggles, nested lists, table rows).
    if (block.has_children && type !== 'child_page' && type !== 'child_database') {
      const nested = await blocksToMarkdown(block.id, depth + 1);
      if (nested.trim()) lines.push(nested);
    }
  }

  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch one Notion page as a normalised document.
 * @returns {Promise<{ externalId, title, markdown, url, occurredAt, people, tags, fields }>}
 */
async function fetchPage(pageId) {
  const page = await notionFetch(`/pages/${pageId}`);
  const props = readProperties(page);
  const markdown = await blocksToMarkdown(page.id);

  return {
    externalId: page.id,
    title: titleOf(page),
    markdown,
    url: page.url,
    occurredAt: props.date,
    people: [...new Set(props.people)],
    tags: [...new Set(props.tags)],
    fields: props.fields,
    lastEditedAt: page.last_edited_time || null,
  };
}

/**
 * List every row of a database (paginated), newest first where a date exists.
 * Returns page stubs — call fetchPage for each to get the body.
 */
async function listDatabasePages(databaseId, { pageSize = 100, since = null } = {}) {
  const pages = [];
  let cursor;

  do {
    const body = { page_size: pageSize };
    if (cursor) body.start_cursor = cursor;
    if (since) {
      body.filter = { timestamp: 'last_edited_time', last_edited_time: { after: since } };
    }

    const res = await notionFetch(`/databases/${databaseId}/query`, { method: 'POST', body });
    pages.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return pages;
}

/** Comments on a page. Needs the "read comments" capability on the integration. */
async function fetchComments(pageId) {
  try {
    const res = await notionFetch(`/comments?block_id=${pageId}`);
    return (res.results || []).map(c => ({
      text: plainFromRichText(c.rich_text),
      createdAt: c.created_time,
    })).filter(c => c.text);
  } catch {
    // Capability not granted, or none exist. Not worth failing an ingest over.
    return [];
  }
}

module.exports = {
  isConfigured,
  extractNotionId,
  resolveObject,
  fetchPage,
  listDatabasePages,
  fetchComments,
  titleOf,
  readProperties,
  blocksToMarkdown,
};
