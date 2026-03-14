# Task Board System - Complete Guide

## Overview

The Task Board is an integrated project management tool built into the Aspect platform. It provides a Kanban-style board and list view for managing development tasks, bugs, features, and ideas across different domains (agents).

**Access:** Press `Ctrl+Shift+Space` to open the task board from anywhere in the application.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Task Properties](#task-properties)
3. [Views and Filters](#views-and-filters)
4. [Draft Mode](#draft-mode)
5. [Keyboard Shortcuts](#keyboard-shortcuts)
6. [Task Dependencies](#task-dependencies)
7. [At Risk Flagging](#at-risk-flagging)
8. [Completion Workflow](#completion-workflow)
9. [Assignee Management](#assignee-management)
10. [Domain Filtering](#domain-filtering)
11. [Quick Bug Reporting](#quick-bug-reporting)
12. [API Reference](#api-reference)
13. [Database Schema](#database-schema)

---

## Core Concepts

### Task Types
- **Bug** - Issues that need fixing
- **Feature** - New functionality to implement
- **Task** - General work items
- **Idea** - Proposals or concepts for future consideration

### Task Statuses
- **Todo** - Not started yet
- **In Progress** - Currently being worked on
- **Done** - Completed (but may need PM approval)

### Priority Levels
- **Low** (Green)
- **Medium** (Yellow/Amber)
- **High** (Orange)
- **Critical** (Red)

---

## Task Properties

Every task has the following properties:

| Property | Type | Description |
|----------|------|-------------|
| `title` | String | Short description of the task (required) |
| `description` | Rich Text | Detailed description with HTML support |
| `type` | Enum | bug, feature, task, or idea |
| `status` | Enum | todo, in_progress, or done |
| `priority` | Enum | low, medium, high, or critical |
| `domain` | String | Agent/project the task belongs to (freeda, aspect, banking, byline, general) |
| `assignee` | String | Name of person assigned (nullable) |
| `dueDate` | Date | Deadline (nullable) |
| `tags` | Array | String tags for categorization |
| `dependsOn` | Integer | ID of task that must be completed first (nullable) |
| `atRisk` | Boolean | Flag for tasks at risk of missing deadline |
| `isCompleted` | Boolean | PM approval - task fully reviewed and closed |
| `isDraft` | Boolean | Draft mode - only visible to creator |
| `createdBy` | String | Browser-based user identifier (for drafts) |

---

## Views and Filters

### Board View
Kanban-style columns organized by status:
- **TODO** column (left)
- **IN PROGRESS** column (center)
- **DONE** column (right)

**Drag & drop:** Click and drag tasks between columns to change status.

### List View
Tabular view showing all task properties in a sortable table.
- Always displays left-to-right, even in RTL languages
- Clickable rows to edit tasks
- Delete button per row

### Filters

**Domain Filter:**
- Current domain only
- All domains in current group (e.g., all Lybi domains when on Freeda)
- All domains (Ctrl+Shift+A)
- General (engine-level tasks)

**Assignee Filter:**
- Click assignee chips to filter by person
- Click "All" to clear filter
- "Unassigned" button shows orphaned tasks

**Draft Filter:**
- Click "Drafts" button or press `Ctrl+Shift+L`
- Shows only your draft tasks
- Badge shows draft count

**Completion Filter:**
- "Show Completed" checkbox
- Hidden by default
- Shows tasks marked as completed by PM

---

## Draft Mode

Draft mode allows you to create tasks that only you can see until you're ready to "fire" them (publish).

### Use Cases
- Quickly log multiple bugs during testing without cluttering the board
- Create task ideas without immediate visibility
- Batch create tasks and review before publishing

### Creating Drafts

**Option 1: Set Default**
Your draft preference is stored in browser localStorage. To change:
```javascript
// In browser console
localStorage.setItem('aspect_draft_default', 'true');  // Always draft by default
localStorage.setItem('aspect_draft_default', 'false'); // Never draft by default
```

**Option 2: Per-Task Toggle**
Every task creation form has a "Save as Draft" checkbox in the footer.

### Publishing Drafts

1. Press `Ctrl+Shift+L` to open drafts view
2. Use checkboxes to select drafts to publish
3. Click "🔥 Fire X Drafts" button
4. Drafts become visible to everyone

### Visual Indicators
Draft tasks have:
- Faded appearance (60% opacity)
- Dashed border
- Diagonal stripe pattern
- Purple tint

### Important Notes
- Drafts are per-browser (uses localStorage ID, not user accounts)
- Clearing browser data will create a new identifier
- You can only see your own drafts
- Others cannot see your drafts until fired

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+Space` | Toggle task board modal |
| `Ctrl+Shift+L` | Toggle drafts view |
| `Ctrl+Shift+A` | Toggle all domains view |
| `Esc` | Close task board modal |

---

## Task Dependencies

Tasks can depend on other tasks. A dependent task should only be started after its dependency is complete.

### Creating Dependencies
1. Open task form (create or edit)
2. Click "Depends On" field
3. Start typing to search for task by title
4. Select dependency from autocomplete dropdown
5. Visual indicators:
   - 🔒 (locked) - dependency not done
   - 🔗 (linked) - dependency done

### Dependency Autocomplete
Shows:
- Task title
- Status badge (todo, in_progress, done)
- Tasks sorted by relevance

### Removing Dependencies
Click the × button next to the dependency chip.

---

## At Risk Flagging

Mark tasks that are at risk of missing their deadline or encountering blockers.

### Marking At Risk
- Hover over task card
- Click ⚠ button in top-right corner
- Button becomes visible and highlighted when active

### Visual Indicators
At-risk tasks have:
- Red-tinted background (rgba(239, 68, 68, 0.08))
- Red border (rgba(239, 68, 68, 0.4))
- Visible ⚠ icon even when not hovering

### Use Cases
- Task blocked by external dependency
- Approaching deadline with insufficient progress
- Technical difficulties encountered
- Resource constraints

---

## Completion Workflow

### Two-Stage Completion

**Stage 1: Developer Marks Done**
- Move task to "Done" column (drag & drop or edit status)
- Task appears in Done column
- ✓ button appears on hover

**Stage 2: PM Approval**
- PM reviews done tasks
- Clicks ✓ button to mark as completed
- Task gets green tint and completed badge
- Hidden by default (enable with "Show Completed")

### Rationale
Separates "developer thinks it's done" from "PM verified and approved."

---

## Assignee Management

### Default Assignees
- Shlomi
- Kosta

### Adding Assignees
1. Click + button in assignee row
2. Enter name
3. Press Enter or click "Add"
4. New assignee appears immediately

### Color Coding
Each assignee gets a unique color:
- Pure primary colors (Red, Green, Blue, Yellow, Magenta, Cyan, Orange, Black)
- Deterministic hash ensures same person always gets same color
- Color appears as:
  - Dot next to name
  - Left border on task cards
  - Corner triangle on task cards

### Orphan Tasks (Unassigned)
Tasks with no assignee are marked as "orphans":
- Gray tint
- Left border
- ? icon in corner
- "Unassigned" filter button shows count badge

---

## Domain Filtering

Tasks are organized by domain (agent/project):

### Built-in Domains
- **freeda** - Menopause wellness agent
- **aspect** - Business intelligence agent
- **banking** - Banking onboarding agent
- **byline** - Content writing agent
- **general** - Platform/engine tasks

### Domain Groups

**Lybi Group** (when on Freeda or Banking page):
- freeda
- banking

Switching domain filter while on a Lybi page shows all Lybi domains by default.

### Domain Dropdown Options
- **Current Domain** - Only tasks for the current page's domain + general
- **All Domains** - All known domains + general
- **General (Engine)** - Only platform-level tasks
- Individual domains (when "All Domains" enabled via Ctrl+Shift+A)

---

## Quick Bug Reporting

While using an agent, press the bug button to quickly report an issue.

### Bug Modal Features
- Pre-filled domain (current agent)
- Type automatically set to "Bug"
- Conversation URL auto-captured
- Source/Target crew fields for transition bugs
- Field name autocomplete
- Help guide (? button) with 3 groups:
  1. Prompting & Knowledge Issues
  2. **Transition Issues (MOST IMPORTANT)** ⚠
  3. Field Collection Issues

### Bug Types
- **Wrong Reply** - Incorrect/unclear response
- **Didn't Use KB** - Should have used knowledge base
- **Transitioned Too Early** - Moved to next crew prematurely
- **Didn't Transition** - Should have transitioned but didn't
- **Wrong Crew Transition** - Transitioned to wrong crew
- **Field Not Caught** - Failed to extract field
- **Field Falsely Caught** - Incorrectly extracted field

---

## API Reference

### Base URL
```
Development: http://localhost:3000
Production: https://aspect-server-138665194481.us-central1.run.app
```

### Endpoints

#### Get All Tasks
```http
GET /api/tasks?status=&assignee=&type=&priority=&domain=
```

**Query Parameters:**
- `status` - Filter by status (todo, in_progress, done)
- `assignee` - Filter by assignee name
- `type` - Filter by type (bug, feature, task, idea)
- `priority` - Filter by priority (low, medium, high, critical)
- `domain` - Filter by domain

**Response:**
```json
{
  "tasks": [
    {
      "id": 1,
      "title": "Fix login bug",
      "description": "<p>Users cannot log in...</p>",
      "status": "in_progress",
      "priority": "high",
      "type": "bug",
      "domain": "aspect",
      "assignee": "Kosta",
      "dueDate": "2025-02-28",
      "atRisk": false,
      "isCompleted": false,
      "dependsOn": null,
      "tags": ["urgent", "auth"],
      "isDraft": false,
      "createdBy": null,
      "createdAt": "2025-02-24T10:00:00Z",
      "updatedAt": "2025-02-24T10:00:00Z"
    }
  ]
}
```

#### Create Task
```http
POST /api/tasks
Content-Type: application/json

{
  "title": "Task title",
  "description": "Optional description",
  "type": "bug",
  "status": "todo",
  "priority": "medium",
  "domain": "freeda",
  "assignee": "Shlomi",
  "dueDate": "2025-03-01",
  "atRisk": false,
  "isCompleted": false,
  "dependsOn": null,
  "tags": ["tag1", "tag2"],
  "isDraft": false,
  "createdBy": null
}
```

**Response:**
```json
{
  "task": { /* created task object */ }
}
```

#### Update Task
```http
PATCH /api/tasks/:id
Content-Type: application/json

{
  "status": "done",
  "assignee": "Kosta"
}
```

**Response:**
```json
{
  "task": { /* updated task object */ }
}
```

#### Delete Task
```http
DELETE /api/tasks/:id
```

**Response:**
```json
{
  "success": true
}
```

#### Get All Assignees
```http
GET /api/assignees
```

**Response:**
```json
{
  "assignees": [
    { "id": 1, "name": "Shlomi", "createdAt": "2025-01-01T00:00:00Z" },
    { "id": 2, "name": "Kosta", "createdAt": "2025-01-01T00:00:00Z" }
  ]
}
```

#### Add Assignee
```http
POST /api/assignees
Content-Type: application/json

{
  "name": "Noa"
}
```

**Response:**
```json
{
  "assignee": { "id": 3, "name": "Noa", "createdAt": "2025-02-24T10:00:00Z" }
}
```

---

## Database Schema

### Tasks Table
```sql
CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'todo',
  priority VARCHAR(20) NOT NULL DEFAULT 'medium',
  type VARCHAR(20) NOT NULL DEFAULT 'feature',
  domain VARCHAR(50) NOT NULL DEFAULT 'general',
  assignee VARCHAR(100),
  due_date DATE,
  at_risk BOOLEAN NOT NULL DEFAULT FALSE,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  depends_on INTEGER,
  tags JSONB DEFAULT '[]',
  is_draft BOOLEAN NOT NULL DEFAULT FALSE,
  created_by VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tasks_draft_created_by ON tasks(is_draft, created_by);
```

### Assignees Table
```sql
CREATE TABLE task_assignees (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### Migrations

**Adding Draft Support:**
```sql
-- Run this if upgrading from earlier version
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_tasks_draft_created_by ON tasks(is_draft, created_by);
```

**Seeding Default Assignees:**
```sql
INSERT INTO task_assignees (name) VALUES ('Shlomi'), ('Kosta')
ON CONFLICT (name) DO NOTHING;
```

---

## Service Layer

**Location:** `aspect-agent-server/services/task.service.js`

### Key Methods

```javascript
// Get all tasks with optional filters
await taskService.getTasks({ status: 'todo', assignee: 'Kosta' });

// Create a task
await taskService.createTask({
  title: 'Fix bug',
  type: 'bug',
  priority: 'high',
  domain: 'freeda',
  isDraft: true,
  createdBy: 'user_123456'
});

// Update a task
await taskService.updateTask(taskId, {
  status: 'done',
  isCompleted: true
});

// Delete a task
await taskService.deleteTask(taskId);

// Get all assignees
await taskService.getAssignees();

// Add assignee
await taskService.addAssignee('Noa');

// Seed default assignees (called on server start)
await taskService.seedDefaultAssignees();
```

---

## Client Integration

### Opening the Task Board

**From any page:**
```typescript
import { useTaskBoard } from '../hooks/useTaskBoard';

function MyComponent() {
  const { isOpen, openModal, closeModal } = useTaskBoard();

  // Modal opens automatically with Ctrl+Shift+Space
  // Or programmatically:
  const handleClick = () => openModal();
}
```

### Task Board Hook

**Location:** `aspect-react-client/src/hooks/useTaskBoard.ts`

Provides:
- `isOpen` - Boolean state
- `openModal()` - Open the task board
- `closeModal()` - Close the task board
- Keyboard shortcut listener (Ctrl+Shift+Space)

### User Identifier (for Drafts)

**Location:** `aspect-react-client/src/utils/userIdentifier.ts`

```typescript
import { getUserId, getDraftDefault, setDraftDefault } from '../utils/userIdentifier';

// Get current user's browser ID
const userId = getUserId(); // e.g., "user_1234567890_abc123"

// Get draft default preference
const shouldDraft = getDraftDefault(); // boolean

// Set draft default preference
setDraftDefault(true); // or false
```

---

## Best Practices

### Task Creation
1. **Be specific in titles** - "Fix login bug" not "Bug"
2. **Use descriptions** - Provide context and steps to reproduce
3. **Set priorities accurately** - Critical means work stops without it
4. **Assign immediately** - Avoid orphan tasks when possible
5. **Add tags** - Makes filtering and searching easier

### Draft Workflow
1. **Use for bulk entry** - Log multiple bugs/ideas quickly
2. **Review before firing** - Check for duplicates and accuracy
3. **Fire in batches** - Select multiple and publish together
4. **Don't leave drafts indefinitely** - Fire within 24-48 hours

### Dependencies
1. **Use sparingly** - Too many dependencies create bottlenecks
2. **Chain correctly** - A → B → C, not circular
3. **Update when blocked** - If dependency changes, update dependents
4. **Consider splitting** - If many dependencies, task might be too big

### At Risk Flagging
1. **Flag early** - Don't wait until it's too late
2. **Add comments** - Explain why it's at risk
3. **Update status** - Remove flag when risk is mitigated
4. **Escalate** - Communicate flagged tasks to PM/team

### Completion
1. **Test thoroughly** - Don't mark done prematurely
2. **Document** - Add notes about implementation
3. **Request review** - Let PM know it's ready for approval
4. **Close dependencies** - Unblock dependent tasks

---

## Troubleshooting

### Draft tasks disappear after creation
**Cause:** Database columns not added or `created_by` not being set.

**Solution:**
1. Verify columns exist: `SELECT created_by FROM tasks LIMIT 1;`
2. If error, run migration SQL (see Database Schema section)
3. Restart server
4. Clear browser cache and reload

### Colors are the same for different assignees
**Cause:** Hash collision (rare with current algorithm).

**Solution:**
- Color assignment is deterministic and uses prime number weighting
- With 8 distinct colors and the current hash, collisions are minimal
- If collision occurs, consider renaming one assignee slightly

### Keyboard shortcuts don't work
**Cause:** Focus is on an input field or another element is capturing the event.

**Solution:**
- Click on the background/modal to remove focus from inputs
- Shortcuts work globally when modal is open
- Esc always works to close modal

### Tasks not showing in list/board
**Check:**
1. Domain filter - are you on the right domain?
2. Completion filter - is "Show Completed" unchecked?
3. Assignee filter - clear filter to see all
4. Draft filter - turn off drafts view to see non-drafts
5. Status - check all three columns in board view

### Can't drag tasks between columns
**Cause:** Task has dependencies or you're in list view.

**Solution:**
- Switch to board view
- If dependency exists, complete it first or remove dependency
- Ensure you're not in draft mode (can't drag drafts)

---

## Future Enhancements

Potential features for future development:

1. **User Authentication** - Replace browser IDs with real user accounts
2. **Comments** - Task discussion threads
3. **Attachments** - Upload screenshots/files to tasks
4. **Time Tracking** - Log hours spent on tasks
5. **Subtasks** - Break down large tasks
6. **Labels** - More structured than tags
7. **Filters Saved** - Remember user's filter preferences
8. **Notifications** - Alert when assigned or mentioned
9. **Search** - Full-text search across titles/descriptions
10. **Export** - Export tasks to CSV/JSON
11. **Templates** - Pre-filled task templates
12. **Recurring Tasks** - Auto-create periodic tasks
13. **Sprint Planning** - Group tasks into sprints
14. **Burndown Charts** - Visual progress tracking

---

## Support

For issues or questions:
- GitHub Issues: https://github.com/anthropics/claude-code/issues
- Documentation: See CLAUDE.md in project root

---

**Last Updated:** February 24, 2025
**Version:** 1.0
