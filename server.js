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
const crewService = require('./crew/services/crew.service');
const dispatcherService = require('./crew/services/dispatcher.service');

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
    methods: ['GET', 'POST', 'OPTIONS'],
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
    methods: ['GET', 'POST', 'OPTIONS'],
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

// Get all crew members for an agent
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

// Get conversation history
app.get('/api/conversation/:conversationId/history', async (req, res) => {
  const { conversationId } = req.params;
  const { limit } = req.query;

  try {
    const history = await conversationService.getConversationHistory(
      conversationId,
      limit ? parseInt(limit) : 50
    );

    res.json({
      conversationId,
      messageCount: history.length,
      messages: history
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
  const { message, conversationId, useKnowledgeBase, userId, agentName, overrideCrewMember, debug } = req.body;

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
    await conversationService.saveUserMessage(
      conversationId,
      agentNameToUse,
      message,
      userId || null
    );

    // Build agent config from config JSON (includes promptId, vectorStoreId, etc.)
    const agentConfig = agent.config || {};

    // Check if agent has crew members
    const hasCrew = await crewService.hasCrew(agentNameToUse);

    let fullReply = '';
    let currentCrewName = null;

    if (hasCrew) {
      // ========== CREW-BASED ROUTING ==========
      console.log(`🎭 Agent ${agentNameToUse} has crew members, using dispatcher`);

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
        debug
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
      }
    }

    // End thinking context and save to database
    await thinkingService.endContext(conversationId);

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

const PORT = process.env.PORT || 3000;

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database connection
    console.log('🔄 Initializing database connection...');
    await db.initialize();
    console.log('✅ Database connected successfully');

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
