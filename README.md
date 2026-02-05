# Aspect Agent Server

Backend server for multi-agent AI chat system. Supports multiple AI agents (Aspect BI Assistant, Freeda Menopause Companion) with a crew-based architecture.

## Overview

Express.js server providing:
- **SSE streaming chat** with OpenAI GPT models
- **Crew-based agent architecture** - each agent has specialized crew members
- **Prompt versioning** - debug mode for testing prompt changes
- **Knowledge Base** - RAG with file upload and vector search
- **WhatsApp integration** - bot messaging via Green API
- **PostgreSQL database** - conversations, users, prompts, KB

## Technology Stack

- **Node.js** - Runtime
- **Express 5** - Web framework
- **OpenAI API** - LLM provider (GPT-4o-mini)
- **Drizzle ORM** - Database queries
- **PostgreSQL** - Cloud SQL database
- **Google Cloud Run** - Deployment
- **Multer** - File uploads

## Project Structure

```
aspect-agent-server/
├── server.js                    # Main Express app, all endpoints
├── agents/                      # Agent configurations
│   ├── aspect/                  # Aspect BI Assistant
│   │   └── crew/                # Crew members
│   ├── freeda/                  # Freeda Menopause Companion
│   │   └── crew/
│   └── sample/                  # Sample agent template
│
├── crew/
│   ├── services/
│   │   ├── crew.service.js      # Crew member loading & management
│   │   └── dispatcher.service.js # Request routing to crew members
│   └── utils/
│       └── common-tools.js      # Shared tool definitions
│
├── services/
│   ├── llm.js                   # OpenAI chat completion
│   ├── llm.openai.js            # OpenAI streaming implementation
│   ├── db.pg.js                 # PostgreSQL connection (Drizzle)
│   ├── conversation.service.js  # Conversation CRUD
│   ├── prompt.service.js        # Prompt versioning (debug mode)
│   ├── kb.service.js            # Knowledge Base management
│   ├── thinking.service.js      # Thinking step generation
│   ├── feedback.service.js      # User feedback
│   ├── admin.service.js         # Admin operations
│   ├── agentContext.service.js  # Agent context for prompts
│   └── function-registry.js     # Function calling registry
│
├── functions/
│   └── symptom-tracker.js       # Freeda symptom tracking function
│
├── whatsapp/
│   ├── whatsapp.service.js      # Green API integration
│   ├── bridge.service.js        # WhatsApp-to-chat bridge
│   └── user-map.service.js      # WhatsApp user mapping
│
├── db/
│   ├── schema/                  # Drizzle schema definitions
│   ├── migrations/              # Database migrations
│   └── seed.js                  # Seed data
│
├── scripts/
│   └── cloud-sql/               # Cloud SQL utilities
│
├── deploy-cloudrun.sh           # Production deployment script
├── deploy-flex.sh               # App Engine Flex (unused)
├── deploy-silent.sh             # Silent deployment
├── Dockerfile                   # Container build
├── .env                         # Development environment
└── .env.production              # Production environment
```

## API Endpoints

### Chat & Streaming

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/finance-assistant/stream` | SSE streaming chat |
| GET | `/api/conversation/:id/history` | Get conversation messages |
| GET | `/api/user/:userId/conversations` | List user conversations |
| PATCH | `/api/conversation/:id` | Update conversation title |
| DELETE | `/api/conversation/:id` | Delete conversation |

### User Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/user/create` | Create anonymous user |

### Crew Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents/:agentName/crew` | List crew members |

### Prompt Management (Debug Mode)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents/:agentName/prompts` | Get all prompts for agent |
| GET | `/api/agents/:agentName/crew/:crewName/prompts` | Get prompt versions |
| GET | `/api/agents/:agentName/crew/:crewName/prompts/active` | Get active prompt |
| POST | `/api/agents/:agentName/crew/:crewName/prompts` | Create new version |
| PATCH | `/api/agents/:agentName/crew/:crewName/prompts/:versionId` | Update version |
| POST | `/api/agents/:agentName/crew/:crewName/prompts/:versionId/activate` | Activate version |
| DELETE | `/api/agents/:agentName/crew/:crewName/prompts/:versionId` | Delete version |

### Knowledge Base

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/kb/list/:agentName` | List knowledge bases |
| GET | `/api/kb/:kbId/files` | List KB files |
| POST | `/api/kb/create` | Create knowledge base |
| POST | `/api/kb/:kbId/upload` | Upload files |
| DELETE | `/api/kb/:kbId/files/:fileId` | Delete file |

### Feedback

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/feedback` | Submit feedback |
| GET | `/api/feedback/:agentName` | Get feedback for agent |

### WhatsApp

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/whatsapp/webhook` | Green API webhook |
| POST | `/api/whatsapp/send` | Send message |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check for Cloud Run |

## Crew Architecture

Each agent has specialized "crew members" that handle different topics.

### Freeda Crew Members

| Name | Display Name | Purpose |
|------|--------------|---------|
| `welcome` | Welcome | Initial greeting and onboarding |
| `general` | Freeda - Guide | Main conversation handler |

### Crew Member Definition

```javascript
// agents/freeda/crew/welcome.crew.js
module.exports = {
  name: 'welcome',
  displayName: 'Welcome',
  description: 'Handles initial greeting',
  guidance: `You are a welcome assistant...`, // System prompt
  tools: [], // Available function tools
  routingKeywords: ['hello', 'hi', 'start'],
};
```

### Dispatcher Flow

1. User sends message
2. Dispatcher analyzes intent
3. Routes to appropriate crew member
4. Crew member generates response with its guidance prompt
5. Response streamed back to client

## Prompt Versioning (Debug Mode)

The debug panel allows testing prompt changes without modifying code:

1. **View versions** - See all prompt versions for each crew member
2. **Edit & test** - Modify prompt text, changes apply immediately (session override)
3. **Save version** - Persist changes to database
4. **Activate** - Make a version the default
5. **Delete** - Remove old versions

### Session Override

Changes made in the UI apply immediately without saving:
- Stored in browser session state
- Sent with each request as `promptOverrides`
- Reverts on page refresh

## Environment Variables

### Development (.env)

```bash
NODE_ENV=development
PORT=3000

