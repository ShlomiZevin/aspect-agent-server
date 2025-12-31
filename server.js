require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const cors = require('cors');

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
        'https://primyo.io',
        'https://boostmind-b052c.web.app'
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID;

const headers = { headers: { 'OpenAI-Beta': 'assistants=v2' } };

// 🧠 In-memory conversation → threadId map
const conversationThreads = new Map();

app.post('/api/finance-assistant', async (req, res) => {
  const { message, conversationId } = req.body;

  if (!message || !conversationId) {
    return res.status(400).json({ error: 'Missing message or conversationId' });
  }

  try {
    let threadId;

    if (conversationThreads.has(conversationId)) {
      threadId = conversationThreads.get(conversationId);
    } else {
      const thread = await openai.beta.threads.create({}, headers);
      threadId = thread.id;
      conversationThreads.set(conversationId, threadId);
    }

    // Add message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: message
    }, headers);

    // Run assistant
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: ASSISTANT_ID
    }, headers);

    // Poll run status
    for (let i = 0; i < 100; i++) {
      const status = await openai.beta.threads.runs.retrieve(threadId, run.id, headers);
      if (status.status === 'completed') break;
      if (status.status === 'failed') throw new Error('Assistant run failed');
      await new Promise(r => setTimeout(r, 50));
    }

    // Get reply
    const messages = await openai.beta.threads.messages.list(threadId, {
      order: 'desc',
      limit: 1
    }, headers);

    const reply = messages.data[0].content
      .filter(item => item.type === 'text')
      .map(item => item.text.value)
      .join('\n');

    res.json({ reply });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'error handling message' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ BoostMind Booking Agent running at http://localhost:${PORT}`);
});
