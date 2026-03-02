# Task Crew Member Field

**Created:** 2026-02-25
**Status:** Planned
**Priority:** Medium

---

## Overview

Add a `crewMember` field to tasks so we can track which crew member a bug/task relates to. The field should:
- Auto-populate when reporting a bug from a message (using `message.crewMember`)
- Be editable via a dropdown showing all crew members for the agent
- Be filterable on the task board

---

## Database Schema

```sql
-- Add crew_member column to tasks table
ALTER TABLE tasks ADD COLUMN crew_member VARCHAR(100);
```

**File:** `aspect-agent-server/db/schema/index.js`
- Add `crewMember: varchar('crew_member', { length: 100 })` to tasks table

---

## Server Changes

### 1. Schema (`db/schema/index.js`)
- Add `crewMember` column to tasks table definition

### 2. Task Service (`services/task.service.js`)
- Add `crewMember` to create/update field handling (same pattern as `assignee`)
- Add `crewMember` to getTasks filter support

### 3. API Endpoints (`server.js`)
- Pass `crewMember` query param from `GET /api/tasks` to service filter
- No new endpoints needed

---

## Client Changes

### 1. Types (`src/types/task.ts`)
- Add `crewMember?: string` to `Task` interface
- Add `crewMember?: string | null` to `CreateTaskData`
- Add `crewMember?: string | null` to `UpdateTaskData`
- Add `crewMember?: string` to `TaskFilters`

### 2. AgentBugModal (`src/components/chat/AgentBugModal/AgentBugModal.tsx`)
**This is the main entry point - auto-set crew from message context.**

Current state: receives `message.crewMember` and `crewMembers[]` as props.

Changes:
- Add `crewMember` state, defaulting to `message.crewMember`
- Add crew member dropdown (populated from `crewMembers` prop) so user can change it
- Include `crewMember` in the submitted `CreateTaskData`
- Place dropdown in the existing row layout near type/priority

### 3. TaskForm (`src/components/tasks/TaskForm/TaskForm.tsx`)
**For editing crew member on any task.**

Changes:
- Add optional `crewMembers` prop (passed down from TaskBoardModal)
- Add crew member dropdown in the form (optional field, similar to assignee)
- Show dropdown only when `crewMembers` is provided and has items
- Display current crew member value even if dropdown isn't available

### 4. TaskBoardModal (`src/components/tasks/TaskBoardModal/TaskBoardModal.tsx`)
**Filtering by crew member.**

Changes:
- Add `filterCrewMember` state (`string | null`)
- Fetch crew members for current domain (reuse `crewService.getAgentCrew`)
- Add crew member filter dropdown in toolbar (row 2, next to assignee filter)
- Apply crew member filter in `filteredTasks` useMemo (client-side, same as domain/assignee)
- Pass `crewMembers` to TaskForm when editing

### 5. TaskList / TaskBoard (display)
**Low priority - optional.**

- Could show crew member badge on task cards/rows
- Not critical for first implementation

---

## Data Flow

```
Report Bug from Message:
  Message.tsx (bug button click)
    → AgentBugModal (message.crewMember auto-set)
      → createTask({ ..., crewMember: 'general' })
        → POST /api/tasks
          → DB: crew_member = 'general'

Task Board Filtering:
  TaskBoardModal
    → crewService.getAgentCrew(currentDomain)
    → filterCrewMember state
    → filteredTasks.filter(t => t.crewMember === filterCrewMember)

Edit Task:
  TaskForm (crewMembers dropdown)
    → updateTask({ crewMember: 'symptom-assessment' })
```

---

## Implementation Order

1. **DB migration** - Add `crew_member` column
2. **Server** - Update schema, service, endpoint
3. **Types** - Update Task/CreateTaskData/UpdateTaskData interfaces
4. **AgentBugModal** - Auto-set + dropdown (highest value)
5. **TaskBoardModal** - Crew member filter
6. **TaskForm** - Editable crew member field

---

## Notes

- Crew member names come from the server's crew config (`displayName`), not the internal `name`
- `message.crewMember` already contains the displayName
- The crew members list is agent-specific, so the dropdown makes sense per-domain
- When filtering "All Domains", crew filter should probably be disabled or show union of all crews
- QuickBugModal doesn't have message context, so no crew auto-set there (can be set manually later via TaskForm)
