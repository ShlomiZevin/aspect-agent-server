// Test script to verify the menopause prompt is working
const https = require('http');

const postData = JSON.stringify({
  message: "Hi, I'm experiencing hot flashes. Can you help?",
  conversationId: "test-prompt-" + Date.now()
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/finance-assistant/stream',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log('🧪 Testing menopause prompt locally...');
console.log('📝 Question: "Hi, I\'m experiencing hot flashes. Can you help?"\n');
console.log('Response:\n');

const req = https.request(options, (res) => {
  res.setEncoding('utf8');

  let fullResponse = '';

  res.on('data', (chunk) => {
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.chunk) {
            process.stdout.write(data.chunk);
            fullResponse += data.chunk;
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  });

  res.on('end', () => {
    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Check if response mentions menopause-related topics
    const menopauseKeywords = ['menopause', 'hot flash', 'hormone', 'symptom', 'estrogen'];
    const foundKeywords = menopauseKeywords.filter(keyword =>
      fullResponse.toLowerCase().includes(keyword)
    );

    if (foundKeywords.length > 0) {
      console.log('✅ PROMPT WORKING! Detected menopause-related response.');
      console.log('   Found keywords:', foundKeywords.join(', '));
    } else {
      console.log('⚠️  WARNING: Response doesn\'t seem menopause-focused.');
      console.log('   Check if prompt is configured correctly.');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });
});

req.on('error', (e) => {
  console.error(`❌ Request error: ${e.message}`);
});

req.write(postData);
req.end();
