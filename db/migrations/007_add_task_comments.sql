-- Migration 007: Add task_comments table
-- Created: 2026-02-24

CREATE TABLE IF NOT EXISTS public.task_comments (
  id          SERIAL PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  author      VARCHAR(100) NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON public.task_comments(task_id);
