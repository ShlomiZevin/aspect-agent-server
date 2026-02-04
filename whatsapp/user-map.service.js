const crypto = require('crypto');
const conversationService = require('../services/conversation.service');
const db = require('../services/db.pg');
const { users, conversations } = require('../db/schema');
const { eq, or, desc } = require('drizzle-orm');

// In-memory mapping: phone -> { userId, conversationId }
const userMap = new Map();

/**
 * Find existing user by phone number (either linked or native WhatsApp user)
 * @param {string} phone - Phone number to search for
 * @returns {Promise<Object|null>} - User object or null
 */
async function findUserByPhone(phone) {
  const drizzle = db.getDrizzle();

  // Search for:
  // 1. User with this phone number set (linked web user)
  // 2. User with externalId = wa_${phone} (native WhatsApp user)
  const whatsappExternalId = `wa_${phone}`;

  const result = await drizzle
    .select()
    .from(users)
    .where(
      or(
        eq(users.phone, phone),
        eq(users.phone, `+${phone}`),  // Sometimes phone has + prefix
        eq(users.externalId, whatsappExternalId)
      )
    )
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * Find the latest conversation for a user
 * @param {number} userId - User database ID
 * @returns {Promise<string|null>} - Conversation externalId or null
 */
async function findLatestConversation(userId) {
  const drizzle = db.getDrizzle();

  const result = await drizzle
    .select({ externalId: conversations.externalId })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  return result.length > 0 ? result[0].externalId : null;
}

async function getOrCreateMapping(phone) {
  // 1. Check in-memory cache first (fast path)
  if (userMap.has(phone)) {
    return userMap.get(phone);
  }

  try {
    // 2. Check database for existing user with this phone
    const existingUser = await findUserByPhone(phone);

    if (existingUser) {
      // Found existing user (either linked web user or native WhatsApp user)
      const userId = existingUser.externalId;

      // Try to find their existing conversation, or create new one
      let conversationId = await findLatestConversation(existingUser.id);
      if (!conversationId) {
        conversationId = `wa_${phone}_${crypto.randomUUID()}`;
      }

      const mapping = { userId, conversationId };
      userMap.set(phone, mapping);

      console.log(`📱 Restored mapping from DB: ${phone} → userId=${userId}, conv=${conversationId}`);
      return mapping;
    }

    // 3. No existing user found - create new WhatsApp user
    const externalId = `wa_${phone}`;
    const user = await conversationService.getOrCreateUser(externalId, {
      metadata: { phone, source: 'whatsapp' }
    });

    const userId = user.externalId;
    const conversationId = `wa_${phone}_${crypto.randomUUID()}`;

    const mapping = { userId, conversationId };
    userMap.set(phone, mapping);

    console.log(`👤 New user mapping: ${phone} → userId=${userId}, conv=${conversationId}`);
    return mapping;
  } catch (err) {
    console.error(`❌ Failed to get/create user for ${phone}:`, err.message);
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
