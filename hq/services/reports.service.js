/**
 * HQ — reports. A worker presenting work, rather than describing it in chat.
 *
 * Ten creative options are unreviewable as chat messages. A page showing each
 * one with its reasoning is how a decision actually gets made — that's what the
 * Matzav campaign's REPORT.html was for, and it's the format worth stealing.
 *
 * Images are referenced as {{media:ID}} and resolved at VIEW time, never
 * stored as URLs: ours are signed and expire within hours, so a baked-in link
 * makes a report that looks right today and is broken images next week.
 */

const db = require('../../services/db.pg');
const media = require('./media.service');

const BRAND = {
  mag: '#E0198A', pur: '#5B1E8A', pur2: '#9A2295', ink: '#0A0420',
};

async function create({ workerId = null, conversationId = null, jobId = null, title, summary = null, html }) {
  const { rows } = await db.query(
    `INSERT INTO hq_reports (worker_id, conversation_id, job_id, title, summary, html)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, created_at`,
    [workerId, conversationId, jobId, title, summary, html]
  );
  return rows[0];
}

async function get(id) {
  const { rows } = await db.query(
    `SELECT r.*, w.name AS worker_name, w.avatar
       FROM hq_reports r LEFT JOIN hq_workers w ON w.id = r.worker_id
      WHERE r.id = $1`, [id]);
  return rows[0] || null;
}

async function list({ conversationId = null, limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT r.id, r.title, r.summary, r.created_at, r.conversation_id, r.job_id,
            w.name AS worker_name, w.avatar
       FROM hq_reports r LEFT JOIN hq_workers w ON w.id = r.worker_id
      WHERE ($1::int IS NULL OR r.conversation_id = $1)
      ORDER BY r.created_at DESC LIMIT $2`, [conversationId, limit]);
  return rows;
}

/**
 * Swap every {{media:ID}} for a fresh signed URL.
 *
 * Done on every view rather than once at save. An id that no longer exists
 * becomes a visible placeholder instead of a broken image — a report that
 * silently drops a picture is worse than one that says a picture is missing.
 */
async function resolveMedia(html) {
  const ids = [...new Set([...html.matchAll(/\{\{media:(\d+)\}\}/g)].map(m => Number(m[1])))];
  if (!ids.length) return html;

  const { rows } = await db.query(
    `SELECT id, gcs_path, title FROM hq_media WHERE id = ANY($1::int[])`, [ids]);
  const urls = new Map();
  for (const row of rows) {
    try { urls.set(row.id, await media.signedUrl(row.gcs_path)); } catch { /* leave it missing */ }
  }

  return html.replace(/\{\{media:(\d+)\}\}/g,
    (_, id) => urls.get(Number(id)) || 'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="#eee"/><text x="50%" y="50%" text-anchor="middle" fill="#999" font-family="sans-serif">image no longer available</text></svg>'));
}

/**
 * Wrap the worker's body HTML in the Lybi shell.
 *
 * The worker writes content, not chrome — it shouldn't be spending tokens
 * re-deriving a page header, and every report looking the same is the point
 * when you're comparing two of them.
 */
async function render(report) {
  const body = await resolveMedia(report.html);
  const when = new Date(report.created_at).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  return `<!doctype html>
<html lang="he" dir="auto"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title)} — Lybi HQ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  :root {
    --mag:${BRAND.mag}; --pur:${BRAND.pur}; --pur2:${BRAND.pur2}; --ink:${BRAND.ink};
    --grad: linear-gradient(135deg, ${BRAND.mag} 0%, ${BRAND.pur2} 50%, ${BRAND.pur} 100%);
    --bg:#FAFAFF; --surface:#fff; --text:#1A0A38; --text-2:#5B4B7A; --text-3:#8B7BA8;
    --border:#E0D6EF;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0A0420; --surface:rgba(255,255,255,.04); --text:#F2ECFA;
            --text-2:#BFB0D8; --text-3:#8B7BA8; --border:rgba(255,255,255,.10); }
  }
  * { box-sizing:border-box; margin:0; padding:0 }
  body { background:var(--bg); color:var(--text); font-family:'Assistant',system-ui,Arial,sans-serif;
         line-height:1.65; padding:0 0 80px }
  .top { background:var(--grad); color:#fff; padding:38px 24px }
  .topInner { max-width:1080px; margin:0 auto }
  .eyebrow { font-size:11px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; opacity:.85 }
  h1 { font-size:34px; font-weight:800; letter-spacing:-.4px; margin:8px 0 6px }
  .meta { font-size:13.5px; opacity:.85 }
  .wrap { max-width:1080px; margin:0 auto; padding:32px 24px }
  h2 { font-size:22px; font-weight:800; margin:34px 0 12px }
  h3 { font-size:16px; font-weight:700; margin:22px 0 8px }
  p { color:var(--text-2); margin:10px 0 }
  ul,ol { color:var(--text-2); margin:10px 0; padding-inline-start:22px }
  li { margin:5px 0 }
  img { max-width:100%; border-radius:12px; display:block; border:1px solid var(--border) }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:18px; margin:18px 0 }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:14px;
          overflow:hidden; display:flex; flex-direction:column }
  .card img { border:0; border-radius:0 }
  .card .body { padding:14px 16px }
  .card h3 { margin:0 0 6px; font-size:15px }
  .card p { font-size:13.5px; margin:4px 0 }
  table { width:100%; border-collapse:collapse; margin:16px 0; font-size:14px }
  th,td { text-align:start; padding:9px 12px; border-bottom:1px solid var(--border) }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.8px; color:var(--text-3) }
  blockquote { border-inline-start:3px solid var(--mag); padding-inline-start:14px; color:var(--text-2); margin:14px 0 }
  code { font-family:ui-monospace,monospace; font-size:13px; background:var(--surface);
         border:1px solid var(--border); border-radius:5px; padding:1px 6px }
  .foot { max-width:1080px; margin:40px auto 0; padding:18px 24px 0; border-top:1px solid var(--border);
          font-size:12.5px; color:var(--text-3) }
</style>
</head><body>
  <header class="top"><div class="topInner">
    <div class="eyebrow">Lybi HQ${report.worker_name ? ` · ${escapeHtml(report.worker_name)}` : ''}</div>
    <h1>${escapeHtml(report.title)}</h1>
    <div class="meta">${when}${report.summary ? ` · ${escapeHtml(report.summary)}` : ''}</div>
  </div></header>
  <main class="wrap">${body}</main>
  <div class="foot">Made in Lybi HQ. Images are stored in HQ Media and re-linked each time this page loads.</div>
</body></html>`;
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { create, get, list, render, resolveMedia };
