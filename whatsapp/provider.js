const { WhatsappService } = require('./whatsapp.service');
const { TwilioWhatsappService } = require('./twilio.service');

/**
 * Returns the active WhatsApp provider based on WHATSAPP_PROVIDER env var.
 * Supported values: "meta" (default), "twilio"
 */
function getProvider() {
  const provider = (process.env.WHATSAPP_PROVIDER || 'meta').toLowerCase();
  if (provider === 'twilio') {
    return new TwilioWhatsappService();
  }
  return new WhatsappService();
}

module.exports = { getProvider };
