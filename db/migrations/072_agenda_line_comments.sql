-- Comments on agenda lines — the meeting's action items (/tasks/actions and
-- the ACTION ITEMS panel of Shlomi's center, /tasks/center).
--
-- An action-items topic is a board task (type 'agenda', tag actionsFor:<who>)
-- whose points are `- [ ]` lines in its description. Noa, Hila and Shlomi
-- comment on each line; the comments show as one more level under it.
--
-- `line_key` is the line's stable id. The server stamps it at the end of the
-- line in the description the first time someone comments on it
-- (`- [ ] a point <!-- line:3fa9c1 -->`, services/agendaLines.js), so a
-- comment stays with its line through ticks, notes, text edits and lines
-- added before it. `line_text` = the line when the comment was written: a
-- fallback match if the id is ever lost from the description.
--
-- `author` = the board identity (the name picked once per browser, the same
-- one the task board and What's New use). No auth — internal tool.
-- `updated_at` NULL = never edited.
--
-- Safe to run twice: IF NOT EXISTS everywhere.
CREATE TABLE IF NOT EXISTS agenda_line_comments (
  id          SERIAL PRIMARY KEY,
  task_id     INTEGER      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  line_key    VARCHAR(16)  NOT NULL,
  line_text   TEXT         NOT NULL,
  author      VARCHAR(100) NOT NULL,
  body        TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agenda_line_comments_task_idx
  ON agenda_line_comments (task_id, created_at);
