/**
 * Text an outside assistant writes ⇄ the HTML the LYBI board stores (#931).
 *
 * Assistants (Codex, Claude, ChatGPT) write task descriptions in Markdown
 * whatever they are told. The board's editor renders HTML, so the text has to
 * be converted on the way in, or it lands as one paragraph of literal
 * asterisks and hashes.
 *
 * Only the small Markdown subset assistants actually produce is handled:
 * headings, bullet and numbered lists, bold, italic, inline code, fenced code
 * and links. Everything else is escaped, so a placeholder like `<messageId>`
 * shows as written instead of vanishing as an unknown tag.
 */

/**
 * Tags the board's own editor produces. Text is taken as finished HTML only
 * when it contains one of these. A looser "anything tag-shaped" test treated
 * a `<messageId>` placeholder as HTML, stored the text raw, and the board
 * collapsed all of its lines into one block.
 */
const BOARD_TAG = /<\/?(p|br|ul|ol|li|b|strong|i|em|u|s|h[1-6]|code|pre|div|span|a|img|blockquote|table|tr|td|th)(\s[^>]*)?\/?>/i;

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline Markdown on one already-split line: code first, so its contents stay literal. */
function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*```/;

/** Markdown or plain text in, the board's HTML out. Finished HTML passes through. */
function textToBoardHtml(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').trim();
  // Code is quoted, not markup: a `<b>` inside it doesn't make the text HTML.
  const prose = src.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '');
  if (!src || BOARD_TAG.test(prose)) return src;

  const lines = src.split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }

    if (FENCE.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !FENCE.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      flush();
      // The board's description styles h3 and below; bigger headings shout.
      out.push(`<h${Math.max(3, h[1].length)}>${inline(h[2])}</h${Math.max(3, h[1].length)}>`);
      continue;
    }

    const list = BULLET.test(line) ? [BULLET, 'ul'] : NUMBERED.test(line) ? [NUMBERED, 'ol'] : null;
    if (list) {
      const [re, tag] = list;
      flush();
      const items = [];
      for (; i < lines.length && re.test(lines[i]); i++) {
        let item = lines[i].match(re)[1];
        // An indented line straight after an item continues it.
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !BULLET.test(lines[i + 1]) && !NUMBERED.test(lines[i + 1])) {
          item += ' ' + lines[++i].trim();
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      i--;
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    para.push(line.trim());
  }
  flush();
  return out.join('');
}

/** Board HTML in, readable text out — lists and headings keep their shape. */
function boardHtmlToText(html) {
  return String(html || '')
    .replace(/<h[1-6][^>]*>/gi, '\n### ').replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ').replace(/<\/li>/gi, '\n')
    .replace(/<\/?(b|strong)>/gi, '**')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|ul|ol|pre)>/gi, '\n\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { textToBoardHtml, boardHtmlToText };
