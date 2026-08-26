/**
 * HQ — putting a worker's files in front of her.
 *
 * This is the whole point of the feature. The HQ library is something she may
 * search; these are things she cannot avoid seeing. So they are injected as a
 * real first exchange in the conversation rather than described in the system
 * prompt: a document block is the file itself, and a system prompt can only ever
 * be a summary of one.
 *
 * Shape of the injected pair:
 *   user      → [labelled document/image/text blocks] + "these are your standing
 *                materials, here is how to treat them"
 *   assistant → a short acknowledgement
 *
 * The pair sits at the FRONT of the message list, before real history, so it
 * reads as the briefing she was given when she started rather than as something
 * said mid-conversation.
 */

const files = require('./worker-files.service');
const media = require('./media.service');

/** Trimmed so one long document cannot crowd out the conversation itself. */
const MAX_TEXT_CHARS = 40_000;

function describe(file) {
  const scope = file.conversation_id ? 'for this conversation' : 'standing';
  const label = file.label || file.filename;
  return `${label} (${file.filename}, ${scope})`;
}

/**
 * Build the briefing exchange, or null when there is nothing to brief.
 *
 * Returns the blocks plus a plain-text digest: the voice model cannot read
 * document blocks, so anything it must be accurate to has to reach it as prose
 * via the brief Claude writes.
 */
async function briefing({ workerId, conversationId = null, workerName = 'You' } = {}) {
  const rows = await files.forContext({ workerId, conversationId });
  if (!rows.length) return null;

  const blocks = [];
  const digest = [];

  for (const file of rows) {
    const title = describe(file);

    // A bare block is a file with no instruction attached. Naming it first is
    // what turns "here is a PDF" into "this is the brand guide, follow it".
    blocks.push({ type: 'text', text: `--- ${title} ---` });

    if (file.anthropic_file_id) {
      // The real document: she sees pages and layout, not flattened text.
      blocks.push({
        type: 'document',
        source: { type: 'file', file_id: file.anthropic_file_id },
      });
    } else if (String(file.mime_type).startsWith('image/')) {
      // The actual picture. This used to be a text placeholder saying an image
      // existed, which meant a brand sheet with rules written ON it was
      // unreadable — she was told it was there and never shown it, so of course
      // she did not follow it.
      try {
        const bytes = await media.download(file.gcs_path);
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: file.mime_type === 'image/jpg' ? 'image/jpeg' : file.mime_type,
            data: bytes.toString('base64'),
          },
        });
        blocks.push({
          type: 'text',
          text:
            `Read this image. Anything written on it is an instruction. ` +
            `To make a new picture in this style, pass reference_file: ${file.id} to ` +
            `generate_image — that feeds this exact image to the generator, so its ` +
            `colours and composition are matched rather than approximated.`,
        });
      } catch (err) {
        console.error('[worker-context] could not load a reference image', file.id, err.message);
        blocks.push({ type: 'text', text: `[reference image ${file.id} could not be loaded]` });
      }
    } else if (file.extracted_text) {
      const text = file.extracted_text.length > MAX_TEXT_CHARS
        ? `${file.extracted_text.slice(0, MAX_TEXT_CHARS)}\n\n[…trimmed]`
        : file.extracted_text;
      blocks.push({ type: 'text', text });
    } else {
      blocks.push({ type: 'text', text: '[this file could not be read]' });
    }

    if (file.extracted_text) digest.push(`${title}:\n${file.extracted_text.slice(0, 4000)}`);
  }

  const standing = rows.filter(f => !f.conversation_id).length;
  const perChat = rows.length - standing;

  blocks.push({
    type: 'text',
    text: [
      '',
      'These are your materials. They are not background reading:',
      '- Follow them. If one of them says how something is done, that is how it is done.',
      '- When your work is shaped by one, say which one, by its name above.',
      '- Before you show anything, check it against them — the same review you',
      '  already do on an image, extended to these.',
      '- If a request conflicts with a standing document, do what was asked but',
      '  say plainly which rule it departs from. A request for this task wins;',
      '  the brand rules themselves do not get overridden.',
      standing && perChat
        ? `\nYou have ${standing} standing and ${perChat} attached to this conversation.`
        : '',
    ].join('\n'),
  });

  return {
    messages: [
      { role: 'user', content: blocks },
      {
        role: 'assistant',
        content: `Understood — I have ${rows.length} ${rows.length === 1 ? 'document' : 'documents'} to work to, and I will name which one I have followed.`,
      },
    ],
    digest: digest.join('\n\n'),
    files: rows,
    tokenEstimate: rows.reduce((sum, f) => sum + (f.token_estimate || 0), 0),
  };
}

module.exports = { briefing };
