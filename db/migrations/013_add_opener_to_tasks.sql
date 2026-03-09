-- Migration 013: Add opener column to tasks table
-- Stores the human-readable name of who opened/created the task (from "who you are" identity)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS opener VARCHAR(100);
