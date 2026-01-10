// Load environment-specific .env file
const path = require('path');
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: path.join(__dirname, envFile) });
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const llmService = require('./services/llm');

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
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.post('/api/finance-assistant', async (req, res) => {
  const { message, conversationId } = req.body;

  if (!message || !conversationId) {
    return res.status(400).json({ error: 'Missing message or conversationId' });
  }

  try {
    const reply = await llmService.sendMessage(message, conversationId);
    res.json({ reply });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'Error handling message: ' + err.message });
  }
});

// Streaming endpoint
app.post('/api/finance-assistant/stream', async (req, res) => {
  const { message, conversationId, useKnowledgeBase } = req.body;

  if (!message || !conversationId) {
    return res.status(400).json({ error: 'Missing message or conversationId' });
  }

  try {
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

    // Stream the response
    for await (const chunk of llmService.sendMessageStream(message, conversationId, useKnowledgeBase)) {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      res.flush && res.flush(); // Flush after each chunk
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
app.listen(PORT, () => {
  console.log(`✅ Agent running at http://localhost:${PORT}`);
});
