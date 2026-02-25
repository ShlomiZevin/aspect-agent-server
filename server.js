// Load environment-specific .env file
const path = require('path');
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: path.join(__dirname, envFile) });
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const llmService = require('./services/llm');
const db = require('./services/db.pg');
const conversationService = require('./services/conversation.service');
const kbService = require('./services/kb.service');
const googleKBService = require('./services/kb.google.service');
const storageService = require('./services/storage.service');
const thinkingService = require('./services/thinking.service');
const feedbackService = require('./services/feedback.service');
const crewService = require('./crew/services/crew.service');
const dispatcherService = require('./crew/services/dispatcher.service');
const adminService = require('./services/admin.service');
const promptService = require('./services/prompt.service');
const crewMembersService = require('./services/crewMembers.service');
const taskService = require('./services/task.service');
const commentsService = require('./services/comments.service');
const demoService = require('./services/demo.service');

// WhatsApp bridge
const { handleIncomingMessage } = require('./whatsapp/bridge.service');
const { WhatsappService } = require('./whatsapp/whatsapp.service');
const whatsappService = new WhatsappService();
const { setMapping } = require('./whatsapp/user-map.service');

// Register function handlers
const symptomTracker = require('./functions/symptom-tracker');
symptomTracker.register();

// Configure multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

