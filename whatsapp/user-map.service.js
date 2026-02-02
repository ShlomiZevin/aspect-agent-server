const crypto = require('crypto');
const conversationService = require('../services/conversation.service');

// In-memory mapping: phone -> { userId, conversationId }
const userMap = new Map();

async function getOrCreateMapping(phone) {
  if (userMap.has(phone)) {
    return userMap.get(phone);
  }

  // Create user directly via conversation service (no HTTP call)
  try {
    const externalId = `wa_${phone}`;
    const user = await conversationService.getOrCreateUser(externalId, { metadata: { phone, source: 'whatsapp' } });

    const userId = user.externalId;
    const conversationId = `wa_${phone}_${crypto.randomUUID()}`;

    const mapping = { userId, conversationId };
    userMap.set(phone, mapping);

    console.log(`👤 New user mapping: ${phone} → userId=${userId}, conv=${conversationId}`);
    return mapping;
  } catch (err) {
    console.error(`❌ Failed to create user for ${phone}:`, err.message);
    throw err;
  }
}

function getMapping(phone) {
  return userMap.get(phone) || null;
}

function resetConversation(phone) {
  const existing = userMap.get(phone);
  if (existing) {
    existing.conversationId = `wa_${phone}_${crypto.randomUUID()}`;
    console.log(`🔄 Reset conversation for ${phone}: ${existing.conversationId}`);
    return existing;
  }
  return null;
}

function setMapping(phone, userId, conversationId) {
  const mapping = { userId, conversationId };
  userMap.set(phone, mapping);
  console.log(`📱 Set mapping: ${phone} → userId=${userId}, conv=${conversationId}`);
  return mapping;
}

module.exports = { getOrCreateMapping, getMapping, resetConversation, setMapping };
