# Aspect Agent Server

Backend server for a multi-agent AI chat system. Supports multiple AI agents (Aspect BI Assistant, Freeda Menopause Companion) with a crew-based architecture, real-time database querying, and an admin Query Optimizer.

## Overview

Express.js server providing:
- **SSE streaming chat** — real-time streaming with OpenAI GPT or Anthropic Claude models
- **Multi-provider LLM** — routes to OpenAI or Claude based on model name
- **Crew-based agent architecture** — each agent has specialized crew members
- **Prompt versioning** — debug mode for testing prompt changes
- **Knowledge Base** — RAG with file upload and vector search
- **WhatsApp integration** — bot messaging via Green API
- **PostgreSQL database** — conversations, users, prompts, KB, slow query log
- **Zer4U data querying** — natural language → SQL → PostgreSQL (real business data)
- **Query Optimizer** — admin dashboard for slow/error/timeout query monitoring & indexing

## Technology Stack

- **Node.js** — Runtime
- **Express 5** — Web framework
- **OpenAI API** — LLM provider (GPT-4o)
- **Anthropic API** — LLM provider (Claude Sonnet 4.x)
- **PostgreSQL** — Cloud SQL database
- **Google Cloud Run** — Deployment

## Project Structure

```
aspect-agent-server/
├── server.js                      # Main Express app, all endpoints
│
├── agents/                        # Agent configurations
│   ├── aspect/                    # Aspect BI Assistant
│   │   └── crew/
│   │       └── zer4u.crew.js      # Zer4U data crew (PostgreSQL access)
│   ├── freeda/                    # Freeda Menopause Companion
│   │   └── crew/
│   └── sample/                    # Sample agent template
│
├── crew/
│   ├── base/
│   │   └── CrewMember.js          # Base class for crew members
│   ├── services/
│   │   ├── crew.service.js        # Crew member loading & management
│   │   └── dispatcher.service.js  # Request routing to crew members
│   └── utils/
│       └── common-tools.js        # Shared tool definitions
│
├── services/
│   ├── llm.js                     # LLM router (OpenAI vs Claude by model name)
│   ├── llm.openai.js              # OpenAI Responses API streaming
│   ├── llm.claude.js              # Anthropic Claude streaming
│   ├── data-query.service.js      # Natural language → SQL → results
│   ├── sql-generator.service.js   # Claude-powered SQL generation
│   ├── schema-descriptor.service.js # Auto schema description (cached)
│   ├── slow-query.service.js      # Slow/error/timeout query logging + EXPLAIN
│   ├── optimization-job.service.js # Async DDL job execution (CREATE INDEX)
│   ├── thinking.service.js        # Thinking step generation (SSE)
│   ├── conversation.service.js    # Conversation CRUD
│   ├── prompt.service.js          # Prompt versioning (debug mode)
│   ├── kb.service.js              # Knowledge Base management
│   ├── feedback.service.js        # User feedback
│   ├── admin.service.js           # Admin operations
│   └── agentContext.service.js    # Agent context for prompts
│
├── db/
│   ├── migrations/                # Raw SQL migrations + runner scripts
│   └── seed.js                    # Seed data
│
├── scripts/
│   └── cloud-sql/                 # Cloud SQL utilities
│
├── deploy-cloudrun.sh             # Production deployment script
├── Dockerfile                     # Container build
├── .env                           # Development environment
└── .env.production                # Production environment (gitignored)
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

### Crew & Prompt Management (Debug Mode)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents/:agentName/crew` | List crew members |
| GET | `/api/agents/:agentName/prompts` | Get all prompts |
| GET | `/api/agents/:agentName/crew/:crewName/prompts/active` | Get active prompt |
| POST | `/api/agents/:agentName/crew/:crewName/prompts` | Create new version |
| POST | `/api/agents/:agentName/crew/:crewName/prompts/:id/activate` | Activate version |
| DELETE | `/api/agents/:agentName/crew/:crewName/prompts/:id` | Delete version |

