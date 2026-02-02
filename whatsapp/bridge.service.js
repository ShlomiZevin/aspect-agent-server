const { getOrCreateMapping, resetConversation } = require('./user-map.service');
const { WhatsappService } = require('./whatsapp.service');
const conversationService = require('../services/conversation.service');
const llmService = require('../services/llm');
const crewService = require('../crew/services/crew.service');
const dispatcherService = require('../crew/services/dispatcher.service');

const whatsapp = new WhatsappService();

// Per-user lock to prevent overlapping responses
const activeLocks = new Map();

async function handleIncomingMessage(phone, text, messageId) {
  // Mark as read immediately
  whatsapp.markAsRead(messageId);

  // Handle special commands
  if (text.toLowerCase() === '/new' || text.toLowerCase() === '/reset') {
    resetConversation(phone);
    await whatsapp.sendTextMessage(phone, '🔄 New conversation started.');
    return;
  }

  // Use per-user lock to queue messages
  const existing = activeLocks.get(phone) || Promise.resolve();
  const current = existing.then(() => processMessage(phone, text)).catch(err => {
    console.error(`❌ Error processing message for ${phone}:`, err.message);
    whatsapp.sendTextMessage(phone, 'Sorry, something went wrong. Please try again.')
      .catch(() => {});
  });
  activeLocks.set(phone, current);
  await current;
}

async function processMessage(phone, text) {
  const agentName = process.env.AGENT_NAME || 'Freeda 2.0';

  // Get or create user mapping
  const { userId, conversationId } = await getOrCreateMapping(phone);

  console.log(`💬 Processing WhatsApp message from ${phone}: "${text.substring(0, 50)}..."`);

  // Get agent configuration from database
  const agent = await conversationService.getAgentByName(agentName);
  const agentConfig = agent.config || {};

  // Save user message to database
  await conversationService.saveUserMessage(conversationId, agentName, text, userId);

  // Check if agent has crew members
  const hasCrew = await crewService.hasCrew(agentName);

  let fullReply = '';

  if (hasCrew) {
    // ========== CREW-BASED ROUTING ==========
    console.log(`🎭 [WhatsApp] Agent ${agentName} has crew, using dispatcher`);

    for await (const chunk of dispatcherService.dispatch({
      message: text,
      conversationId,
      agentName,
      useKnowledgeBase: true,
      agentConfig
    })) {
      // Collect only text chunks, ignore event objects
      if (typeof chunk === 'string') {
        fullReply += chunk;
      } else if (typeof chunk === 'object' && chunk.chunk) {
        fullReply += chunk.chunk;
      }
    }

    // Handle post-response transitions
    const crewInfo = await dispatcherService.getCrewInfo(agentName, conversationId);
    if (crewInfo) {
      await dispatcherService.handlePostResponse({
        agentName,
        conversationId,
        message: text,
        response: fullReply,
        currentCrewName: crewInfo.name
      });
    }

  } else {
    // ========== LEGACY NON-CREW ROUTING ==========
    for await (const chunk of llmService.sendMessageStream(text, conversationId, true, agentConfig)) {
      if (typeof chunk === 'string') {
        fullReply += chunk;
      }
    }
  }

  // Save assistant response to database
  if (fullReply) {
    await conversationService.saveAssistantMessage(conversationId, fullReply);
  }

  if (!fullReply || fullReply.trim().length === 0) {
    await whatsapp.sendTextMessage(phone, 'I received your message but could not generate a response. Please try again.');
    return;
  }

  // Send response back via WhatsApp
  await whatsapp.splitAndSend(phone, fullReply);
  console.log(`✅ WhatsApp response sent to ${phone} (${fullReply.length} chars)`);
}

module.exports = { handleIncomingMessage };
