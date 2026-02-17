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
const thinkingService = require('./services/thinking.service');
const feedbackService = require('./services/feedback.service');
const crewService = require('./crew/services/crew.service');
const dispatcherService = require('./crew/services/dispatcher.service');
const adminService = require('./services/admin.service');
const promptService = require('./services/prompt.service');
const crewMembersService = require('./services/crewMembers.service');
const taskService = require('./services/task.service');

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
            inlineTransition = chunk.transition;
            thinkingService.addStep(
              conversationId,
              'crew_transition',
              `Transitioning to: ${chunk.transition.to} (${chunk.transition.reason})`,
              chunk.transition
            );
            // Reset fullReply - target crew's response will follow
            fullReply = '';
          }

          // Handle updated crew info (after pre-transfer transition)
          if (chunk.type === 'crew_info' && chunk.crew) {
            currentCrewName = chunk.crew.name;
            currentCrewDisplayName = chunk.crew.displayName;
          }

          sendSSE(chunk);
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

        // Send transition info to client if transition occurred
        if (transition) {
          sendSSE({ type: 'crew_transition', transition });
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
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
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

// Create a new knowledge base
app.post('/api/kb/create', async (req, res) => {
  try {
    const { agentName, name, description } = req.body;

    if (!agentName || !name) {
      return res.status(400).json({ error: 'Agent name and KB name are required' });
    }

    // Get agent by name
    const agent = await kbService.getAgentByName(agentName);

    // Create vector store in OpenAI
    const vectorStore = await llmService.createVectorStore(name, description);

    // Create KB in database
    const kb = await kbService.createKnowledgeBase(
      agent.id,
      name,
      description,
      vectorStore.id
    );

    res.json({
      success: true,
      knowledgeBase: {
        id: kb.id,
        name: kb.name,
        description: kb.description,
        vectorStoreId: kb.vectorStoreId,
        fileCount: kb.fileCount,
        createdAt: kb.createdAt
      }
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

    // Get agent by name
    const agent = await kbService.getAgentByName(agentName);

    // Get KBs from database
    const kbs = await kbService.getKnowledgeBasesByAgent(agent.id);

    // Enrich with OpenAI vector store data
    const enrichedKBs = await Promise.all(
      kbs.map(async (kb) => {
        try {
          const vsData = await llmService.getVectorStore(kb.vectorStoreId);

          return {
            id: kb.id,
            name: kb.name,
            description: kb.description,
            vectorStoreId: kb.vectorStoreId,
            fileCount: vsData.fileCount,
            totalSize: kb.totalSize || 0,
            createdAt: kb.createdAt,
            updatedAt: kb.updatedAt
          };
        } catch (err) {
          console.warn(`⚠️ Could not fetch vector store data for ${kb.vectorStoreId}`);
          return {
            id: kb.id,
            name: kb.name,
            description: kb.description,
            vectorStoreId: kb.vectorStoreId,
            fileCount: kb.fileCount,
            totalSize: kb.totalSize || 0,
            createdAt: kb.createdAt,
            updatedAt: kb.updatedAt
          };
        }
      })
    );

    res.json({
      knowledgeBases: enrichedKBs
    });
  } catch (err) {
    console.error('❌ Error listing knowledge bases:', err.message);
    res.status(500).json({ error: 'Error listing knowledge bases: ' + err.message });
  }
});

// Get files in a knowledge base
app.get('/api/kb/:kbId/files', async (req, res) => {
  try {
    const { kbId } = req.params;

    // Get KB from database
    const kb = await kbService.getKnowledgeBaseById(parseInt(kbId));

    // Get files from database
    const dbFiles = await kbService.getFilesByKnowledgeBase(parseInt(kbId));

    // Get files from OpenAI vector store
    const vsFiles = await llmService.listVectorStoreFiles(kb.vectorStoreId);

    // Merge data: DB has tags, OpenAI has latest status
    const files = dbFiles.map(dbFile => {
      const vsFile = vsFiles.find(f => f.id === dbFile.openaiFileId);
      return {
        id: dbFile.id,
        openaiFileId: dbFile.openaiFileId,
        fileName: dbFile.fileName,
        fileSize: dbFile.fileSize,
        fileType: dbFile.fileType,
        tags: dbFile.metadata?.tags || [],
        status: vsFile?.status || dbFile.status,
        createdAt: dbFile.createdAt,
        updatedAt: dbFile.updatedAt
      };
    });

    res.json({
      knowledgeBaseId: kbId,
      files
    });
  } catch (err) {
    console.error('❌ Error fetching KB files:', err.message);
    res.status(500).json({ error: 'Error fetching KB files: ' + err.message });
  }
});

// Upload file to a specific knowledge base
app.post('/api/kb/:kbId/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const { kbId } = req.params;
    const tags = req.body.tags ? JSON.parse(req.body.tags) : [];

    console.log(`📤 Uploading file: ${req.file.originalname} (${req.file.size} bytes) to KB ${kbId}`);

    // Get KB from database
    const kb = await kbService.getKnowledgeBaseById(parseInt(kbId));
    console.log(`📚 KB found: ${kb.name}, Vector Store ID: ${kb.vectorStoreId}`);

    // Upload to OpenAI vector store
    console.log(`🚀 Calling llmService.addFileToVectorStore...`);
    const result = await llmService.addFileToVectorStore(
      req.file.buffer,
      req.file.originalname,
      kb.vectorStoreId
    );
    console.log(`✅ OpenAI upload result:`, JSON.stringify(result, null, 2));

    // Get file type from extension
    const fileType = req.file.originalname.split('.').pop().toLowerCase();

    // Save to database
    console.log(`💾 Saving file to database...`);
    const dbFile = await kbService.addFile(
      parseInt(kbId),
      req.file.originalname,
      req.file.size,
      fileType,
      result.fileId,
      tags,
      'completed'
    );

    console.log(`✅ File upload complete - DB ID: ${dbFile.id}, OpenAI File ID: ${result.fileId}, Vector Store File ID: ${result.vectorStoreFileId}`);
    res.json({
      success: true,
      file: {
        id: dbFile.id,
        openaiFileId: result.fileId,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        fileType: fileType,
        tags: tags,
        status: result.status
      }
    });
  } catch (err) {
    console.error('❌ Upload Error:', err.message);
    console.error('❌ Full error:', err);
    res.status(500).json({ error: 'Error uploading file: ' + err.message });
  }
});

// Delete file from knowledge base
app.delete('/api/kb/:kbId/files/:fileId', async (req, res) => {
  try {
    const { kbId, fileId } = req.params;

    // Get KB and file from database
    const kb = await kbService.getKnowledgeBaseById(parseInt(kbId));
    const file = await kbService.getFileByOpenAIId(fileId);

    if (!file) {
      return res.status(404).json({ error: 'File not found in database' });
    }

    // Delete from OpenAI vector store
    await llmService.deleteVectorStoreFile(kb.vectorStoreId, fileId);

    // Delete from database
    await kbService.deleteFile(file.id);

    console.log(`✅ File deleted: ${fileId}`);
    res.json({
      success: true,
      fileId: fileId
    });
  } catch (err) {
    console.error('❌ Delete Error:', err.message);
    res.status(500).json({ error: 'Error deleting file: ' + err.message });
  }
});

// Legacy file upload endpoint (for backward compatibility)
app.post('/api/kb/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    console.log(`📤 Uploading file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Pass the buffer directly - OpenAI SDK will handle it
    const result = await llmService.addFileToKnowledgeBase(req.file.buffer, req.file.originalname);

    console.log(`✅ File uploaded successfully: ${result.fileId}`);
    res.json(result);
  } catch (err) {
    console.error('❌ Upload Error:', err.message);
    res.status(500).json({ error: 'Error uploading file: ' + err.message });
  }
});

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
