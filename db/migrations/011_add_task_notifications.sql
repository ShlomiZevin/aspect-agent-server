-- Migration 011: Add task_notifications table
-- Created: 2026-03-05

CREATE TABLE IF NOT EXISTS public.task_notifications (
  id          SERIAL PRIMARY KEY,
  recipient   VARCHAR(100) NOT NULL,          -- assignee name (matches commenter identity)
  task_id     INTEGER NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  comment_id  INTEGER REFERENCES public.task_comments(id) ON DELETE CASCADE,
  type        VARCHAR(50) NOT NULL,           -- 'mention' | 'comment_on_assigned'
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_notifications_recipient ON public.task_notifications(recipient, is_read);
CREATE INDEX IF NOT EXISTS idx_task_notifications_task_id ON public.task_notifications(task_id);