# OpenAI
OPENAI_API_KEY=sk-...

# PostgreSQL (local or Cloud SQL proxy)
DATABASE_URL=postgresql://user:pass@localhost:5432/agents_platform_db

# WhatsApp (Green API)
GREEN_API_INSTANCE_ID=...
GREEN_API_TOKEN=...
```

### Production (.env.production)

```bash
NODE_ENV=production

# OpenAI
OPENAI_API_KEY=sk-...

# Cloud SQL (via Unix socket)
DATABASE_URL=postgresql://agent_admin:pass@/agents_platform_db?host=/cloudsql/aspect-agents:europe-west1:aspect-agents-db

# WhatsApp
GREEN_API_INSTANCE_ID=...
GREEN_API_TOKEN=...
```

## Database Schema

Using Drizzle ORM with PostgreSQL.

### Main Tables

- `users` - Anonymous user accounts
- `conversations` - Chat sessions
- `messages` - Individual messages
- `crew_prompts` - Prompt versions for debug mode
- `knowledge_bases` - KB definitions
- `kb_files` - Uploaded files
- `feedback` - User feedback

### Drizzle Commands

```bash
npm run db:generate   # Generate migrations
npm run db:migrate    # Run migrations
npm run db:push       # Push schema directly
npm run db:studio     # Open Drizzle Studio
npm run db:seed       # Seed test data
```

## Deployment

### Google Cloud Run (Production)

```bash
# Deploy to Cloud Run
./deploy-cloudrun.sh
```

This script:
1. Sets project to `aspect-agents`
2. Loads env vars from `.env.production`
3. Builds Docker container
4. Deploys to Cloud Run (europe-west1)
5. Configures Cloud SQL connection

**Configuration:**
- Project: `aspect-agents`
- Service: `aspect-agent-server`
- Region: `europe-west1`
- Cloud SQL: `aspect-agents:europe-west1:aspect-agents-db`
- Min instances: 1
- Max instances: 3
- CPU: 2, Memory: 2Gi
- Timeout: 3600s

### Service URLs

| Environment | URL |
|-------------|-----|
| Production | https://aspect-agent-server-1018338671074.europe-west1.run.app |
| Local | http://localhost:3000 |

## Local Development

```bash
# Install dependencies
npm install

# Start server
npm start

# Or with nodemon for auto-reload
npx nodemon server.js
```

### Cloud SQL Proxy (for local dev with prod DB)

```bash
# Start proxy
cloud_sql_proxy -instances=aspect-agents:europe-west1:aspect-agents-db=tcp:5432
```

## Testing

```bash
# Test streaming endpoint
node test-streaming.js

# Test prompt loading
node test-prompt.js

# Test prompt identity
node test-prompt-identity.js
```

## Key Features

### SSE Streaming

```javascript
// Client sends POST to /api/finance-assistant/stream
// Server responds with text/event-stream
// Each chunk: data: {"chunk": "text"}
// Final: data: [DONE]
```

### Function Calling

Agents can call functions defined in the function registry:

```javascript
// functions/symptom-tracker.js
register({
  name: 'report_symptom',
  description: 'Log a symptom for the user',
  parameters: { ... },
  handler: async (params, context) => { ... }
});
```

### Thinking Steps

During response generation, server sends thinking steps:

```javascript
// Sent before main response
data: {"thinkingStep": "Analyzing your question..."}
data: {"thinkingStep": "Searching knowledge base..."}
```

## CORS Configuration

### Development
```javascript
cors({ origin: '*' })
```

### Production
```javascript
const ALLOWED_ORIGINS = [
  'https://aspect-agents.firebaseapp.com',
  'https://aspect-agents.web.app',
  'https://freeda-2b4af.web.app',
  'https://freeda-2b4af.firebaseapp.com'
];
```

## Monitoring

### Logs

```bash
# View Cloud Run logs
gcloud run services logs read aspect-agent-server --region europe-west1

# Stream logs
gcloud run services logs tail aspect-agent-server --region europe-west1
```

### Health Check

```bash
curl https://aspect-agent-server-1018338671074.europe-west1.run.app/health
```

## Adding a New Agent

1. **Create agent folder**: `agents/newagent/`

2. **Create crew folder**: `agents/newagent/crew/`

3. **Add crew members**: `agents/newagent/crew/default.crew.js`
   ```javascript
   module.exports = {
     name: 'default',
     displayName: 'Default',
     guidance: `Your system prompt...`,
     tools: [],
   };
   ```

4. **Create index**: `agents/newagent/crew/index.js`
   ```javascript
   module.exports = [
     require('./default.crew'),
   ];
   ```

5. **Update client** with new agent config

## Troubleshooting

### "Cannot connect to database"
- Check `DATABASE_URL` in environment
- Ensure Cloud SQL proxy is running (local dev)
- Verify Cloud SQL instance is running

### "Streaming not working"
- Check CORS headers
- Verify `text/event-stream` content type
- Check for proxy buffering issues

### "Prompt not loading"
- Run `npm run db:push` to sync schema
- Check `crew_prompts` table
- Verify agent name matches exactly

## Related Projects

- **aspect-agent-client-react** - React frontend
- **freeda2** - Parent project folder

## License

Proprietary - Aspect Agents
