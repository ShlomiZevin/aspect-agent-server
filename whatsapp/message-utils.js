/**
 * Splits a long message into chunks that fit within WhatsApp's message size limit.
 * Tries to split at paragraph/line/sentence boundaries before hard-splitting.
 */
function splitMessage(text, maxLength = 4000) {
  if (text.length <= maxLength) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);

    // Fallback: split at line break
    if (splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }

    // Fallback: split at sentence end
    if (splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf('. ', maxLength);
      if (splitIndex > 0) splitIndex += 1;
    }

    // Final fallback: hard split
    if (splitIndex < maxLength * 0.3) {
      splitIndex = maxLength;
    }

    parts.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return parts;
}

module.exports = { splitMessage };
