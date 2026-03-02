# Task Comments Feature

**Created:** 2025-02-24
**Status:** Planned
**Priority:** Medium

---

## Overview

Add a simple comments section to tasks, visible only when viewing a task in the modal. Since we don't have user authentication, commenters must select their identity from the existing assignees list (one-time selection, persisted in localStorage).

---

## User Identity Selection

Before commenting, user must identify themselves:

1. **First time opening task board:** Show identity selector
2. **Storage:** `localStorage.setItem('aspect_commenter_identity', 'assigneeName')`
3. **Requirement:** Must be an existing assignee to comment
4. **Change identity:** Small "Not {name}?" link in comments section

### UI Location
- Small identity indicator in task board header: "Commenting as: **Shlomi**" with change option
- Or prompt when user tries to add first comment

---

## Database Schema

```sql
-- New table: task_comments
CREATE TABLE task_comments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author VARCHAR(100) NOT NULL,  -- assignee name
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_task_comments_task_id ON task_comments(task_id);
```

---

## API Endpoints

```
GET    /api/tasks/:taskId/comments     - List comments for a task
POST   /api/tasks/:taskId/comments     - Add a comment
DELETE /api/tasks/:taskId/comments/:id - Delete own comment
```

### Request/Response Examples

**POST /api/tasks/123/comments**
```json
{
  "author": "shlomi",
  "content": "This needs to wait for the API changes"
}
```

**GET /api/tasks/123/comments**
```json
{
  "comments": [
    {
      "id": 1,
      "author": "shlomi",
      "content": "This needs to wait for the API changes",
      "createdAt": "2025-02-24T10:30:00Z"
    },
    {
      "id": 2,
      "author": "kosta",
      "content": "API is ready now, we can proceed",
      "createdAt": "2025-02-24T14:15:00Z"
    }
  ]
}
```

---

## Frontend Components

### 1. CommentsSection Component
Location: `src/components/tasks/CommentsSection/`

```
CommentsSection/
  CommentsSection.tsx
  CommentsSection.module.css
```

**Features:**
- List of comments (author, time, content)
- "Add comment" textarea at bottom
- Delete button on own comments only
- Author color matches assignee color from board
- Timestamp: "2 hours ago", "Yesterday", etc.

### 2. Identity Selector
Location: `src/components/tasks/IdentitySelector/`

Simple dropdown/modal to select "Who are you?" from assignees list.

---

## TaskForm Integration

Add CommentsSection to TaskForm.tsx (only when editing existing task):

```tsx
{task && (
  <CommentsSection
    taskId={task.id}
    currentUser={commenterIdentity}
  />
)}
```

---

## Files to Create

**Server:**
- `db/schema/taskComments.js` - Drizzle schema
- `services/comments.service.js` - CRUD operations
- Add routes to `server.js`

**Client:**
- `components/tasks/CommentsSection/CommentsSection.tsx`
- `components/tasks/CommentsSection/CommentsSection.module.css`
- `components/tasks/IdentitySelector/IdentitySelector.tsx`
- `components/tasks/IdentitySelector/IdentitySelector.module.css`
- `services/commentsService.ts`
- `hooks/useCommenterIdentity.ts`

---

## UI Design (Simple)

```
┌─────────────────────────────────────┐
│ Comments (3)                        │
├─────────────────────────────────────┤
│ ● Shlomi · 2 hours ago              │
│   This needs to wait for the API    │
│                                     │
│ ● Kosta · 1 hour ago                │
│   API is ready now                  │
│                                     │
│ ● Noa · 30 min ago                  │
│   Great, moving to in progress  [x] │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ Add a comment...                │ │
│ └─────────────────────────────────┘ │
│                         [Comment]   │
└─────────────────────────────────────┘
```

---

## Implementation Order

1. **Database:** Add task_comments table
2. **Server:** Add API endpoints
3. **Client:** Create useCommenterIdentity hook
4. **Client:** Create IdentitySelector component
5. **Client:** Create CommentsSection component
6. **Client:** Integrate into TaskForm

---

## Out of Scope (Keep Simple)

- No editing comments (only delete)
- No @mentions
- No reactions/emojis
- No threading/replies
- No notifications
- No rich text in comments
