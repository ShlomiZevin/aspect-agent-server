-- Migration 031: add `repo_entries` — shared library of reusable
-- prompts (and, eventually, whole addon configs).
--
-- One table, polymorphic via `kind`. For v1 only `kind='prompt'`
-- entries are read/written by the client; the addon-repo flow will
-- reuse the same table later by writing `kind='addon'` rows whose
-- `content` carries the full AddonInstance config blob.
--
-- Built-in defaults are NOT stored here. The client synthesises seed
-- entries on every read from the live `@addons/*.addon.json` imports,
-- so updating an addon descriptor's `defaultConfig.prompt` lands for
-- every user automatically with no DB migration. This table only
-- holds entries the user actually saved.

CREATE TABLE IF NOT EXISTS repo_entries (
  id             VARCHAR(64)  PRIMARY KEY,
  kind           VARCHAR(20)  NOT NULL,
  plugin_id      VARCHAR(100) NOT NULL,
  name           TEXT         NOT NULL,
  content        JSONB        NOT NULL,
  owner_user_id  VARCHAR(64),
  created_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS repo_entries_kind_plugin_idx
  ON repo_entries (kind, plugin_id);
