// Test script to verify the AI knows it's a menopause helper
const http = require('http');

const postData = JSON.stringify({
  message: "What is your role? What are you designed to help with?",
  conversationId: "test-identity-" + Date.now()
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

console.log('🧪 Testing AI identity/role...');
console.log('📝 Question: "What is your role? What are you designed to help with?"\n');
console.log('Response:\n');

const req = http.request(options, (res) => {
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

    const lowerResponse = fullResponse.toLowerCase();

    // Check if it identifies as menopause/women's health helper
    const menopauseRelated = lowerResponse.includes('menopause') ||
                              lowerResponse.includes('women') ||
                              lowerResponse.includes('perimenopause') ||
                              lowerResponse.includes('hormonal');

    // Check if it mentions finance (wrong prompt)
    const financeRelated = lowerResponse.includes('financial') ||
                           lowerResponse.includes('finance') ||
                           lowerResponse.includes('booking');

    if (menopauseRelated && !financeRelated) {
      console.log('✅ CORRECT PROMPT! AI identifies as menopause/women\'s health helper.');
    } else if (financeRelated) {
      console.log('❌ WRONG PROMPT! AI thinks it\'s a finance/booking assistant.');
      console.log('   The OPENAI_PROMPT_ID may not be working correctly.');
    } else {
      console.log('⚠️  UNCLEAR: AI gave a generic response.');
      console.log('   Check the full response above to verify.');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });
});

req.on('error', (e) => {
  console.error(`❌ Request error: ${e.message}`);
});

req.write(postData);
req.end();