### Knowledge Base

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/kb/list/:agentName` | List knowledge bases |
| POST | `/api/kb/create` | Create knowledge base |
| POST | `/api/kb/:kbId/upload` | Upload files |
| DELETE | `/api/kb/:kbId/files/:fileId` | Delete file |

### Admin — Query Optimizer

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/slow-queries` | List slow/error/timeout queries |
| GET | `/api/admin/slow-queries/:id` | Get single query |
| POST | `/api/admin/slow-queries/:id/analyze` | Run EXPLAIN + Claude recommendation |
| POST | `/api/admin/slow-queries/:id/dismiss` | Dismiss a query |
| GET | `/api/admin/optimization-jobs` | List optimization jobs |
| GET | `/api/admin/optimization-jobs/:id` | Get single job |
| POST | `/api/admin/optimization-jobs` | Create + execute DDL job async |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/feedback` | Submit feedback |
| GET | `/api/feedback/:agentName` | Get feedback |
| POST | `/api/whatsapp/webhook` | Green API webhook |
| GET | `/health` | Health check for Cloud Run |

## LLM Multi-Provider Architecture

`llm.js` routes to the correct provider based on model name:

```
model starts with "claude-"  →  llm.claude.js  (Anthropic API)
any other model name         →  llm.openai.js  (OpenAI Responses API)
```

**Claude format differences** (handled automatically in `llm.claude.js`):
- Message roles: Claude only accepts `user` / `assistant` (removes `system`, `tool`, `developer`)
- Tools: OpenAI `{type:"function", name:"call_X", parameters}` → Claude `{name:"X", input_schema}`

## Zer4U Data Query System

Natural language queries against real PostgreSQL business data.

**Flow:** User question → SQL Generator (Claude) → PostgreSQL → Results → LLM analysis

### Key Services

| Service | Purpose |
|---------|---------|
| `data-query.service.js` | Orchestrates question → SQL → execution → results |
| `sql-generator.service.js` | Claude-powered natural language to SQL |
| `schema-descriptor.service.js` | Auto-generates schema description (cached to disk) |
| `slow-query.service.js` | Logs slow/error/timeout queries for admin review |

### Query Timeout

Queries are killed after **15 seconds** (configurable via `QUERY_TIMEOUT_MS`):
- Killed queries are logged with `query_type = 'timeout'`
- User receives a friendly message pointing to the Query Optimizer
- Admin can analyze and create indexes to prevent recurrence

### Type Casting (Known Issue)

Zer4U schema has text/integer mismatches in join columns. The SQL generator automatically adds casts:
```sql
sales."מס.חנות SALES"::integer = stores."מס.חנות"
```
See `FIXES-TYPE-CASTING.md` for details.

## Query Optimizer (Admin Feature)

Automatic monitoring and optimization tool for database queries.

**How it works:**
1. `data-query.service.js` measures every query execution time
2. Queries > `SLOW_QUERY_THRESHOLD_MS` (5s) are logged as `slow`
3. Failed queries are logged as `error`
4. Killed queries (> `QUERY_TIMEOUT_MS` = 15s) are logged as `timeout`
5. Admin reviews in UI: `/admin/query-optimizer`
6. Click "Analyze" → runs `EXPLAIN (FORMAT JSON)` → Claude generates index recommendation
7. Click "Execute" → creates `CREATE INDEX CONCURRENTLY` as async background job

**Visible only** to agents with `database.schema` configured (currently: Aspect / Zer4U).

## Environment Variables

### Development (.env)

```bash
NODE_ENV=development
PORT=3000

# LLM Providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-20250514

# PostgreSQL (local or Cloud SQL proxy)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=agents_platform_db
DB_USER=postgres
DB_PASSWORD=...

# Query performance
SLOW_QUERY_THRESHOLD_MS=5000   # Log queries slower than 5s
QUERY_TIMEOUT_MS=15000         # Kill queries after 15s

# WhatsApp (Green API)
GREEN_API_INSTANCE_ID=...
GREEN_API_TOKEN=...
```

### Production (.env.production)

Same variables, with Cloud SQL connection. **Never commit this file.**

## Database Schema

### Application Tables

| Table | Purpose |
|-------|---------|
| `users` | Anonymous user accounts |
| `conversations` | Chat sessions |
| `messages` | Individual messages |
| `crew_prompts` | Prompt versions for debug mode |
| `knowledge_bases` | KB definitions |
| `kb_files` | Uploaded files |
| `feedback` | User feedback |

### Query Optimizer Tables (public schema)

| Table | Purpose |
|-------|---------|
| `slow_queries` | Slow/error/timeout query log with EXPLAIN recommendations |
| `optimization_jobs` | Async DDL job execution log (CREATE INDEX, etc.) |

### Migrations

Run migrations with Node runner scripts in `db/migrations/`:
```bash
node db/migrations/run-005-add-query-optimizer.js
node db/migrations/run-006-add-query-error-columns.js
```

## Crew Architecture

Each agent has specialized "crew members" that handle different topics.

### Dispatcher Flow

1. User sends message
2. Dispatcher analyzes intent
3. Routes to appropriate crew member
4. Crew member calls tools / generates response
5. Response streamed back via SSE

### Custom Crew Member (with DB access)

```javascript
// agents/myagent/crew/data.crew.js
const CrewMember = require('../../../crew/base/CrewMember');
const dataQueryService = require('../../../services/data-query.service');

class DataCrew extends CrewMember {
  constructor() {
    super({
      name: 'data',
      model: 'gpt-4o',
      tools: [{
        name: 'fetch_data',
        handler: async ({ question }) => {
          return await dataQueryService.queryByQuestion(question, 'myschema', {
            agentName: 'myagent',
          });
        }
      }]
    });
  }
}
module.exports = DataCrew;
```

## Deployment

### Google Cloud Run (Production)

```bash
cd aspect-agent-server
./deploy-cloudrun.sh
```

**Configuration:**
- Project: `aspect-agents`
- Service: `aspect-agent-server`
- Region: `europe-west1`
- Cloud SQL: `aspect-agents:europe-west1:aspect-agents-db`
- URL: https://aspect-agent-server-1018338671074.europe-west1.run.app

### Local Development

```bash
npm install
npm start
# Server runs on http://localhost:3000
```

**Cloud SQL Proxy** (for local dev with prod DB):
```bash
cloud_sql_proxy -instances=aspect-agents:europe-west1:aspect-agents-db=tcp:5432
```

## Troubleshooting

| Problem | Solution |
|---------|---------|
| Cannot connect to database | Check `DB_HOST/DB_NAME/DB_USER/DB_PASSWORD` or start Cloud SQL proxy |
| Claude API errors | Check `ANTHROPIC_API_KEY`; ensure model name starts with `claude-` |
| Streaming not working | Check CORS, verify `text/event-stream` content type |
| Query timeout immediately | Check `QUERY_TIMEOUT_MS` env var (default: 15000ms) |
| SQL type mismatch | See `FIXES-TYPE-CASTING.md` — ensure SQL generator adds `::integer` casts |

## Related Projects

- **aspect-agent-client-react** — React frontend (Firebase Hosting)
- **freeda2** — Parent project folder

## License

Proprietary — Aspect Agents
