-- Lybi Gate (beta) — the data gate between a bank and Lybi.
-- A side project in aspect-agent-server/gate/: every table is gate_*, nothing
-- else in the platform reads or writes them, and no agent / crew / runtime
-- code knows they exist. One environment = one bank, so there is no agent or
-- tenant column. Safe to run twice.
--
-- Values: no raw sensitive value is ever stored on the Lybi side except in a
-- field the SIGNED policy lets through ("pass"). gate_log holds field names,
-- actions and counts — never values.

-- The field policy, versioned. At most one 'draft'; the newest 'signed' row is
-- the one inbound traffic uses. fields = [{ field, detected, by, action, isNew? }].
CREATE TABLE IF NOT EXISTS gate_policy_versions (
  id          SERIAL PRIMARY KEY,
  version     INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('draft', 'signed')),
  fields      JSONB NOT NULL DEFAULT '[]'::jsonb,
  signature   TEXT,
  signed_by   TEXT,
  signed_at   TIMESTAMP,
  created_by  TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gate_policy_versions_version ON gate_policy_versions (version);
CREATE UNIQUE INDEX IF NOT EXISTS gate_policy_versions_one_draft ON gate_policy_versions ((status)) WHERE status = 'draft';

-- Keys the bank's systems use on POST /api/gate/v1/records. The key itself is
-- shown once at creation; only its SHA-256 and a display prefix are kept.
CREATE TABLE IF NOT EXISTS gate_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE,
  created_by    TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMP,
  revoked_at    TIMESTAMP
);

-- The bank's PUBLIC key: what Lybi encrypts with. The private key never
-- reaches Lybi.
CREATE TABLE IF NOT EXISTS gate_bank_keys (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  public_key_pem  TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- The bank's APIs Lybi calls (kind 'lookup' = mid-conversation question,
-- 'handoff' = the end of the journey). send_fields = which record fields go
-- out (each by its policy action — never raw unless 'pass'). The auth secret
-- is AES-256-GCM encrypted with GATE_SECRET_KEY.
CREATE TABLE IF NOT EXISTS gate_connections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL CHECK (kind IN ('lookup', 'handoff')),
  name             TEXT NOT NULL,
  method           TEXT NOT NULL DEFAULT 'POST' CHECK (method IN ('GET', 'POST')),
  url              TEXT NOT NULL,
  send_fields      JSONB NOT NULL DEFAULT '[]'::jsonb,
  auth_header      TEXT,
  auth_secret_enc  TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_called_at   TIMESTAMP,
  last_status      TEXT,
  created_by       TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

-- Records AFTER the policy. data = { <field>: { a: action, v?, t?, enc? } }:
-- pass {v} · token {t, enc} · enc {enc} · conv {v, enc} · hide {}.
-- source: api (inbound key) · file (upload) · bank (a bank API's answer).
CREATE TABLE IF NOT EXISTS gate_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT NOT NULL CHECK (source IN ('api', 'file', 'bank')),
  external_ref    TEXT,
  key_id          UUID REFERENCES gate_keys(id) ON DELETE SET NULL,
  connection_id   UUID REFERENCES gate_connections(id) ON DELETE SET NULL,
  parent_id       UUID REFERENCES gate_records(id) ON DELETE CASCADE,
  policy_version  INTEGER,
  data            JSONB NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gate_records_created ON gate_records (created_at DESC);
CREATE INDEX IF NOT EXISTS gate_records_parent ON gate_records (parent_id);

-- Every call in and out, and every admin change. Names, actions, counts —
-- never a value.
CREATE TABLE IF NOT EXISTS gate_log (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMP NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('in', 'out', 'admin')),
  status          TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'error')),
  http_status     INTEGER,
  actor           TEXT,
  connection_id   UUID,
  record_id       UUID,
  policy_version  INTEGER,
  summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS gate_log_at ON gate_log (at DESC);

-- ── The mock bank (gate/mockBank/) ──────────────────────────────────
-- Stands in for the bank's side so the flow is real end to end: its own key
-- pair (the PRIVATE key lives only here, read only by gate/mockBank/) and
-- the hash of the secret its API expects.
CREATE TABLE IF NOT EXISTS gate_mockbank_keys (
  id                SERIAL PRIMARY KEY,
  private_key_pem   TEXT NOT NULL,
  public_key_pem    TEXT NOT NULL,
  api_secret_hash   TEXT NOT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);
