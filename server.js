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
  const { message, conversationId, userId } = req.body;

  if (!message || !conversationId) {
    return res.status(400).json({ error: 'Missing message or conversationId' });
  }

  try {
    // Save user message to database
    await conversationService.saveUserMessage(
      conversationId,
      'Freeda 2.0',
      message,
      userId || null
    );

    // Get AI response
    const reply = await llmService.sendMessage(message, conversationId);

    // Save assistant response to database
    await conversationService.saveAssistantMessage(conversationId, reply);

    res.json({ reply });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'Error handling message: ' + err.message });
  }
});

// Streaming endpoint
app.post('/api/finance-assistant/stream', async (req, res) => {
  const { message, conversationId, useKnowledgeBase, userId } = req.body;

  if (!message || !conversationId) {
    return res.status(400).json({ error: 'Missing message or conversationId' });
  }

  try {
    // Save user message to database
    await conversationService.saveUserMessage(
      conversationId,
      'Freeda 2.0',
      message,
      userId || null
    );

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

    // Stream the response and accumulate full reply
    let fullReply = '';
    for await (const chunk of llmService.sendMessageStream(message, conversationId, useKnowledgeBase)) {
      fullReply += chunk;
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      res.flush && res.flush(); // Flush after each chunk
    }

    // Save assistant response to database
    if (fullReply) {
      await conversationService.saveAssistantMessage(conversationId, fullReply);
    }

    // Send done signal
    res.write('data: [DONE]\n\n');
    res.flush && res.flush();
    res.end();
  } catch (err) {
    console.error('❌ Streaming Error:', err.message);
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
