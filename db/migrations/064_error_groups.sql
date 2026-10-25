-- Error center (task #903, steps 5–6): what people decided about an error
-- group, and when it last alerted.
--
-- A group is (agent_slug, fingerprint) over error_events. No row = "new".
-- status: new | looking | handled | ignored. A "handled" group whose errors
-- come back after status_at reads as new again (reopened) — decided at read
-- time in builder/services/errorCenter.js, and written back when it alerts.
CREATE TABLE IF NOT EXISTS error_groups (
  agent_slug     VARCHAR(100) NOT NULL DEFAULT '',   -- '' = not tied to one agent
  fingerprint    VARCHAR(40)  NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'new',
  note           TEXT         NOT NULL DEFAULT '',
  status_by      VARCHAR(60),
  status_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_alert_at  TIMESTAMPTZ,
  PRIMARY KEY (agent_slug, fingerprint)
);
