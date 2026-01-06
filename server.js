require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const llmService = require('./services/llm');

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
  const { message, conversationId } = req.body;

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
    for await (const chunk of llmService.sendMessageStream(message, conversationId)) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Agent running at http://localhost:${PORT}`);
});
