-- Aspect Management V0 (task #115): Itzik's internal tool for running Aspect's
-- own operations. Not tied to any customer, so nothing here touches a dataset
-- schema. Every table is am_-prefixed so it cannot be mistaken for platform data.
--
-- A time entry with no client is internal work ("פנימי" in the report).
-- Quote status is stored as a code; the Hebrew label belongs to the UI.
CREATE TABLE IF NOT EXISTS am_people (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  email       VARCHAR(255) NOT NULL UNIQUE,            -- always lowercase; matches the sign-in email
  role        VARCHAR(20)  NOT NULL CHECK (role IN ('owner', 'developer')),
  active      BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS am_clients (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  logo_url        TEXT,
  package_hours   NUMERIC(7,2),
  services        JSONB NOT NULL DEFAULT '[]',         -- [{ name, status }]
  next_step       TEXT,
  next_step_date  DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS am_client_notes (
  id          SERIAL PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES am_clients(id) ON DELETE CASCADE,
  person_id   INTEGER REFERENCES am_people(id) ON DELETE SET NULL,
  note_date   DATE NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS am_client_notes_client_idx ON am_client_notes (client_id, note_date DESC);

CREATE TABLE IF NOT EXISTS am_projects (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES am_clients(id),
  name          VARCHAR(200) NOT NULL,
  hours_budget  NUMERIC(8,2),
  due_date      DATE,
  status        VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
  amount        NUMERIC(12,2),                         -- carried over from a won quote
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS am_projects_client_idx ON am_projects (client_id);

CREATE TABLE IF NOT EXISTS am_time_entries (
  id           SERIAL PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES am_people(id),
  entry_date   DATE NOT NULL,
  client_id    INTEGER REFERENCES am_clients(id),
  project_id   INTEGER REFERENCES am_projects(id),
  hours        NUMERIC(4,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  description  TEXT NOT NULL,
  billable     BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS am_time_entries_person_idx  ON am_time_entries (person_id, entry_date);
CREATE INDEX IF NOT EXISTS am_time_entries_project_idx ON am_time_entries (project_id);
CREATE INDEX IF NOT EXISTS am_time_entries_client_idx  ON am_time_entries (client_id, entry_date);

CREATE TABLE IF NOT EXISTS am_blockers (
  id            SERIAL PRIMARY KEY,
  person_id     INTEGER NOT NULL REFERENCES am_people(id),
  blocker_date  DATE NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, blocker_date)
);

CREATE TABLE IF NOT EXISTS am_quotes (
  id                  SERIAL PRIMARY KEY,
  client_id           INTEGER NOT NULL REFERENCES am_clients(id),
  subject             VARCHAR(300) NOT NULL,
  amount              NUMERIC(12,2) NOT NULL DEFAULT 0,
  status              VARCHAR(20) NOT NULL DEFAULT 'preparing'
                        CHECK (status IN ('preparing', 'sent', 'pending', 'won', 'lost')),
  sent_date           DATE,
  last_followup_date  DATE,
  closed_date         DATE,
  project_id          INTEGER REFERENCES am_projects(id),  -- set by "הפוך לפרויקט"
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS am_quotes_client_idx ON am_quotes (client_id);
