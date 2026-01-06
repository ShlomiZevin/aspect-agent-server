// Test script to verify streaming behavior
// This will show timestamps for when each chunk arrives

const https = require('https');

const postData = JSON.stringify({
  message: "Please write a detailed explanation about menopause, including at least 5 different symptoms, treatment options, and lifestyle changes that can help. Make this response very long and detailed.",
  conversationId: "test-streaming-" + Date.now()
});

const options = {
  hostname: 'general-dot-aspect-agents.oa.r.appspot.com',
  port: 443,
  path: '/api/finance-assistant/stream',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log('🧪 Testing streaming endpoint...');
console.log('📝 Asking for long, detailed response\n');
console.log('⏱️  Timestamps will show when each chunk arrives:\n');

const startTime = Date.now();
let chunkCount = 0;
let firstChunkTime = null;
let lastChunkTime = null;

const req = https.request(options, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  console.log(`Headers: ${JSON.stringify(res.headers, null, 2)}\n`);

  res.setEncoding('utf8');

  res.on('data', (chunk) => {
    const now = Date.now();
    const elapsed = now - startTime;

    if (!firstChunkTime) {
      firstChunkTime = now;
      console.log(`✅ FIRST chunk arrived at +${elapsed}ms\n`);
    }

    lastChunkTime = now;
    chunkCount++;

    // Show each chunk with timestamp
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.chunk) {
            process.stdout.write(data.chunk);
          }
        } catch (e) {
          // Skip invalid JSON
        }
      } else if (line === 'data: [DONE]') {
        console.log('\n\n✅ Stream complete!');
      }
    }
  });

  res.on('end', () => {
    const totalTime = lastChunkTime - startTime;
    const timeToFirst = firstChunkTime - startTime;
    const streamingTime = lastChunkTime - firstChunkTime;

    console.log('\n📊 STREAMING ANALYSIS:');
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`⏱️  Time to first chunk: ${timeToFirst}ms`);
    console.log(`📦 Total chunks received: ${chunkCount}`);
    console.log(`⏱️  Total streaming time: ${streamingTime}ms`);
    console.log(`📈 Average time between chunks: ${Math.round(streamingTime / chunkCount)}ms`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    if (chunkCount === 1) {
      console.log('❌ PROBLEM: Only 1 chunk received - response is BUFFERED!');
      console.log('   All data arrived at once instead of streaming.\n');
    } else if (streamingTime < 1000 && chunkCount > 10) {
      console.log('⚠️  WARNING: Many chunks arrived very quickly.');
      console.log('   This might indicate buffering and bulk release.\n');
    } else {
      console.log('✅ SUCCESS: Multiple chunks arrived over time - streaming works!\n');
    }
  });
});

req.on('error', (e) => {
  console.error(`❌ Request error: ${e.message}`);
});

req.write(postData);
req.end();
