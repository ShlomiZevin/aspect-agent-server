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

// File upload to knowledge base endpoint
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