const app = express();
// Development CORS (more permissive)
if (process.env.NODE_ENV === 'development') {
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
  }));
} else {
  // Production CORS (strict)
  app.use(cors({
    origin: function (origin, callback) {
      const ALLOWED_ORIGINS = [
        'https://aspect-agents.firebaseapp.com',
        'https://aspect-agents.web.app',
        'https://primyo.io',
        'https://boostmind-b052c.web.app',
        'https://freeda-2b4af.web.app',
        'https://freeda-2b4af.firebaseapp.com'
      ];

      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
  }));
}

app.use(bodyParser.json());
app.use(express.static('public'));

// Health check endpoint for App Engine Flexible
app.get('/health', async (req, res) => {
  res.status(200).json({});
});

// ========== CREW MANAGEMENT ENDPOINTS ==========

// Get all crew members for an agent (includes both file and DB crews)
app.get('/api/agents/:agentName/crew', async (req, res) => {
  const { agentName } = req.params;

  try {
    const crewList = await crewService.listCrew(agentName);
    res.json({
      agentName,
      crew: crewList
    });
  } catch (err) {
    console.error('❌ Error fetching crew:', err.message);
    res.status(500).json({ error: 'Error fetching crew: ' + err.message });
  }
});

// ========== CREW MEMBERS CRUD (DB-based crews) ==========

// Get a single crew member by name (checks both file and DB crews)
app.get('/api/agents/:agentName/crew-members/:crewName', async (req, res) => {
  const { agentName, crewName } = req.params;

  try {
    // Use crewService which loads both file and DB crews
    const crew = await crewService.getCrewMember(agentName, crewName);
    if (!crew) {
      return res.status(404).json({ error: 'Crew member not found' });
    }

    // Return full config (toJSON for file-based, direct for DB-based)
    const crewMember = typeof crew.toJSON === 'function' ? crew.toJSON() : crew;

    // Extract tool names (getToolNames returns objects with {name, description, parameters})
    let toolNames = [];
    if (crew.getToolNames) {
      const tools = crew.getToolNames();
      toolNames = tools.map(t => typeof t === 'string' ? t : t.name);
    } else if (crew.tools) {
      toolNames = crew.tools.map(t => typeof t === 'string' ? t : t.name);
    }

    // Add source and guidance for the editor
    res.json({
      crewMember: {
        ...crewMember,
        source: crew.source || 'file',
        guidance: crew.guidance || '',
        maxTokens: crew.maxTokens || 2048,
        knowledgeBase: crew.knowledgeBase || null,
        transitionTo: crew.transitionTo || null,
        transitionSystemPrompt: crew.transitionSystemPrompt || null,
        tools: toolNames,
        fieldsToCollect: crew.fieldsToCollect || [],
      }
    });
  } catch (err) {
    console.error('❌ Error fetching crew member:', err.message);
    res.status(500).json({ error: 'Error fetching crew member: ' + err.message });
  }
});

// Get transition logic for a specific crew member (for debug panel)
app.get('/api/agents/:agentName/crew-members/:crewName/transition-logic', async (req, res) => {
  const { agentName, crewName } = req.params;

  try {
    const crew = await crewService.getCrewMember(agentName, crewName);
    if (!crew) {
      return res.status(404).json({ error: 'Crew member not found' });
    }

    const CrewMember = require('./crew/base/CrewMember');

    // Check if crew has custom transfer methods (not the base class defaults)
    const hasCustomPre = crew.preMessageTransfer !== CrewMember.prototype.preMessageTransfer;
    const hasCustomPost = crew.postMessageTransfer !== CrewMember.prototype.postMessageTransfer;

    // No transition logic at all
    if (!hasCustomPre && !hasCustomPost && !crew.oneShot && !crew.transitionTo) {
      return res.json({ transitionLogic: null });
    }

    const hasStructuredRules = crew.transitionRules && crew.transitionRules.length > 0;

    // Extract raw function code as fallback
    let rawCode = null;
    if (!hasStructuredRules) {
      rawCode = {
        pre: hasCustomPre ? crew.preMessageTransfer.toString() : null,
        post: hasCustomPost ? crew.postMessageTransfer.toString() : null,
      };
    }

    // For structured rules, return the rule definitions (without evaluation - that needs runtime fields)
    let ruleDefinitions = null;
    if (hasStructuredRules) {
      ruleDefinitions = {
        pre: crew.transitionRules.filter(r => r.type === 'pre').map(r => ({
          id: r.id,
          description: r.condition.description,
          fields: r.condition.fields || [],
          result: r.result,
          priority: r.priority || 0,
        })),
        post: crew.transitionRules.filter(r => r.type === 'post').map(r => ({
          id: r.id,
          description: r.condition.description,
          fields: r.condition.fields || [],
          result: r.result,
          priority: r.priority || 0,
        })),
      };
    }

    res.json({
      transitionLogic: {
        transitionTo: crew.transitionTo,
        oneShot: crew.oneShot || false,
        hasPreTransfer: hasCustomPre,
        hasPostTransfer: hasCustomPost,
        hasStructuredRules,
        ruleDefinitions,
        rawCode,
      }
    });
  } catch (err) {
    console.error('❌ Error fetching transition logic:', err.message);
    res.status(500).json({ error: 'Error fetching transition logic: ' + err.message });
  }
});

// Create a new crew member (DB-based)
app.post('/api/agents/:agentName/crew-members', async (req, res) => {
  const { agentName } = req.params;
  const config = req.body;

  try {
    // Get agent ID
    const agentId = await crewMembersService.getAgentId(agentName);
    if (!agentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Validate required fields
    if (!config.name || !config.displayName || !config.guidance) {
      return res.status(400).json({ error: 'Missing required fields: name, displayName, guidance' });
    }

    const crewMember = await crewMembersService.create(agentId, config);
    if (!crewMember) {
      return res.status(400).json({ error: 'Failed to create crew member (may already exist)' });
    }

    // Clear crew cache so new member is loaded
    crewService.crews.delete(agentName);

    res.status(201).json({ crewMember });
  } catch (err) {
    console.error('❌ Error creating crew member:', err.message);
    res.status(500).json({ error: 'Error creating crew member: ' + err.message });
  }
});

// Update a crew member (DB-based only)
app.patch('/api/agents/:agentName/crew-members/:crewName', async (req, res) => {
  const { agentName, crewName } = req.params;
  const updates = req.body;

  try {
    // Get agent ID
    const agentId = await crewMembersService.getAgentId(agentName);
    if (!agentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const crewMember = await crewMembersService.update(agentId, crewName, updates);
    if (!crewMember) {
      return res.status(404).json({ error: 'Crew member not found (or is file-based)' });
    }

    // Clear crew cache so changes are reflected
    crewService.crews.delete(agentName);

    res.json({ crewMember });
  } catch (err) {
    console.error('❌ Error updating crew member:', err.message);
    res.status(500).json({ error: 'Error updating crew member: ' + err.message });
  }
});

// Delete a crew member (DB-based only, soft delete)
app.delete('/api/agents/:agentName/crew-members/:crewName', async (req, res) => {
  const { agentName, crewName } = req.params;

  try {
    // Get agent ID
    const agentId = await crewMembersService.getAgentId(agentName);
    if (!agentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const success = await crewMembersService.delete(agentId, crewName);
    if (!success) {
      return res.status(404).json({ error: 'Crew member not found (or is file-based)' });
    }

    // Clear crew cache
    crewService.crews.delete(agentName);

    res.json({ success: true, message: `Crew member "${crewName}" deleted` });
  } catch (err) {
    console.error('❌ Error deleting crew member:', err.message);
    res.status(500).json({ error: 'Error deleting crew member: ' + err.message });
  }
});

// Generate a crew member from description (uses Claude)
app.post('/api/agents/:agentName/crew-members/generate', async (req, res) => {
  const { agentName } = req.params;
  const { description, existingCrews, availableTools, knowledgeBases } = req.body;

  if (!description) {
    return res.status(400).json({ error: 'Missing required field: description' });
  }

  try {
    const config = await llmService.generateCrewFromDescription(description, agentName, {
      existingCrews: existingCrews || [],
      availableTools: availableTools || [],
      knowledgeBases: knowledgeBases || []
    });

    res.json({ success: true, config });
  } catch (err) {
    console.error('❌ Error generating crew member:', err.message);
    res.status(500).json({ error: 'Error generating crew member: ' + err.message });
  }
});

// Export crew member as .crew.js file code
app.post('/api/agents/:agentName/crew-members/:crewName/export', async (req, res) => {
  const { agentName, crewName } = req.params;

  try {
    // Get the crew member config (from DB)
    const config = await crewMembersService.getOneByAgentName(agentName, crewName);
    if (!config) {
      return res.status(404).json({ error: 'Crew member not found' });
    }

    // Generate the file code
    const fileCode = llmService.generateCrewFileCode(config, agentName);

    res.json({
      fileName: `${crewName}.crew.js`,
      code: fileCode
    });
  } catch (err) {
    console.error('❌ Error exporting crew member:', err.message);
    res.status(500).json({ error: 'Error exporting crew member: ' + err.message });
  }
});

// ========== PROMPT MANAGEMENT ENDPOINTS (Debug Mode) ==========

// Get all prompts for all crew members of an agent
app.get('/api/agents/:agentName/prompts', async (req, res) => {
  const { agentName } = req.params;

  try {
    // Get prompts from DB
    const dbPrompts = await promptService.getAllCrewPrompts(agentName);

    // Get crew members from code for display names
    const crewList = await crewService.listCrew(agentName);
    const crewMap = new Map(crewList.map(c => [c.name, c]));

    // Merge: add display name, and fallback to code prompts for crew without DB versions
    const result = [];

    // First, add all crew members from code
    for (const crew of crewList) {
      const dbData = dbPrompts.find(p => p.crewMemberId === crew.name);
      if (dbData) {
        // Has DB versions - use them, include model from crew
        result.push({
          crewMemberId: crew.name,
          crewMemberName: crew.name,
          displayName: crew.displayName,
          model: crew.model, // Include the crew's model
          versions: dbData.versions,
          currentVersion: dbData.currentVersion,
        });
      } else {
        // No DB versions - get from code and show as v0
        const crewMember = await crewService.getCrewMember(agentName, crew.name);
        if (crewMember && crewMember.guidance) {
          result.push({
            crewMemberId: crew.name,
            crewMemberName: crew.name,
            displayName: crew.displayName,
            model: crewMember.model, // Include the crew's model
            versions: [{
              id: `code-${crew.name}`,
              version: 0,
              name: 'Code default',
              prompt: crewMember.guidance,
              isActive: true,
              createdAt: null,
              updatedAt: null,
            }],
            currentVersion: {
              id: `code-${crew.name}`,
              version: 0,
              name: 'Code default',
              prompt: crewMember.guidance,
              isActive: true,
              createdAt: null,
              updatedAt: null,
            },
          });
        }
      }
    }

    res.json({
      agentName,
      prompts: result,
    });
  } catch (err) {
    console.error('❌ Error fetching prompts:', err.message);
    res.status(500).json({ error: 'Error fetching prompts: ' + err.message });
  }
});

// Get prompt versions for a specific crew member
app.get('/api/agents/:agentName/crew/:crewName/prompts', async (req, res) => {
  const { agentName, crewName } = req.params;

  try {
    const versions = await promptService.getPromptVersions(agentName, crewName);

    // If no DB versions, get from code
    if (versions.length === 0) {
      const crewMember = await crewService.getCrewMember(agentName, crewName);
      if (crewMember && crewMember.guidance) {
        return res.json({
          crewMemberId: crewName,
          versions: [{
            id: `code-${crewName}`,
            version: 0,
            name: 'Code default',
            prompt: crewMember.guidance,
            isActive: true,
            createdAt: null,
            updatedAt: null,
          }],
        });
      }
    }

    res.json({
      crewMemberId: crewName,
      versions,
    });
  } catch (err) {
    console.error('❌ Error fetching prompt versions:', err.message);
    res.status(500).json({ error: 'Error fetching prompt versions: ' + err.message });
  }
});

// Get active prompt for a crew member
app.get('/api/agents/:agentName/crew/:crewName/prompts/active', async (req, res) => {
  const { agentName, crewName } = req.params;

  try {
    const activePrompt = await promptService.getActivePrompt(agentName, crewName);

    // If no DB version, get from code
    if (!activePrompt) {
      const crewMember = await crewService.getCrewMember(agentName, crewName);
      if (crewMember && crewMember.guidance) {
        return res.json({
          crewMemberId: crewName,
          prompt: {
            id: `code-${crewName}`,
            version: 0,
            name: 'Code default',
            prompt: crewMember.guidance,
            isActive: true,
            createdAt: null,
            updatedAt: null,
          },
          source: 'code',
        });
      }
    }

    res.json({
      crewMemberId: crewName,
      prompt: activePrompt,
      source: 'database',
    });
  } catch (err) {
    console.error('❌ Error fetching active prompt:', err.message);
    res.status(500).json({ error: 'Error fetching active prompt: ' + err.message });
  }
});

// Create new prompt version (Save as New Version)
app.post('/api/agents/:agentName/crew/:crewName/prompts', async (req, res) => {
  const { agentName, crewName } = req.params;
  const { prompt, name, transitionSystemPrompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt text is required' });
  }

  try {
    const newVersion = await promptService.createPromptVersion(
      agentName,
      crewName,
      prompt,
      name || null,
      null, // createdBy
      transitionSystemPrompt || null
    );

    console.log(`✅ Created new prompt version: ${crewName} v${newVersion.version}`);
    res.json({
      success: true,
      version: newVersion,
    });
  } catch (err) {
    console.error('❌ Error creating prompt version:', err.message);
    res.status(500).json({ error: 'Error creating prompt version: ' + err.message });
  }
});

// Update existing prompt version (Save/Overwrite)
app.patch('/api/agents/:agentName/crew/:crewName/prompts/:versionId', async (req, res) => {
  const { agentName, crewName, versionId } = req.params;
  const { prompt, transitionSystemPrompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt text is required' });
  }

  try {
    const updated = await promptService.updatePromptVersion(
      agentName,
      crewName,
      parseInt(versionId),
      prompt,
      transitionSystemPrompt // Can be undefined (not updated) or string/null (update)
    );

    console.log(`✅ Updated prompt version: ${crewName} v${updated.version}`);
    res.json({
      success: true,
      version: updated,
    });
  } catch (err) {
    console.error('❌ Error updating prompt version:', err.message);
    res.status(500).json({ error: 'Error updating prompt version: ' + err.message });
  }
});

// Activate a specific prompt version
app.post('/api/agents/:agentName/crew/:crewName/prompts/:versionId/activate', async (req, res) => {
  const { agentName, crewName, versionId } = req.params;

  try {
    const activated = await promptService.activateVersion(
      agentName,
      crewName,
      parseInt(versionId)
    );

    console.log(`✅ Activated prompt version: ${crewName} v${activated.version}`);
    res.json({
      success: true,
      version: activated,
    });
  } catch (err) {
    console.error('❌ Error activating prompt version:', err.message);
    res.status(500).json({ error: 'Error activating prompt version: ' + err.message });
  }
});

// Delete a prompt version
app.delete('/api/agents/:agentName/crew/:crewName/prompts/:versionId', async (req, res) => {
  const { agentName, crewName, versionId } = req.params;

  try {
    await promptService.deleteVersion(
      agentName,
      crewName,
      parseInt(versionId)
    );

    console.log(`✅ Deleted prompt version: ${crewName} #${versionId}`);
    res.json({
      success: true,
    });
  } catch (err) {
    console.error('❌ Error deleting prompt version:', err.message);
    res.status(500).json({ error: 'Error deleting prompt version: ' + err.message });
  }
});

// Create new anonymous user
app.post('/api/user/create', async (req, res) => {
  try {
    // Generate unique external ID
    const externalId = `anon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create user in database
    const user = await conversationService.getOrCreateUser(externalId);

    res.json({
      userId: user.externalId,
      createdAt: user.createdAt
    });
  } catch (err) {
    console.error('❌ Error creating user:', err.message);
    res.status(500).json({ error: 'Error creating user: ' + err.message });
  }
});

// Link phone number - find WhatsApp user by phone and return their conversations
app.post('/api/user/link-phone', async (req, res) => {
  try {
    const { phone, agentName } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Normalize phone: keep only digits
    const normalizedPhone = phone.replace(/[^0-9]/g, '');

    // Find WhatsApp user by phone
    const user = await conversationService.getUserByPhone(normalizedPhone);
    if (!user) {
      return res.status(404).json({ error: 'phone_not_found' });
    }

    // Get conversations for this user
    const userConversations = await conversationService.getUserConversations(user.externalId, agentName || null);

    res.json({
      userId: user.externalId,
      conversations: userConversations
    });
  } catch (err) {
    console.error('❌ Error linking phone:', err.message);
    res.status(500).json({ error: 'Error linking phone: ' + err.message });
  }
});

// Go Mobile: link current conversation to a phone number
app.post('/api/conversation/:conversationId/link-phone', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID is required' });
    }

    const normalizedPhone = phone.replace(/[^0-9]/g, '');

    const result = await conversationService.linkConversationToPhone(conversationId, normalizedPhone);

    // Update in-memory WhatsApp mapping so bridge picks up this conversation
    setMapping(normalizedPhone, result.user.externalId, result.newExternalId);

    res.json({
      userId: result.user.externalId,
      conversationId: result.newExternalId
    });
  } catch (err) {
    console.error('❌ Error linking conversation to phone:', err.message);
    res.status(500).json({ error: 'Error linking conversation to phone: ' + err.message });
  }
});

// Get conversation history
app.get('/api/conversation/:conversationId/history', async (req, res) => {
  const { conversationId } = req.params;
  const { limit } = req.query;

  try {
    const history = await conversationService.getConversationHistory(
      conversationId,
      limit ? parseInt(limit) : 50
    );

    // Also get the conversation's current crew member for state restoration
    const conversation = await conversationService.getConversationByExternalId(conversationId);

    res.json({
      conversationId,
      messageCount: history.length,
      messages: history,
      currentCrewMember: conversation?.currentCrewMember || null
    });
  } catch (err) {
    console.error('❌ Error fetching history:', err.message);
    res.status(500).json({ error: 'Error fetching conversation history: ' + err.message });
  }
});

// Get all conversations for a user
app.get('/api/user/:userId/conversations', async (req, res) => {
  const { userId } = req.params;
  const { agentName } = req.query;

  try {
    const conversations = await conversationService.getUserConversations(userId, agentName);
    res.json({
      userId,
      count: conversations.length,
      conversations
    });
  } catch (err) {
    console.error('❌ Error fetching user conversations:', err.message);
    res.status(500).json({ error: 'Error fetching conversations: ' + err.message });
  }
});

// Update conversation metadata (title, etc.)
app.patch('/api/conversation/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const { title, metadata } = req.body;

  try {
    const conversation = await conversationService.updateConversationMetadata(
      conversationId,
      { title, ...metadata }
    );
    res.json(conversation);
  } catch (err) {
    console.error('❌ Error updating conversation:', err.message);
    res.status(500).json({ error: 'Error updating conversation: ' + err.message });
  }
});

// Delete a conversation
app.delete('/api/conversation/:conversationId', async (req, res) => {
  const { conversationId } = req.params;

  try {
    await conversationService.deleteConversation(conversationId);
    res.json({ success: true, conversationId });
  } catch (err) {
    console.error('❌ Error deleting conversation:', err.message);
    res.status(500).json({ error: 'Error deleting conversation: ' + err.message });
  }
});

// Delete all conversations for a user (by agent)
app.delete('/api/user/:userId/conversations', async (req, res) => {
  const { userId } = req.params;
  const { agentName } = req.query;

  if (!agentName) {
    return res.status(400).json({ error: 'agentName query parameter is required' });
  }

  try {
    const result = await conversationService.deleteAllConversations(userId, agentName);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Error deleting all conversations:', err.message);
    res.status(500).json({ error: 'Error deleting all conversations: ' + err.message });
  }
});

// Delete a single message
app.delete('/api/conversation/:conversationId/message/:messageId', async (req, res) => {
  const { conversationId, messageId } = req.params;

  try {
    const deleted = await conversationService.deleteMessage(parseInt(messageId, 10));
    res.json({ success: true, deleted });
  } catch (err) {
    console.error('❌ Error deleting message:', err.message);
    res.status(500).json({ error: 'Error deleting message: ' + err.message });
  }
});

// Delete multiple messages
app.delete('/api/conversation/:conversationId/messages', async (req, res) => {
  const { conversationId } = req.params;
  const { messageIds } = req.body;

  try {
    const result = await conversationService.deleteMessages(messageIds);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Error deleting messages:', err.message);
    res.status(500).json({ error: 'Error deleting messages: ' + err.message });
  }
});

// Delete messages from a specific point onwards (for "regenerate from here")
app.delete('/api/conversation/:conversationId/messages-from/:messageId', async (req, res) => {
  const { conversationId, messageId } = req.params;

  try {
    const result = await conversationService.deleteMessagesFrom(conversationId, parseInt(messageId, 10));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Error deleting messages from point:', err.message);
    res.status(500).json({ error: 'Error deleting messages: ' + err.message });
  }
});

// ========== DEBUG: INJECT DEVELOPER MESSAGE (for testing transition prompts) ==========
// Injects a developer-role message into conversation history for testing
app.post('/api/conversation/:conversationId/inject-developer-message', async (req, res) => {
  const { conversationId } = req.params;
  const { content, crewMemberName } = req.body;

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }

  try {
    // Get the conversation
    const conversation = await conversationService.getConversationByExternalId(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Save the message as 'developer' role
    const message = await conversationService.saveMessage(
      conversation.id,
      'developer',
      content.trim(),
      {
        injectedForTesting: true,
        crewMemberName: crewMemberName || null,
        injectedAt: new Date().toISOString()
      }
    );

    console.log(`🔧 DEBUG: Injected developer message into conversation ${conversationId}`);

    res.json({
      success: true,
      message: {
        id: message.id,
        role: message.role,
        content: message.content,
        metadata: message.metadata,
        createdAt: message.createdAt
      }
    });
  } catch (err) {
    console.error('❌ Error injecting developer message:', err.message);
    res.status(500).json({ error: 'Error injecting message: ' + err.message });
  }
});

// ========== COLLECTED FIELDS ENDPOINTS (for Fields Editor Panel) ==========
const agentContextService = require('./services/agentContext.service');

// Get collected fields for a conversation
app.get('/api/conversation/:conversationId/fields', async (req, res) => {
  const { conversationId } = req.params;

  try {
    // Get conversation to find agent name and current crew member
    const conversation = await conversationService.getConversationByExternalId(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Get collected fields
    const collectedFields = await agentContextService.getCollectedFields(conversationId);

    // Get current crew member info (for field definitions)
    const currentCrewName = conversation.currentCrewMember || conversation.metadata?.currentCrewMember;
    let crewInfo = null;
    let fieldDefinitions = [];
    let totalFieldsToCurrentCrew = 0;

    if (currentCrewName && conversation.agentId) {
      // Get agent name from conversation
      const agent = await conversationService.getAgentById(conversation.agentId);
      if (agent) {
        const crew = await crewService.getCrewMember(agent.name, currentCrewName);
        if (crew) {
          crewInfo = {
            name: crew.name,
            displayName: crew.displayName,
            extractionMode: crew.extractionMode || 'conversational'
          };
          fieldDefinitions = crew.fieldsToCollect || [];

          // Calculate total fields from journey start to current crew
          const allCrewMembers = await crewService.listCrew(agent.name);
          const crewByName = new Map(allCrewMembers.map(c => [c.name, c]));

          // Build the journey order by following transitionTo chain
          const journeyOrder = [];
          const defaultCrew = allCrewMembers.find(c => c.isDefault) || allCrewMembers[0];
          if (defaultCrew) {
            const visited = new Set();
            let cursor = defaultCrew;

            while (cursor && !visited.has(cursor.name)) {
              visited.add(cursor.name);
              journeyOrder.push(cursor);

              if (cursor.transitionTo) {
                cursor = crewByName.get(cursor.transitionTo);
              } else {
                break;
              }
            }
          }

          // Find current crew position in journey and sum fields up to it
          const currentIndex = journeyOrder.findIndex(c => c.name === currentCrewName);
          if (currentIndex >= 0) {
            // Sum fields from start to current (inclusive)
            for (let i = 0; i <= currentIndex; i++) {
              totalFieldsToCurrentCrew += (journeyOrder[i].fieldsToCollect?.length || 0);
            }
          } else {
            // Current crew not in chain - just count current crew's fields
            totalFieldsToCurrentCrew = fieldDefinitions.length;
          }
        }
      }
    }

    res.json({
      conversationId,
      collectedFields,
      currentCrewMember: crewInfo,
      fieldDefinitions,
      totalFieldsToCurrentCrew
    });
  } catch (err) {
    console.error('❌ Error fetching collected fields:', err.message);
    res.status(500).json({ error: 'Error fetching collected fields: ' + err.message });
  }
});

// Update collected fields for a conversation
app.patch('/api/conversation/:conversationId/fields', async (req, res) => {
  const { conversationId } = req.params;
  const { fields } = req.body;

  if (!fields || typeof fields !== 'object') {
    return res.status(400).json({ error: 'Fields object is required' });
  }

  try {
    const updatedFields = await agentContextService.updateCollectedFields(conversationId, fields);
    console.log(`✅ Updated fields for ${conversationId}:`, Object.keys(fields).join(', '));
    res.json({
      success: true,
      collectedFields: updatedFields
    });
  } catch (err) {
    console.error('❌ Error updating collected fields:', err.message);
    res.status(500).json({ error: 'Error updating collected fields: ' + err.message });
  }
});

// Delete specific collected fields
app.delete('/api/conversation/:conversationId/fields', async (req, res) => {
  const { conversationId } = req.params;
  const { fieldNames } = req.body;

  if (!fieldNames || !Array.isArray(fieldNames)) {
    return res.status(400).json({ error: 'fieldNames array is required' });
  }

  try {
    // Get current fields
    const currentFields = await agentContextService.getCollectedFields(conversationId);

    // Remove specified fields
    const fieldsToKeep = {};
    for (const [key, value] of Object.entries(currentFields)) {
      if (!fieldNames.includes(key)) {
        fieldsToKeep[key] = value;
      }
    }

    // Update conversation metadata and clear cache
    await conversationService.updateConversationMetadata(conversationId, { collectedFields: fieldsToKeep });
    agentContextService.clearCache(conversationId);

    console.log(`✅ Deleted fields for ${conversationId}:`, fieldNames.join(', '));
    res.json({
      success: true,
      collectedFields: fieldsToKeep
    });
  } catch (err) {
    console.error('❌ Error deleting collected fields:', err.message);
    res.status(500).json({ error: 'Error deleting collected fields: ' + err.message });
  }
});

// ========== CONTEXT ENDPOINTS (for Context Editor Panel) ==========
const contextService = require('./services/context.service');

// Get all context for a conversation (both user-level and conversation-level)
app.get('/api/conversation/:conversationId/context', async (req, res) => {
  const { conversationId } = req.params;

  try {
    // Get conversation to find userId
    const conversation = await conversationService.getConversationByExternalId(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conversation.userId) {
      return res.json({
        conversationId,
        userLevel: {},
        conversationLevel: {}
      });
    }

    // Get user-level namespaces
    const userNamespaces = await contextService.listNamespaces(conversation.userId, null);
    const userLevel = {};
    for (const ns of userNamespaces) {
      userLevel[ns] = await contextService.getContext(conversation.userId, ns, null);
    }

    // Get conversation-level namespaces
    const convNamespaces = await contextService.listNamespaces(conversation.userId, conversation.id);
    const conversationLevel = {};
    for (const ns of convNamespaces) {
      conversationLevel[ns] = await contextService.getContext(conversation.userId, ns, conversation.id);
    }

    res.json({
      conversationId,
      userLevel,
      conversationLevel
    });
  } catch (err) {
    console.error('❌ Error fetching context:', err.message);
    res.status(500).json({ error: 'Error fetching context: ' + err.message });
  }
});

// Update context for a specific namespace
app.patch('/api/conversation/:conversationId/context/:namespace', async (req, res) => {
  const { conversationId, namespace } = req.params;
  const { data, level = 'user' } = req.body;

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Data object is required' });
  }

  try {
    const conversation = await conversationService.getConversationByExternalId(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conversation.userId) {
      return res.status(400).json({ error: 'Conversation has no associated user' });
    }

    const convId = level === 'conversation' ? conversation.id : null;
    await contextService.saveContext(conversation.userId, namespace, data, convId);

    console.log(`✅ Updated context for ${conversationId}, namespace=${namespace}, level=${level}`);
    res.json({
      success: true,
      namespace,
      level,
      data
    });
  } catch (err) {
    console.error('❌ Error updating context:', err.message);
    res.status(500).json({ error: 'Error updating context: ' + err.message });
  }
});

// Delete context for a specific namespace
app.delete('/api/conversation/:conversationId/context/:namespace', async (req, res) => {
  const { conversationId, namespace } = req.params;
  const { level = 'user' } = req.body || {};

  try {
    const conversation = await conversationService.getConversationByExternalId(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conversation.userId) {
      return res.status(400).json({ error: 'Conversation has no associated user' });
    }

    const convId = level === 'conversation' ? conversation.id : null;
    await contextService.deleteContext(conversation.userId, namespace, convId);

    console.log(`✅ Deleted context for ${conversationId}, namespace=${namespace}, level=${level}`);
    res.json({
      success: true,
      namespace,
      level
    });
  } catch (err) {
    console.error('❌ Error deleting context:', err.message);
    res.status(500).json({ error: 'Error deleting context: ' + err.message });
  }
});

app.post('/api/finance-assistant', async (req, res) => {
  const { message, conversationId, userId, agentName } = req.body;

  if (!message || !conversationId) {
    return res.status(400).json({ error: 'Missing message or conversationId' });
  }

  try {
    // Default to Aspect if no agent name specified (for backward compatibility)
    const agentNameToUse = agentName || 'Aspect';

    // Get agent configuration from database
    const agent = await conversationService.getAgentByName(agentNameToUse);

    // Save user message to database
    await conversationService.saveUserMessage(
      conversationId,
      agentNameToUse,
      message,
      userId || null
    );

    // Build agent config from config JSON (includes promptId, vectorStoreId, etc.)
    const agentConfig = agent.config || {};

    // Get AI response with agent-specific config
    const result = await llmService.sendMessage(message, conversationId, agentConfig);

    // Save assistant response to database
    await conversationService.saveAssistantMessage(conversationId, result.reply);

    // Return reply and function call info
    res.json({
      reply: result.reply,
      functionCalls: result.functionCalls || []
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'Error handling message: ' + err.message });
  }
});

// Streaming endpoint
app.post('/api/finance-assistant/stream', async (req, res) => {
  const { message, conversationId, useKnowledgeBase, userId, agentName, overrideCrewMember, debug, promptOverrides, modelOverrides } = req.body;

  if (!message || !conversationId) {
    return res.status(400).json({ error: 'Missing message or conversationId' });
  }

  try {
    // Default to Aspect if no agent name specified (for backward compatibility)
    const agentNameToUse = agentName || 'Aspect';

    // Get agent configuration from database
    const agent = await conversationService.getAgentByName(agentNameToUse);

    // Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for nginx/proxy
    res.setHeader('Content-Encoding', 'identity'); // Disable compression
    res.setHeader('Transfer-Encoding', 'chunked'); // Force chunked encoding

    // Send initial comment to establish connection IMMEDIATELY
    res.write(':ok\n\n');
    if (res.flush) res.flush();

    // Helper to send SSE data
    const sendSSE = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.flush && res.flush();
    };

    // Start thinking context with SSE callback
    thinkingService.startContext(conversationId, null, sendSSE);

    // Add "Message received" thinking step
    thinkingService.addMessageReceivedStep(conversationId, message);

    // Save user message to database
    const { message: userMsg } = await conversationService.saveUserMessage(
      conversationId,
      agentNameToUse,
      message,
      userId || null
    );
    // Send user message ID to client so it can be deleted later
    sendSSE({ type: 'user_message_saved', messageId: userMsg.id });

    // Build agent config from config JSON (includes promptId, vectorStoreId, etc.)
    const agentConfig = agent.config || {};

    // Check if agent has crew members
    const hasCrew = await crewService.hasCrew(agentNameToUse);

    let fullReply = '';
    let currentCrewName = null;

    if (hasCrew) {
      // ========== CREW-BASED ROUTING ==========
      console.log(`🎭 Agent ${agentNameToUse} has crew members, using dispatcher`);

      // Debug: log received overrides from client
      if (debug) {
        console.log(`📥 [DEBUG] Received from client:`);
        console.log(`   promptOverrides:`, promptOverrides || '(none)');
        console.log(`   modelOverrides:`, modelOverrides || '(none)');
      }

      // Get current crew info and send to client
      const crewInfo = await dispatcherService.getCrewInfo(agentNameToUse, conversationId, overrideCrewMember);
      let currentCrewDisplayName = null;
      if (crewInfo) {
        currentCrewName = crewInfo.name;
        currentCrewDisplayName = crewInfo.displayName;
        sendSSE({ type: 'crew_info', crew: crewInfo });
        thinkingService.addStep(conversationId, 'crew_routing', `Routing to: ${crewInfo.displayName}`);
      }

      // Add KB access step if using knowledge base
      // For crew-based routing, the storeId is configured in the crew member file
      if (useKnowledgeBase && crewInfo?.hasKnowledgeBase) {
        thinkingService.addKnowledgeBaseStep(conversationId, 'crew knowledge base');
      }

      // Track if a pre-transfer transition happened during dispatch
      let inlineTransition = null;

      // Dispatch through crew system
      for await (const chunk of dispatcherService.dispatch({
        message,
        conversationId,
        agentName: agentNameToUse,
        overrideCrewMember,
        useKnowledgeBase,
        agentConfig,
        debug,
        promptOverrides: promptOverrides || {},
        modelOverrides: modelOverrides || {}
      })) {
        // Check if chunk is a function call event (object) or text (string)
        if (typeof chunk === 'object' && chunk.type) {
          // Handle function call - add thinking step
          if (chunk.type === 'function_call') {
            const funcName = chunk.name.replace(/^call_/, '');
            let description = `Calling function: ${funcName}`;

            if (funcName === 'report_symptom' && chunk.params?.symptom_name) {
              description = `Tracked symptom: "${chunk.params.symptom_name}"`;
            }

            thinkingService.addFunctionCallStep(conversationId, funcName, chunk.params, description);
          }

          // Handle file search results - show which KB files were referenced
          if (chunk.type === 'file_search_results' && chunk.files?.length > 0) {
            const topFiles = chunk.files.slice(0, 3);
            const summary = topFiles.map(f => f.name.length > 30 ? f.name.substring(0, 27) + '...' : f.name).join(', ');
            const suffix = chunk.files.length > 3 ? ` (+${chunk.files.length - 3} more)` : '';
            thinkingService.addStep(
              conversationId,
              'file_search',
              `Found in: ${summary}${suffix}`,
              { files: chunk.files }
            );
          }

          // Handle field extraction events from micro-agent
          if (chunk.type === 'field_extracted') {
            thinkingService.addStep(
              conversationId,
              'field_extracted',
              `Extracted field: ${chunk.field} = ${chunk.value}`,
              { field: chunk.field, value: chunk.value }
            );
          }

          // Handle inline crew transition (pre-transfer from dispatcher)
          if (chunk.type === 'crew_transition' && chunk.transition) {
            // Save the first crew's message before transitioning
            // This ensures the second crew can see it in conversation history
            if (fullReply) {
              const firstCrewMetadata = {
                crewMember: currentCrewDisplayName || currentCrewName,
                transitionTo: chunk.transition.to,
                transitionReason: chunk.transition.reason
              };
              const firstMessage = await conversationService.saveAssistantMessage(
                conversationId,
                fullReply,
                firstCrewMetadata
              );
              thinkingService.setMessageId(conversationId, firstMessage.id);
              sendSSE({ type: 'message_saved', messageId: firstMessage.id });

              // Start a new thinking context for the second crew (without SSE callback)
              await thinkingService.endContext(conversationId);
              thinkingService.startContext(conversationId);
            } else {
              // For early pre-transfer, clear the SSE callback to prevent addStep from auto-sending
              thinkingService.setSendCallback(conversationId, null);
            }

            inlineTransition = chunk.transition;

            // Reset fullReply - target crew's response will follow
            fullReply = '';
          }

          // Handle updated crew info (after pre-transfer transition)
          if (chunk.type === 'crew_info' && chunk.crew) {
            currentCrewName = chunk.crew.name;
            currentCrewDisplayName = chunk.crew.displayName;
          }

          // Send the chunk FIRST (including crew_info which triggers CREW_TRANSITION)
          sendSSE(chunk);

          // If there's a pending transition, add and send thinking step AFTER crew_info
          // This ensures it arrives AFTER client processes CREW_TRANSITION
          if (chunk.type === 'crew_info' && inlineTransition) {
            const transitionDescription = `Transitioning to: ${currentCrewDisplayName} - ${inlineTransition.reason}`;

            // Add to DB (callback was cleared earlier, so this won't auto-send)
            thinkingService.addStep(
              conversationId,
              'crew_transition',
              transitionDescription,
              inlineTransition
            );

            // Send via SSE manually
            sendSSE({
              type: 'thinking_step',
              step: {
                stepType: 'crew_transition',
                description: transitionDescription,
                stepOrder: 0,
                metadata: inlineTransition
              }
            });

            // Set the SSE callback for subsequent thinking steps from second crew
            thinkingService.setSendCallback(conversationId, sendSSE);

            // Clear inlineTransition after sending to prevent duplicate sends
            inlineTransition = null;
          }
        } else {
          fullReply += chunk;
          sendSSE({ chunk });
        }
      }

      // Handle post-response (check for transitions) - skip if pre-transfer already happened
      let transition = inlineTransition;
      if (!inlineTransition) {
        transition = await dispatcherService.handlePostResponse({
          agentName: agentNameToUse,
          conversationId,
          message,
          response: fullReply,
          currentCrewName
        });

        // Send transition info to client if transition occurred (handlePostResponse path)
        if (transition) {
          const transitionDescription = `Transitioning to: ${transition.to} - ${transition.reason}`;

          // Clear callback to prevent addStep from auto-sending (we'll send manually)
          thinkingService.setSendCallback(conversationId, null);

          // Add thinking step to DB (won't auto-send because callback is cleared)
          thinkingService.addStep(
            conversationId,
            'crew_transition',
            transitionDescription,
            transition
          );

          // Send crew_transition event FIRST so client creates the new message
          sendSSE({ type: 'crew_transition', transition });

          // Then send thinking_step event so it attaches to the new message
          sendSSE({
            type: 'thinking_step',
            step: {
              stepType: 'crew_transition',
              description: transitionDescription,
              stepOrder: 0,
              metadata: transition
            }
          });

          // Restore callback for any subsequent events
          thinkingService.setSendCallback(conversationId, sendSSE);
        }
      }

      // Save assistant response with crew metadata
      if (fullReply) {
        const messageMetadata = {
          crewMember: currentCrewDisplayName || currentCrewName,
          ...(transition && {
            transitionTo: transition.to,
            transitionReason: transition.reason
          })
        };

        const assistantMessage = await conversationService.saveAssistantMessage(
          conversationId,
          fullReply,
          messageMetadata
        );
        thinkingService.setMessageId(conversationId, assistantMessage.id);
        // Send message_saved event so client can get dbId for feedback
        sendSSE({ type: 'message_saved', messageId: assistantMessage.id });
      }

    } else {
      // ========== LEGACY NON-CREW ROUTING ==========
      // Add KB access step if using knowledge base
      if (useKnowledgeBase && agentConfig.vectorStoreId) {
        thinkingService.addKnowledgeBaseStep(conversationId, agentConfig.vectorStoreId);
      }

      // Stream the response and accumulate full reply with agent-specific config
      for await (const chunk of llmService.sendMessageStream(message, conversationId, useKnowledgeBase, agentConfig)) {
        // Check if chunk is a function call event (object) or text (string)
        if (typeof chunk === 'object' && chunk.type) {
          // Handle function call - add thinking step
          if (chunk.type === 'function_call') {
            const funcName = chunk.name.replace(/^call_/, '');
            let description = `Calling function: ${funcName}`;

            // Custom descriptions for known functions
            if (funcName === 'report_symptom' && chunk.params?.symptom_name) {
              description = `Tracked symptom: "${chunk.params.symptom_name}"`;
            }

            thinkingService.addFunctionCallStep(
              conversationId,
              funcName,
              chunk.params,
              description
            );
          }

          // Send function call events as special SSE messages
          sendSSE(chunk);
        } else {
          // Text chunk - accumulate and send
          fullReply += chunk;
          sendSSE({ chunk });
        }
      }

      // Save assistant response to database first, then save thinking steps with its ID
      if (fullReply) {
        const assistantMessage = await conversationService.saveAssistantMessage(conversationId, fullReply);
        // Update thinking context with assistant message ID before saving
        thinkingService.setMessageId(conversationId, assistantMessage.id);
        // Send message_saved event so client can get dbId for feedback
        sendSSE({ type: 'message_saved', messageId: assistantMessage.id });
      }
    }

    // End thinking context and save to database
    await thinkingService.endContext(conversationId);

    // Forward response to WhatsApp if user is a linked WhatsApp user
    if (fullReply && userId && userId.startsWith('wa_')) {
      const phone = userId.substring(3); // Remove 'wa_' prefix
      whatsappService.splitAndSend(phone, fullReply)
        .then(() => console.log(`📲 Forwarded web response to WhatsApp: ${phone}`))
        .catch(err => console.error(`❌ Failed to forward to WhatsApp: ${err.message}`));
    }

    // Send done signal
    res.write('data: [DONE]\n\n');
    res.flush && res.flush();
    res.end();
  } catch (err) {
    console.error('❌ Streaming Error:', err.message);
    // Clean up thinking context on error
    if (thinkingService.hasActiveContext(conversationId)) {
      await thinkingService.endContext(conversationId);
    }
    // Send error as typed event so client can display it properly
    res.write(`data: ${JSON.stringify({ type: 'stream_error', error: err.message })}\n\n`);
    res.flush && res.flush();
    res.end();
  }
});

// ========== WHATSAPP WEBHOOK ENDPOINTS ==========

// Webhook verification (Meta sends GET to verify endpoint)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }

  console.warn('⚠️ WhatsApp webhook verification failed');
  res.sendStatus(403);
});

// Webhook message receiver (Meta sends POST with incoming messages)
app.post('/webhook', (req, res) => {
  // Always respond 200 immediately — Meta requires this
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Skip status updates (delivery receipts, read receipts)
    if (!value?.messages) return;

    // Validate WABA ID
    if (entry?.id !== process.env.WHATSAPP_WABA_ID) {
      console.warn('⚠️ Ignoring message from unknown WABA:', entry?.id);
      return;
    }

    const message = value.messages[0];
    const phone = message.from;

    // Handle text messages
    if (message.type === 'text' && message.text?.body) {
      const text = message.text.body;
      console.log(`📩 WhatsApp incoming from ${phone}: "${text.substring(0, 80)}"`);

      handleIncomingMessage(phone, text, message.id)
        .catch(err => console.error('❌ WhatsApp bridge error:', err.message));
    } else {
      console.log(`ℹ️ Ignoring non-text WhatsApp message type: ${message.type} from ${phone}`);
    }
  } catch (err) {
    console.error('❌ WhatsApp webhook parse error:', err.message);
  }
});

// ========== KNOWLEDGE BASE MANAGEMENT ENDPOINTS ==========

// Create a new knowledge base (supports provider: 'openai' | 'google' | 'both')
app.post('/api/kb/create', async (req, res) => {
  try {
    const { agentName, name, description, provider = 'openai' } = req.body;

    if (!agentName || !name) {
      return res.status(400).json({ error: 'Agent name and KB name are required' });
    }
    if (!['openai', 'google', 'both'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider. Must be openai, google, or both' });
    }

    const agent = await kbService.getAgentByName(agentName);

    let vectorStoreId = null;
    let googleCorpusId = null;

    // Create OpenAI vector store if needed
    if (provider === 'openai' || provider === 'both') {
      const vectorStore = await llmService.createVectorStore(name, description);
      vectorStoreId = vectorStore.id;
    }

    // Create Google File Search Store if needed
    if (provider === 'google' || provider === 'both') {
      const store = await googleKBService.createStore(name);
      googleCorpusId = store.storeId;
    }

    const kb = await kbService.createKnowledgeBase(
      agent.id, name, description, provider, vectorStoreId, googleCorpusId
    );

    res.json({
      success: true,
      knowledgeBase: _formatKB(kb)
    });
  } catch (err) {
    console.error('❌ Error creating knowledge base:', err.message);
    res.status(500).json({ error: 'Error creating knowledge base: ' + err.message });
  }
});

// List all knowledge bases for an agent
app.get('/api/kb/list/:agentName', async (req, res) => {
  try {
    const { agentName } = req.params;
    const agent = await kbService.getAgentByName(agentName);
    const kbs = await kbService.getKnowledgeBasesByAgent(agent.id);

    // Enrich with live OpenAI file count where available
    const enrichedKBs = await Promise.all(
      kbs.map(async (kb) => {
        let fileCount = kb.fileCount;
        if (kb.vectorStoreId && (kb.provider === 'openai' || kb.provider === 'both')) {
          try {
            const vsData = await llmService.getVectorStore(kb.vectorStoreId);
            fileCount = vsData.fileCount;
          } catch {
            // Use DB count as fallback
          }
        }
        return { ..._formatKB(kb), fileCount };
      })
    );

    res.json({ knowledgeBases: enrichedKBs });
  } catch (err) {
    console.error('❌ Error listing knowledge bases:', err.message);
    res.status(500).json({ error: 'Error listing knowledge bases: ' + err.message });
  }
});

// Get files in a knowledge base
app.get('/api/kb/:kbId/files', async (req, res) => {
  try {
    const { kbId } = req.params;
    const kb = await kbService.getKnowledgeBaseById(parseInt(kbId));
    const dbFiles = await kbService.getFilesByKnowledgeBase(parseInt(kbId));

    // Optionally enrich with live OpenAI status
    let vsFiles = [];
    if (kb.vectorStoreId && (kb.provider === 'openai' || kb.provider === 'both')) {
      try {
        vsFiles = await llmService.listVectorStoreFiles(kb.vectorStoreId);
      } catch {
        // Use DB status as fallback
      }
    }

    // Per-file merge: match vsFiles with DB records by openaiFileId
    // Files with a DB record get their numeric id (deletable)
    // Files without a DB record get id: null (legacy, read-only)
    const dbFileByOpenaiId = new Map(dbFiles.filter(f => f.openaiFileId).map(f => [f.openaiFileId, f]));

    const vsFilesFormatted = vsFiles.map(vsFile => {
      const dbFile = dbFileByOpenaiId.get(vsFile.id);
      return {
        id: dbFile?.id ?? null,
        openaiFileId: vsFile.id,
        googleDocumentId: dbFile?.googleDocumentId ?? null,
        originalFileUrl: dbFile?.originalFileUrl ?? null,
        fileName: dbFile?.fileName || vsFile.fileName || vsFile.id,
        fileSize: dbFile?.fileSize ?? vsFile.fileSize ?? 0,
        fileType: dbFile?.fileType || vsFile.fileName?.split('.').pop() || 'unknown',
        tags: dbFile?.metadata?.tags || [],
        status: vsFile.status,
        createdAt: dbFile?.createdAt || (vsFile.createdAt ? new Date(vsFile.createdAt * 1000).toISOString() : null),
        updatedAt: dbFile?.updatedAt ?? null
      };
    });

    // Also include Google-only DB files (no OpenAI counterpart)
    const googleOnlyFiles = dbFiles
      .filter(f => f.googleDocumentId && !f.openaiFileId)
      .map(dbFile => ({
        id: dbFile.id,
        openaiFileId: null,
        googleDocumentId: dbFile.googleDocumentId,
        originalFileUrl: dbFile.originalFileUrl,
        fileName: dbFile.fileName,
        fileSize: dbFile.fileSize,
        fileType: dbFile.fileType,
        tags: dbFile.metadata?.tags || [],
        status: dbFile.status,
        createdAt: dbFile.createdAt,
        updatedAt: dbFile.updatedAt
      }));

    const files = [...vsFilesFormatted, ...googleOnlyFiles];

    res.json({ knowledgeBaseId: kbId, files });
  } catch (err) {
    console.error('❌ Error fetching KB files:', err.message);
    res.status(500).json({ error: 'Error fetching KB files: ' + err.message });
  }
});

// Upload file to a knowledge base (routes to correct provider(s) + GCS backup)
app.post('/api/kb/:kbId/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const { kbId } = req.params;
    const tags = req.body.tags ? JSON.parse(req.body.tags) : [];
    const { buffer, originalname, size, mimetype } = req.file;
    const fileType = originalname.split('.').pop().toLowerCase();

    console.log(`📤 Uploading file: ${originalname} (${size} bytes) to KB ${kbId}`);

    const kb = await kbService.getKnowledgeBaseById(parseInt(kbId));

    let openaiFileId = null;
    let googleDocumentId = null;
    let originalFileUrl = null;

    // Upload to OpenAI if KB uses OpenAI
    if (kb.provider === 'openai' || kb.provider === 'both') {
      const result = await llmService.addFileToVectorStore(buffer, originalname, kb.vectorStoreId);
      openaiFileId = result.fileId;
      console.log(`✅ Uploaded to OpenAI: ${openaiFileId}`);
    }

    // Upload to Google if KB uses Google
    if (kb.provider === 'google' || kb.provider === 'both') {
      const result = await googleKBService.uploadFile(kb.googleCorpusId, buffer, originalname, mimetype);
      googleDocumentId = result.documentId;
      console.log(`✅ Uploaded to Google: ${googleDocumentId}`);
    }

    // Save original to GCS for sync capability
    try {
      originalFileUrl = await storageService.uploadFile(buffer, originalname, mimetype, kbId);
    } catch (gcsErr) {
      console.warn(`⚠️ GCS backup failed (non-critical): ${gcsErr.message}`);
    }

    const dbFile = await kbService.addFile(
      parseInt(kbId),
      originalname,
      size,
      fileType,
      { openaiFileId, googleDocumentId, originalFileUrl },
      tags,
      'completed'
    );

    console.log(`✅ File upload complete - DB ID: ${dbFile.id}`);
    res.json({
      success: true,
      file: {
        id: dbFile.id,
        openaiFileId,
        googleDocumentId,
        fileName: originalname,
        fileSize: size,
        fileType,
        tags,
        status: 'completed'
      }
    });
  } catch (err) {
    console.error('❌ Upload Error:', err.message);
    res.status(500).json({ error: 'Error uploading file: ' + err.message });
  }
});

// Delete legacy file by openaiFileId (no DB record — file lives only in OpenAI VS)
app.delete('/api/kb/:kbId/files/openai/:openaiFileId', async (req, res) => {
  try {
    const { kbId, openaiFileId } = req.params;
    const kb = await kbService.getKnowledgeBaseById(parseInt(kbId));

    if (!kb.vectorStoreId) {
      return res.status(400).json({ error: 'KB has no vector store' });
    }

    await llmService.deleteVectorStoreFile(kb.vectorStoreId, openaiFileId);

    console.log(`✅ Legacy file deleted from VS: ${openaiFileId}`);
    res.json({ success: true, openaiFileId });
  } catch (err) {
    console.error('❌ Delete Error:', err.message);
    res.status(500).json({ error: 'Error deleting file: ' + err.message });
  }
});

// Delete file from knowledge base (removes from all providers it's on)
app.delete('/api/kb/:kbId/files/:fileId', async (req, res) => {
  try {
    const { kbId, fileId } = req.params;

    const kb = await kbService.getKnowledgeBaseById(parseInt(kbId));
    const file = await kbService.getFileById(parseInt(fileId));

    if (!file) {
      return res.status(404).json({ error: 'File not found in database' });
    }

    // Delete from OpenAI if applicable
    if (file.openaiFileId && kb.vectorStoreId) {
      try {
        await llmService.deleteVectorStoreFile(kb.vectorStoreId, file.openaiFileId);
      } catch (err) {
        console.warn(`⚠️ Could not delete from OpenAI: ${err.message}`);
      }
    }

    // Delete from Google if applicable
    if (file.googleDocumentId) {
      try {
        await googleKBService.deleteDocument(file.googleDocumentId);
      } catch (err) {
        console.warn(`⚠️ Could not delete from Google: ${err.message}`);
      }
    }

    // Delete from GCS if applicable
    if (file.originalFileUrl) {
      try {
        await storageService.deleteFile(file.originalFileUrl);
      } catch (err) {
        console.warn(`⚠️ Could not delete from GCS: ${err.message}`);
      }
    }

    // Delete from database
    await kbService.deleteFile(file.id);

    console.log(`✅ File deleted: ${fileId}`);
    res.json({ success: true, fileId });
  } catch (err) {
    console.error('❌ Delete Error:', err.message);
    res.status(500).json({ error: 'Error deleting file: ' + err.message });
  }
});

// Sync KB to another provider (adds the missing provider to an existing KB)
app.post('/api/kb/:kbId/sync', async (req, res) => {
  try {
    const { kbId } = req.params;
    const { targetProvider } = req.body; // 'openai' | 'google'

    if (!['openai', 'google'].includes(targetProvider)) {
      return res.status(400).json({ error: 'targetProvider must be openai or google' });
    }

    const kb = await kbService.getKnowledgeBaseById(parseInt(kbId));

    // Validate: target provider should not already be set
    if (targetProvider === 'openai' && kb.vectorStoreId) {
      return res.status(400).json({ error: 'KB already has an OpenAI vector store' });
    }
    if (targetProvider === 'google' && kb.googleCorpusId) {
      return res.status(400).json({ error: 'KB already has a Google corpus' });
    }

    const files = await kbService.getFilesByKnowledgeBase(parseInt(kbId));

    let newVectorStoreId = null;
    let newGoogleCorpusId = null;
    let syncedCount = 0;
    const errors = [];

    // Create the target provider store
    if (targetProvider === 'openai') {
      const vs = await llmService.createVectorStore(kb.name, kb.description);
      newVectorStoreId = vs.id;
    } else {
      const store = await googleKBService.createStore(kb.name);
      newGoogleCorpusId = store.storeId;
    }

    // Sync each file
    for (const file of files) {
      try {
        // Download original from GCS
        if (!file.originalFileUrl) {
          errors.push({ file: file.fileName, error: 'No original file in GCS for sync' });
          continue;
        }

        const buffer = await storageService.downloadFile(file.originalFileUrl);
        const mimeType = `application/${file.fileType}`;

        if (targetProvider === 'openai') {
          const result = await llmService.addFileToVectorStore(buffer, file.fileName, newVectorStoreId);
          await kbService.updateFileProviderIds(file.id, { openaiFileId: result.fileId });
        } else {
          const result = await googleKBService.uploadFile(newGoogleCorpusId, buffer, file.fileName, mimeType);
          await kbService.updateFileProviderIds(file.id, { googleDocumentId: result.documentId });
        }
        syncedCount++;
      } catch (err) {
        console.error(`❌ Could not sync file ${file.fileName}:`, err.message);
        errors.push({ file: file.fileName, error: err.message });
      }
    }

    // Update KB record with new provider ID and update provider to 'both'
    await kbService.updateKBProviderIds(parseInt(kbId), {
      vectorStoreId: newVectorStoreId || kb.vectorStoreId,
      googleCorpusId: newGoogleCorpusId || kb.googleCorpusId,
      provider: 'both',
      lastSyncedAt: new Date(),
    });

    const updatedKB = await kbService.getKnowledgeBaseById(parseInt(kbId));

    res.json({
      success: true,
      syncedCount,
      totalFiles: files.length,
      errors: errors.length > 0 ? errors : undefined,
      knowledgeBase: _formatKB(updatedKB)
    });
  } catch (err) {
    console.error('❌ Sync Error:', err.message);
    res.status(500).json({ error: 'Error syncing knowledge base: ' + err.message });
  }
});

// Legacy file upload endpoint (for backward compatibility)
app.post('/api/kb/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    console.log(`📤 Uploading file: ${req.file.originalname} (${req.file.size} bytes)`);
    const result = await llmService.addFileToKnowledgeBase(req.file.buffer, req.file.originalname);
    console.log(`✅ File uploaded successfully: ${result.fileId}`);
    res.json(result);
  } catch (err) {
    console.error('❌ Upload Error:', err.message);
    res.status(500).json({ error: 'Error uploading file: ' + err.message });
  }
});

/** Format a KB record for API responses */
function _formatKB(kb) {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    provider: kb.provider,
    vectorStoreId: kb.vectorStoreId,
    googleCorpusId: kb.googleCorpusId,
    syncedFromId: kb.syncedFromId,
    lastSyncedAt: kb.lastSyncedAt,
    fileCount: kb.fileCount,
    totalSize: kb.totalSize || 0,
    createdAt: kb.createdAt,
    updatedAt: kb.updatedAt
  };
}

// ========== FEEDBACK ENDPOINTS ==========

// Get all tags for an agent (for autocomplete)
app.get('/api/agents/:agentName/feedback/tags', async (req, res) => {
  const { agentName } = req.params;

  try {
    const agent = await conversationService.getAgentByName(agentName);
    const tags = await feedbackService.getTagsForAgent(agent.id);
    res.json({ agentName, tags });
  } catch (err) {
    console.error('❌ Error fetching tags:', err.message);
    res.status(500).json({ error: 'Error fetching tags: ' + err.message });
  }
});

// Search tags (autocomplete after 3 chars)
app.get('/api/agents/:agentName/feedback/tags/search', async (req, res) => {
  const { agentName } = req.params;
  const { q } = req.query;

  if (!q || q.length < 3) {
    return res.json({ tags: [] });
  }

  try {
    const agent = await conversationService.getAgentByName(agentName);
    const tags = await feedbackService.searchTags(agent.id, q);
    res.json({ tags });
  } catch (err) {
    console.error('❌ Error searching tags:', err.message);
    res.status(500).json({ error: 'Error searching tags: ' + err.message });
  }
});

// Create feedback on a message
app.post('/api/messages/:messageId/feedback', async (req, res) => {
  const { messageId } = req.params;
  const { feedbackText, tags, userId } = req.body;

  try {
    const feedback = await feedbackService.createFeedback(
      parseInt(messageId),
      feedbackText,
      tags,
      userId ? parseInt(userId) : null
    );
    console.log(`✅ Feedback created for message ${messageId}`);
    res.json({ success: true, feedback });
  } catch (err) {
    console.error('❌ Error creating feedback:', err.message);
    res.status(500).json({ error: 'Error creating feedback: ' + err.message });
  }
});

// Get feedback for a specific message
app.get('/api/messages/:messageId/feedback', async (req, res) => {
  const { messageId } = req.params;

  try {
    const feedback = await feedbackService.getFeedbackForMessage(parseInt(messageId));
    res.json({ feedback });
  } catch (err) {
    console.error('❌ Error fetching feedback:', err.message);
    res.status(500).json({ error: 'Error fetching feedback: ' + err.message });
  }
});

// Update feedback
app.patch('/api/feedback/:feedbackId', async (req, res) => {
  const { feedbackId } = req.params;
  const { feedbackText, tags } = req.body;

  try {
    const updates = {};
    if (feedbackText !== undefined) updates.feedbackText = feedbackText;
    if (tags !== undefined) updates.tags = tags;

    const feedback = await feedbackService.updateFeedback(parseInt(feedbackId), updates);
    console.log(`✅ Feedback ${feedbackId} updated`);
    res.json({ success: true, feedback });
  } catch (err) {
    console.error('❌ Error updating feedback:', err.message);
    res.status(500).json({ error: 'Error updating feedback: ' + err.message });
  }
});

// Delete feedback
app.delete('/api/feedback/:feedbackId', async (req, res) => {
  const { feedbackId } = req.params;

  try {
    await feedbackService.deleteFeedback(parseInt(feedbackId));
    console.log(`✅ Feedback ${feedbackId} deleted`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error deleting feedback:', err.message);
    res.status(500).json({ error: 'Error deleting feedback: ' + err.message });
  }
});

// Get all feedback for an agent (dashboard)
app.get('/api/agents/:agentName/feedback', async (req, res) => {
  const { agentName } = req.params;
  const { limit } = req.query;

  try {
    const feedbackList = await feedbackService.getFeedbackForAgent(
      agentName,
      limit ? parseInt(limit) : 100
    );
    res.json({ agentName, feedback: feedbackList });
  } catch (err) {
    console.error('❌ Error fetching feedback:', err.message);
    res.status(500).json({ error: 'Error fetching feedback: ' + err.message });
  }
});

// Get feedback stats for an agent (dashboard)
app.get('/api/agents/:agentName/feedback/stats', async (req, res) => {
  const { agentName } = req.params;

  try {
    const stats = await feedbackService.getFeedbackStats(agentName);
    res.json({ agentName, stats });
  } catch (err) {
    console.error('❌ Error fetching feedback stats:', err.message);
    res.status(500).json({ error: 'Error fetching feedback stats: ' + err.message });
  }
});

// ========== QUERY OPTIMIZER ENDPOINTS ==========

const slowQueryService = require('./services/slow-query.service');
const optimizationJobService = require('./services/optimization-job.service');

// List slow queries
app.get('/api/admin/slow-queries', async (req, res) => {
  try {
    const { agentName, limit, offset } = req.query;
    const rows = await slowQueryService.getSlowQueries({
      agentName,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json({ slowQueries: rows });
  } catch (err) {
    console.error('❌ Error fetching slow queries:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single slow query
app.get('/api/admin/slow-queries/:id', async (req, res) => {
  try {
    const sq = await slowQueryService.getSlowQuery(parseInt(req.params.id));
    if (!sq) return res.status(404).json({ error: 'Not found' });
    res.json({ slowQuery: sq });
  } catch (err) {
    console.error('❌ Error fetching slow query:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Analyze a slow query (EXPLAIN + Claude recommendation)
app.post('/api/admin/slow-queries/:id/analyze', async (req, res) => {
  try {
    const result = await slowQueryService.analyzeQuery(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    console.error('❌ Error analyzing slow query:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Dismiss a slow query
app.post('/api/admin/slow-queries/:id/dismiss', async (req, res) => {
  try {
    await slowQueryService.dismissQuery(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error dismissing slow query:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List optimization jobs
app.get('/api/admin/optimization-jobs', async (req, res) => {
  try {
    const { agentName, limit, offset } = req.query;
    const jobs = await optimizationJobService.listJobs({
      agentName,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json({ jobs });
  } catch (err) {
    console.error('❌ Error fetching optimization jobs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single optimization job status
app.get('/api/admin/optimization-jobs/:id', async (req, res) => {
  try {
    const job = await optimizationJobService.getJob(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json({ job });
  } catch (err) {
    console.error('❌ Error fetching optimization job:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create and execute an optimization job
app.post('/api/admin/optimization-jobs', async (req, res) => {
  try {
    const { slowQueryId, agentName, schemaName, jobType, description, sql, createdBy } = req.body;
    if (!agentName || !schemaName || !sql) {
      return res.status(400).json({ error: 'agentName, schemaName and sql are required' });
    }
    const job = await optimizationJobService.createJob({
      slowQueryId, agentName, schemaName, jobType, description, sql, createdBy,
    });
    res.status(201).json({ job });
  } catch (err) {
    console.error('❌ Error creating optimization job:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ========== ADMIN ENDPOINTS ==========

// Get all users with filters
app.get('/api/admin/users', async (req, res) => {
  try {
    const { source, tenant, subscription, search, limit, offset } = req.query;
    const filters = {
      source,
      tenant,
      subscription,
      search,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    };

    const result = await adminService.getUsers(filters);
    res.json(result);
  } catch (err) {
    console.error('❌ Error fetching users:', err.message);
    res.status(500).json({ error: 'Error fetching users: ' + err.message });
  }
});

// Get admin dashboard stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await adminService.getStats();
    res.json(stats);
  } catch (err) {
    console.error('❌ Error fetching stats:', err.message);
    res.status(500).json({ error: 'Error fetching stats: ' + err.message });
  }
});

// Get unique tenants for filter dropdown
app.get('/api/admin/tenants', async (req, res) => {
  try {
    const tenants = await adminService.getTenants();
    res.json({ tenants });
  } catch (err) {
    console.error('❌ Error fetching tenants:', err.message);
    res.status(500).json({ error: 'Error fetching tenants: ' + err.message });
  }
});

// Get single user by ID
app.get('/api/admin/users/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const user = await adminService.getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (err) {
    console.error('❌ Error fetching user:', err.message);
    res.status(500).json({ error: 'Error fetching user: ' + err.message });
  }
});

// Update user fields (inline editing)
app.patch('/api/admin/users/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const updates = req.body;

    const updated = await adminService.updateUser(userId, updates);
    res.json(updated);
  } catch (err) {
    console.error('❌ Error updating user:', err.message);
    res.status(500).json({ error: 'Error updating user: ' + err.message });
  }
});

// Create new user manually
app.post('/api/admin/users', async (req, res) => {
  try {
    const userData = req.body;
    const newUser = await adminService.createUser(userData);
    res.status(201).json(newUser);
  } catch (err) {
    console.error('❌ Error creating user:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Link WhatsApp to user
app.post('/api/admin/users/:userId/link', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const updated = await adminService.linkWhatsApp(userId, phone);
    res.json(updated);
  } catch (err) {
    console.error('❌ Error linking WhatsApp:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Unlink WhatsApp from user
app.delete('/api/admin/users/:userId/link', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const updated = await adminService.unlinkWhatsApp(userId);
    res.json(updated);
  } catch (err) {
    console.error('❌ Error unlinking WhatsApp:', err.message);
    res.status(500).json({ error: 'Error unlinking WhatsApp: ' + err.message });
  }
});

// Delete user and all their conversations/messages
app.delete('/api/admin/users/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const result = await adminService.deleteUser(userId);
    res.json(result);
  } catch (err) {
    console.error('❌ Error deleting user:', err.message);
    res.status(500).json({ error: 'Error deleting user: ' + err.message });
  }
});

// ========== TASK BOARD ENDPOINTS (Internal Tool) ==========

// Get all tasks (with optional filters)
app.get('/api/tasks', async (req, res) => {
  try {
    const { status, assignee, type, priority } = req.query;
    const filters = {};
    if (status) filters.status = status;
    if (assignee) filters.assignee = assignee;
    if (type) filters.type = type;
    if (priority) filters.priority = priority;

    const tasks = await taskService.getTasks(filters);
    res.json({ tasks });
  } catch (err) {
    console.error('❌ Error fetching tasks:', err.message);
    res.status(500).json({ error: 'Error fetching tasks: ' + err.message });
  }
});

// Create a new task
app.post('/api/tasks', async (req, res) => {
  try {
    const task = await taskService.createTask(req.body);
    res.status(201).json({ task });
  } catch (err) {
    console.error('❌ Error creating task:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Update a task
app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const task = await taskService.updateTask(parseInt(req.params.id), req.body);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json({ task });
  } catch (err) {
    console.error('❌ Error updating task:', err.message);
    res.status(500).json({ error: 'Error updating task: ' + err.message });
  }
});

// Delete a task
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await taskService.deleteTask(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error deleting task:', err.message);
    res.status(500).json({ error: 'Error deleting task: ' + err.message });
  }
});

// ─── Task Comments ───────────────────────────────────────────────────────────

// Get comments for a task
app.get('/api/tasks/:taskId/comments', async (req, res) => {
  try {
    const comments = await commentsService.getComments(parseInt(req.params.taskId));
    res.json({ comments });
  } catch (err) {
    console.error('❌ Error fetching comments:', err.message);
    res.status(500).json({ error: 'Error fetching comments: ' + err.message });
  }
});

// Add a comment to a task
app.post('/api/tasks/:taskId/comments', async (req, res) => {
  try {
    const { author, content } = req.body;
    const comment = await commentsService.addComment(parseInt(req.params.taskId), author, content);
    res.status(201).json({ comment });
  } catch (err) {
    console.error('❌ Error adding comment:', err.message);
    res.status(400).json({ error: 'Error adding comment: ' + err.message });
  }
});

// Delete a comment
app.delete('/api/tasks/:taskId/comments/:commentId', async (req, res) => {
  try {
    await commentsService.deleteComment(parseInt(req.params.commentId));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error deleting comment:', err.message);
    res.status(500).json({ error: 'Error deleting comment: ' + err.message });
  }
});

// Get all assignees
app.get('/api/assignees', async (req, res) => {
  try {
    const assignees = await taskService.getAssignees();
    res.json({ assignees });
  } catch (err) {
    console.error('❌ Error fetching assignees:', err.message);
    res.status(500).json({ error: 'Error fetching assignees: ' + err.message });
  }
});

// Add a new assignee
app.post('/api/assignees', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const assignee = await taskService.addAssignee(name);
    res.status(201).json({ assignee });
  } catch (err) {
    console.error('❌ Error adding assignee:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ========== DEMO MOCKUP ENDPOINTS ==========

// List all mockups
app.get('/api/demo-mockups', async (req, res) => {
  try {
    const mockups = await demoService.listMockups();
    res.json({ mockups });
  } catch (err) {
    console.error('❌ Error listing mockups:', err.message);
    res.status(500).json({ error: 'Error listing mockups: ' + err.message });
  }
});

// Get a single mockup by publicId
app.get('/api/demo-mockups/:publicId', async (req, res) => {
  try {
    const { publicId } = req.params;
    const mockup = await demoService.getMockup(publicId);

    if (!mockup) {
      return res.status(404).json({ error: 'Mockup not found' });
    }

    res.json({ mockup });
  } catch (err) {
    console.error('❌ Error getting mockup:', err.message);
    res.status(500).json({ error: 'Error getting mockup: ' + err.message });
  }
});

// Create a new mockup
app.post('/api/demo-mockups', async (req, res) => {
  try {
    const { title, viewMode, config, messages } = req.body;
    const mockup = await demoService.createMockup({ title, viewMode, config, messages });
    res.status(201).json({ success: true, mockup });
  } catch (err) {
    console.error('❌ Error creating mockup:', err.message);
    res.status(500).json({ error: 'Error creating mockup: ' + err.message });
  }
});

// Update a mockup
app.patch('/api/demo-mockups/:publicId', async (req, res) => {
  try {
    const { publicId } = req.params;
    const { title, viewMode, config, messages } = req.body;

    const mockup = await demoService.updateMockup(publicId, { title, viewMode, config, messages });

    if (!mockup) {
      return res.status(404).json({ error: 'Mockup not found' });
    }

    res.json({ mockup });
  } catch (err) {
    console.error('❌ Error updating mockup:', err.message);
    res.status(500).json({ error: 'Error updating mockup: ' + err.message });
  }
});

// Delete a mockup
app.delete('/api/demo-mockups/:publicId', async (req, res) => {
  try {
    const { publicId } = req.params;
    const deleted = await demoService.deleteMockup(publicId);

    if (!deleted) {
      return res.status(404).json({ error: 'Mockup not found' });
    }

    res.json({ success: true, message: 'Mockup deleted' });
  } catch (err) {
    console.error('❌ Error deleting mockup:', err.message);
    res.status(500).json({ error: 'Error deleting mockup: ' + err.message });
  }
});

// Parse free-text conversation using Claude
app.post('/api/demo-mockups/parse', async (req, res) => {
  try {
    const { text, language = 'en' } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const systemPrompt = `You are a conversation parser. Parse the following conversation text into a structured JSON array of messages.

OUTPUT FORMAT:
Return a JSON array where each message has:
- "id": unique string (use "msg_1", "msg_2", etc.)
- "senderName": string (detected speaker name)
- "text": string (the message content, preserve exactly)
- "side": "left" or "right" (first speaker = "right" as user, second speaker = "left" as agent, then alternate)
- "timestamp": string (formatted like "10:32 AM" or "Jan 15, 10:32 AM" if date is specified)

PARSING RULES:
1. Detect speaker names from patterns like "Name:" or "Name says:" at start of lines
2. If no clear names, use "User" and "Agent"
3. First speaker goes to "right" (user side), responses go to "left" (agent side)
4. Preserve original text exactly, including line breaks within a message
5. Language context: ${language === 'he' ? 'Hebrew (RTL text expected)' : 'English (LTR text expected)'}

DATE MARKERS:
- Look for date markers in brackets like [Monday], [Jan 15], [Yesterday], [2 days ago], [Tuesday 14:30]
- When you see a date marker, apply that date/time to subsequent messages until a new marker appears
- Date markers are NOT part of the message text - exclude them from output
- If no date markers exist, generate realistic times starting at 10:30 AM, incrementing 1-3 minutes
- For multi-day conversations, include the date in timestamp like "Jan 15, 10:32 AM"

EXAMPLE INPUT WITH DATE MARKERS:
[Monday]
John: Hello, I need help
Agent: Hi John! How can I assist you today?
[Tuesday 14:00]
John: Following up on my request
Agent: Of course! Let me check that for you.

EXAMPLE OUTPUT:
[
  {"id":"msg_1","senderName":"John","text":"Hello, I need help","side":"right","timestamp":"Mon, 10:30 AM"},
  {"id":"msg_2","senderName":"Agent","text":"Hi John! How can I assist you today?","side":"left","timestamp":"Mon, 10:31 AM"},
  {"id":"msg_3","senderName":"John","text":"Following up on my request","side":"right","timestamp":"Tue, 2:00 PM"},
  {"id":"msg_4","senderName":"Agent","text":"Of course! Let me check that for you.","side":"left","timestamp":"Tue, 2:02 PM"}
]`;

    const response = await llmService.claude.sendOneShot(systemPrompt, text, {
      jsonOutput: true,
      maxTokens: 4096
    });

    // Parse the response
    let messages;
    try {
      // Clean up potential markdown code blocks
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      messages = JSON.parse(cleanResponse);
    } catch (parseErr) {
      console.error('❌ Failed to parse Claude response:', parseErr.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to parse conversation',
        rawResponse: response
      });
    }

    res.json({ success: true, messages });
  } catch (err) {
    console.error('❌ Error parsing conversation:', err.message);
    res.status(500).json({ error: 'Error parsing conversation: ' + err.message });
  }
});

// Upload logo image for demo mockup
app.post('/api/demo-mockups/upload-logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fs = require('fs');
    const { v4: uuidv4 } = require('uuid');

    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(__dirname, 'public', 'uploads', 'demo-logos');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Generate unique filename
    const ext = path.extname(req.file.originalname) || '.png';
    const filename = `${uuidv4()}${ext}`;
    const filepath = path.join(uploadsDir, filename);

    // Write file
    fs.writeFileSync(filepath, req.file.buffer);

    // Return URL path
    const url = `/uploads/demo-logos/${filename}`;
    res.json({ success: true, url });
  } catch (err) {
    console.error('❌ Error uploading logo:', err.message);
    res.status(500).json({ error: 'Error uploading logo: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database connection
    console.log('🔄 Initializing database connection...');
    await db.initialize();
    console.log('✅ Database connected successfully');

    // Seed default assignees for task board
    await taskService.seedDefaultAssignees();

    // Start Express server
    app.listen(PORT, () => {
      console.log(`✅ Agent server running at http://localhost:${PORT}`);
      console.log(`📊 Health check available at http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    console.error('💡 The server will continue running, but database features will be unavailable');

    // Start server anyway (allows it to run without database for backward compatibility)
    app.listen(PORT, () => {
      console.log(`⚠️  Agent server running at http://localhost:${PORT} (without database)`);
    });
  }
}

startServer();
