const twilio = require('twilio');
const { splitMessage } = require('./message-utils');

/**
 * Normalizes a phone number to E.164 format with + prefix.
 * Handles numbers like "972559880607" or "+972559880607" or "whatsapp:+972559880607".
 */
function normalizePhone(phone) {
  // Strip "whatsapp:" prefix if present
  let cleaned = phone.replace(/^whatsapp:/, '');
  // Ensure it starts with +
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  return cleaned;
}

class TwilioWhatsappService {
  constructor() {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    // e.g. "whatsapp:+972559880607"
    this.from = process.env.TWILIO_WHATSAPP_FROM;
  }

  async sendTextMessage(to, text) {
    try {
      const toFormatted = `whatsapp:${normalizePhone(to)}`;
      const msg = await this.client.messages.create({
        from: this.from,
        to: toFormatted,
        body: text
      });
      console.log(`[Twilio] Sent message to ${to} (sid: ${msg.sid})`);
      return { id: msg.sid };
    } catch (err) {
      console.error(`[Twilio] Failed to send message to ${to}:`, err.message);
      return { id: null };
    }
  }

  // Twilio does not support programmatic read receipts for WhatsApp - no-op
  async markAsRead(messageId) {}

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

module.exports = { TwilioWhatsappService, normalizePhone };
