const axios = require('axios');

const GRAPH_API_URL = 'https://graph.facebook.com/v22.0';

class WhatsappService {
  constructor() {
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.http = axios.create({
      baseURL: `${GRAPH_API_URL}/${this.phoneNumberId}`,
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  }

  async sendTextMessage(to, text) {
    try {
      const response = await this.http.post('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text }
      });
      const msgId = response.data?.messages?.[0]?.id || null;
      console.log(`📤 Sent message to ${to} (id: ${msgId})`);
      return { id: msgId };
    } catch (err) {
      console.error(`❌ Failed to send message to ${to}:`, err.response?.data || err.message);
      return { id: null };
    }
  }

  async markAsRead(messageId) {
    try {
      await this.http.post('/messages', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      });
    } catch (err) {
      // Non-critical, just log
      console.warn('⚠️ Failed to mark as read:', err.message);
    }
  }

  async splitAndSend(to, text) {
    const parts = splitMessage(text);
    const results = [];
    for (const part of parts) {
      const result = await this.sendTextMessage(to, part);
      results.push(result);
    }
    return results;
  }
}

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

module.exports = { WhatsappService, splitMessage };
