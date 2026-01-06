#!/bin/bash
cd /c/workspace/aspect/aspect-agent-server
node server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 3

echo "Testing Responses API streaming..."
curl -N --no-buffer -X POST http://localhost:3000/api/finance-assistant \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Who are you?\",\"conversationId\":\"test-123\"}" \
  2>&1 | head -30

echo ""
echo "Killing server..."
kill $SERVER_PID 2>/dev/null || true
