-- Migration 012: Add is_delivered to task_notifications
-- Created: 2026-03-06

ALTER TABLE public.task_notifications
  ADD COLUMN IF NOT EXISTS is_delivered BOOLEAN NOT NULL DEFAULT false;

-- Update existing rows: treat already-read notifications as delivered
UPDATE public.task_notifications SET is_delivered = true WHERE is_read = true;

CREATE INDEX IF NOT EXISTS idx_task_notifications_recipient_delivered
  ON public.task_notifications(recipient, is_delivered);
