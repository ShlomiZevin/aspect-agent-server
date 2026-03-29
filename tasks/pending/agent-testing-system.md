# Task: Agent Testing System — Automated Conversation Testing

**Domain:** `general` (infra — agent-agnostic, with domain-specific configs per agent)
**Type:** Feature
**Priority:** High

---

## Background

We need a way to automatically test our agents by simulating real conversations with synthetic users and reviewing the results. The system is a 3-step pipeline, where each step is a separate admin tool with reviewable output:

1. **Individual Generator** — Generate a population of realistic synthetic personas
2. **Conversation Simulator** — Run each persona through a conversation with the target agent
3. **Reviewer** — Evaluate each conversation against agent-specific criteria

Each step produces output that must be reviewed before feeding into the next step. This is not a one-click pipeline — it's 3 independent tools that chain together.

### Infra vs Domain-Specific

The testing infrastructure (DB table, CRUD service, execute flow, UI shell) is **agent-agnostic**. Each agent provides its own:
- **Generator prompt** — what personas look like for this domain (fields, motivations, demographics)
- **Conversation prompt** — how the synthetic user behaves
- **Review criteria** — what capabilities to score (e.g., LYBI has 26 banking-specific capabilities)

These domain-specific configs live per-agent, not in the infra.

---

## Architecture

### Data Model — `test_runs` Table

One table for all 3 steps, distinguished by `type`:

```
test_runs:
  id: serial PK
  type: 'individuals' | 'conversation' | 'review'
  agentName: varchar — target agent being tested
  status: 'pending' | 'running' | 'completed' | 'failed'
  input: jsonb — parameters for the run (motivation, count, profile, etc.)
  output: jsonb — the generated result (personas array, transcript, report)
  parentRunId: integer (nullable) — chains steps together
  error: text (nullable)
  metadata: jsonb — timing, model used, token count
  createdAt, updatedAt: timestamps
```

### Server Structure

```
aspect-agent-server/
├── services/
│   └── test-runner.service.js      # CRUD + execute logic (infra)
├── test-prompts/
│   └── {agentName}/
│       ├── individual-generator.prompt.js   # Domain-specific
│       ├── conversation-agent.prompt.js     # Domain-specific (Step 2)
│       └── reviewer.prompt.js               # Domain-specific (Step 3)
```

### Client Structure

```
aspect-react-client/src/
├── services/
│   └── testRunnerService.ts
├── types/
│   └── testRunner.ts
├── components/dashboard/
│   └── TestRunnerPage/
│       ├── TestRunnerPage.tsx          # Shell with 3 tabs
│       ├── TestRunnerPage.module.css
│       ├── IndividualsTab.tsx          # Step 1 UI
│       ├── ConversationsTab.tsx        # Step 2 UI (future)
│       └── ReviewerTab.tsx             # Step 3 UI (future)
```

### API Endpoints

```
POST   /api/admin/test-runs              — Create a run (type, agentName, input)
GET    /api/admin/test-runs              — List runs (?type=&agentName=&status=)
GET    /api/admin/test-runs/:id          — Get run with full output
DELETE /api/admin/test-runs/:id          — Delete a run
POST   /api/admin/test-runs/:id/execute  — Trigger LLM execution
```

---

## Step 1 — Individual Generator (Build First)

### What It Does

Takes a `motivation` type and `count`, calls an LLM with the domain-specific generator prompt, returns a JSON array of realistic synthetic personas.

### Input

```json
{
  "type": "individuals",
  "agentName": "banking-onboarder",
  "input": {
    "motivation": "bad_experience",
    "count": 10,
    "model": "gpt-4o"
  }
}
```

### Output

JSON array of persona objects. The schema is domain-specific — for LYBI/banking-onboarder, each persona has ~40 fields (demographics, banking status, behavioral traits, motivation, difficulty level, unique_fact, etc.). The exact schema is defined in the agent's generator prompt.

### LLM Call

Uses `sendOneShot` pattern (like ProfilerAgent). No streaming needed. Pass `jsonOutput: true`. The generator prompt is imported from `test-prompts/{agentName}/individual-generator.prompt.js`.

### UI — IndividualsTab

- Config panel: agent selector, motivation dropdown (populated from agent config), count input
- "Create Run" button → creates pending run
- "Generate" button → executes the run
- Results: expandable card/table view of generated personas
- Run history: list of past individual generation runs with status

---

## Step 2 — Conversation Simulator (Future)

Takes one persona from Step 1 output. Runs a multi-turn conversation between the synthetic user (driven by conversation prompt + persona) and the target agent (using the agent's actual chat endpoint). Stores the full transcript.

`parentRunId` links back to the individuals run.

---

## Step 3 — Reviewer (Future)

Takes a conversation transcript + persona profile. Two modes:
- `single` — per-conversation report with scored criteria
- `aggregate` — summary across all conversations for a motivation group

Review criteria are domain-specific (LYBI has 26 capabilities scored 1-10).

`parentRunId` links back to the conversation run.

---

## Out of Scope

- Automated pipeline (running all 3 steps without review)
- Scheduling / cron-based test runs
- Comparison between test runs over time (v2)
- UI for editing generator prompts (they're code files)

---

## Files Touched (Step 1)

| File | Change |
|------|--------|
| `db/schema/index.js` | Add `testRuns` table |
| `services/test-runner.service.js` | **New** — CRUD + generateIndividuals |
| `test-prompts/banking-onboarder/individual-generator.prompt.js` | **New** — LYBI generator prompt |
| `server.js` | Add `/api/admin/test-runs` endpoints |
| `src/types/testRunner.ts` | **New** — TypeScript interfaces |
| `src/services/testRunnerService.ts` | **New** — client API service |
| `src/components/dashboard/TestRunnerPage/` | **New** — dashboard page + IndividualsTab |
| `src/pages/DashboardPage.tsx` | Add route for test-runner |
| `src/components/dashboard/DashboardLayout/DashboardLayout.tsx` | Add nav item |

---

## Acceptance Criteria (Step 1)

- [ ] Admin can create an "individuals" test run by selecting agent, motivation, and count
- [ ] Executing the run calls the LLM and returns a JSON array of personas
- [ ] Each persona is realistic — varied names, demographics, behavioral traits per the generator prompt
- [ ] Output is stored in DB and reviewable in the dashboard
- [ ] Run history shows past runs with status (pending/running/completed/failed)
- [ ] Failed runs show the error message
- [ ] The generator prompt is domain-specific (lives per-agent), not hardcoded in the service
