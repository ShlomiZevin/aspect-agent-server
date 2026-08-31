-- 001_init.sql — the Aspect task board, in its own database.
--
-- Lives in `aspect_tasks_db`, not the platform DB. That is the whole point:
-- Shlomi asked for separation that is physical, not a filter on a shared table
-- ("i dont want rules i want different tools ... the saparation must be 100%").
-- A different database means a different connection, so there is no query that
-- could accidentally reach LYBI's board and no flag that could be set wrong.
--
-- The existing board in `agents_platform_db` stays exactly as it is and remains
-- LYBI's. Nothing here reads or writes it.
--
-- This is a rebuild, not a copy. Three things the old model got wrong are fixed
-- here, and each one caused real trouble:
--
--   * `liked_by`, `linked_tasks`, `deployed_reviewed_by` and
--     `deployed_email_sent_to` were JSONB arrays used as sets. Postgres cannot
--     index a membership test written that way, so `getWhatsNew` and
--     `needs-attention` both fetched every row and filtered in JavaScript on an
--     endpoint polled every 10 seconds per open tab. That is what hit the
--     statement timeout in production. They are real tables here.
--   * `task_comments.task_id` and `task_notifications.task_id` had a foreign
--     key with no ON DELETE, so deleting a task either failed or orphaned its
--     comments. Everything cascades from its task now.
--   * `tags` was JSONB holding a string array. A native text[] is smaller,
--     comparable, and can take a GIN index.

CREATE TABLE tasks (
  id            bigserial PRIMARY KEY,
  title         varchar(255) NOT NULL,
  description   text,
  status        varchar(20)  NOT NULL DEFAULT 'todo',
  priority      varchar(20)  NOT NULL DEFAULT 'medium',
  type          varchar(20)  NOT NULL DEFAULT 'task',
  assignee      varchar(100),
  opener        varchar(100),
  due_date      date,
  tags          text[]       NOT NULL DEFAULT '{}',
  -- Manual "this is slipping" flag. Deliberately not derived from due_date:
  -- it means a person judged it at risk, which is not the same as being late.
  at_risk       boolean      NOT NULL DEFAULT false,
  -- Acknowledged. Distinct from status='done': a 'read' task is done when it is
  -- written, and acknowledged when its assignee has actually read it.
  acknowledged  boolean      NOT NULL DEFAULT false,
  is_draft      boolean      NOT NULL DEFAULT false,
  depends_on    bigint       REFERENCES tasks(id) ON DELETE SET NULL,
  deployed_at   timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT tasks_status_valid   CHECK (status IN ('todo','in_progress','done')),
  CONSTRAINT tasks_priority_valid CHECK (priority IN ('low','medium','high','critical')),
  CONSTRAINT tasks_type_valid     CHECK (type IN ('task','bug','feature','idea','goal','agenda','read','test')),
  CONSTRAINT tasks_title_present  CHECK (btrim(title) <> ''),
  CONSTRAINT tasks_no_self_depend CHECK (depends_on IS DISTINCT FROM id)
);

-- The board's default view: open tasks, newest first. Partial, because 'done'
-- is the majority of the table and is never on screen by default.
CREATE INDEX tasks_open_idx     ON tasks (created_at DESC) WHERE status <> 'done';
CREATE INDEX tasks_assignee_idx ON tasks (assignee) WHERE status <> 'done';
CREATE INDEX tasks_deployed_idx ON tasks (deployed_at DESC) WHERE deployed_at IS NOT NULL;
CREATE INDEX tasks_tags_idx     ON tasks USING gin (tags);

-- Related tasks. Was a JSONB array of ids, which could name a task that no
-- longer exists; a real table with cascades cannot.
CREATE TABLE task_links (
  task_id        bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  linked_task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, linked_task_id),
  CONSTRAINT task_links_not_self CHECK (task_id <> linked_task_id)
);
CREATE INDEX task_links_reverse_idx ON task_links (linked_task_id);

CREATE TABLE task_comments (
  id         bigserial PRIMARY KEY,
  task_id    bigint      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     varchar(100) NOT NULL,
  body       text         NOT NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT task_comments_body_present CHECK (btrim(body) <> '')
);
CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);

-- Was `liked_by` JSONB. As a table, "who liked this" and "did X like this" are
-- both index lookups.
CREATE TABLE comment_likes (
  comment_id bigint       NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
  person     varchar(100) NOT NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, person)
);

-- Was `deployed_reviewed_by` + `deployed_email_sent_to`, two JSONB arrays that
-- meant the same shape of thing. One table, one `kind`.
--   seen    — dismissed the task from their What's New list
--   emailed — already received it in a digest
CREATE TABLE task_acks (
  task_id    bigint       NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  person     varchar(100) NOT NULL,
  kind       varchar(20)  NOT NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, person, kind),
  CONSTRAINT task_acks_kind_valid CHECK (kind IN ('seen','emailed'))
);
-- Answers "what has this person NOT seen yet" without reading the whole table.
CREATE INDEX task_acks_person_idx ON task_acks (person, kind);

CREATE TABLE notifications (
  id           bigserial PRIMARY KEY,
  recipient    varchar(100) NOT NULL,
  task_id      bigint       NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id   bigint       REFERENCES task_comments(id) ON DELETE CASCADE,
  type         varchar(50)  NOT NULL,
  is_read      boolean      NOT NULL DEFAULT false,
  is_delivered boolean      NOT NULL DEFAULT false,
  emailed_at   timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now()
);
-- The bell asks exactly this question, several times a minute.
CREATE INDEX notifications_unread_idx ON notifications (recipient, created_at DESC)
  WHERE is_read = false;

-- Who can be assigned work. `active` replaces deleting a person, which would
-- have orphaned the name already written onto old tasks and comments.
CREATE TABLE people (
  name       varchar(100) PRIMARY KEY,
  active     boolean      NOT NULL DEFAULT true,
  created_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT people_name_present CHECK (btrim(name) <> '')
);

-- Keeps `updated_at` honest without every writer having to remember it.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER task_comments_touch BEFORE UPDATE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
