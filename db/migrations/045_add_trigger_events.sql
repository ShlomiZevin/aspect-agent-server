-- Migration 045: trigger events + trigger status, for Builder V2 Triggers.
--
-- See docs/guides/BUILDER_V2_TRIGGERS.md.
--
-- TWO tables, deliberately shaped very differently, because they answer
-- two different questions and have two different growth curves.
--
-- ── trigger_events — "what did it actually do?" ─────────────────────
--
-- One row per (trigger x conversation x attempt). Named EVENTS and not
-- "fires" on purpose: most rows did not fire. A row is created the
-- moment a conversation MATCHES, and the `outcome` column then records
-- how far it got -- filtered out by the author's conditions, suppressed
-- by quiet hours, the crew ran and spoke, the crew ran and chose to stay
-- silent, or it threw. The non-firing rows are the ones an author
-- actually goes looking for ("it fired 40 times last night and said
-- nothing every time" is invisible if only messages are recorded), and a
-- silent attempt has no message to hang metadata off, which is the
-- concrete reason this cannot live in `messages.metadata`.
--
-- It is also the STATE. "How many times have we nudged this customer
-- since they last spoke" is not derived config -- it is history -- so it
-- is counted from these rows rather than stored in a second place that
-- could disagree. That is why there is no per-conversation schedule
-- table anywhere in this feature: a stored `next_due_at` would be
-- derived data, and changing "30 minutes" to "2 hours" would leave every
-- stored row silently wrong.
--
-- Growth is one row per real attempt, so no retention policy is needed;
-- the cascade below is what keeps it honest when a conversation is
-- deleted.
--
-- ── trigger_status — "is it alive?" ────────────────────────────────
--
-- ONE row per trigger, updated in place, never grows. This is what the
-- trigger card renders: "checked 2 min ago, found nothing, 47 quiet
-- checks in a row". Without it an author cannot tell "working, nobody is
-- quiet" from "broken", which are the same silence from the outside.
--
-- Deliberately NOT in the agent body: the body is versioned config, and
-- writing runtime state into it would leave every agent permanently
-- dirty and spawn a junk version on every tick.
--
-- Note what is NOT here: a per-evaluation log. A trigger checked every
-- minute would write ~1,440 rows a day, ~99% of them "found nothing" --
-- storage you pay for and then have to prune. The three questions it
-- would answer are already covered: "did it run" by trigger_status,
-- "what did it do" by trigger_events, and "why didn't it fire for THIS
-- conversation at 15:00" by the explainer, which recomputes the answer
-- from immutable facts and shows the arithmetic rather than a verdict.

CREATE TABLE IF NOT EXISTS trigger_events (
  id               varchar(64)  PRIMARY KEY,
  agent_id         varchar(64)  NOT NULL,
  trigger_id       varchar(64)  NOT NULL,
  trigger_type     varchar(50)  NOT NULL,
  conversation_id  integer      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  matched_at       timestamp    NOT NULL DEFAULT now(),
  -- running -> done. A row stuck on `running` means the server died
  -- mid-chain, which is itself worth being able to see.
  status           varchar(20)  NOT NULL DEFAULT 'running',
  -- filtered | quiet_hours | spoke | silent | error. NULL while running.
  -- `spoke` vs `silent` is not knowable up front: it depends on what the
  -- crew decides to do, so it is written when the chain returns.
  outcome          varchar(20),

  -- Why the trigger's own clauses matched, in the author's language:
  -- "quiet for 34 minutes".
  match_reason     text,
  -- The per-condition trail from the Filter, stored whenever the filter
  -- ran -- pass OR fail. The failing case answers "what filtered it";
  -- the passing case is the only record that a memory-dependent gate
  -- was satisfied at a moment whose memory has since changed, which the
  -- explainer cannot reconstruct later.
  filter_result    jsonb,
  -- What the crew was told. Recorded HERE precisely because it must
  -- never be recorded as a message.
  brief_used       text,

  launched_crew_id varchar(64),
  -- NULL unless outcome = 'spoke'.
  message_id       integer,
  error            text,

  started_at       timestamp,
  ended_at         timestamp,
  duration_ms      integer,
  created_at       timestamp    NOT NULL DEFAULT now()
);

-- "Why did THIS conversation get a message?" (and: how many attempts
-- since the customer last spoke -- the nudge cap rides this index.)
CREATE INDEX IF NOT EXISTS trigger_events_conversation_idx
  ON trigger_events (conversation_id, trigger_id, matched_at DESC);

-- "What did this trigger do today?"
CREATE INDEX IF NOT EXISTS trigger_events_trigger_idx
  ON trigger_events (trigger_id, matched_at DESC);

CREATE INDEX IF NOT EXISTS trigger_events_agent_idx
  ON trigger_events (agent_id, matched_at DESC);


CREATE TABLE IF NOT EXISTS trigger_status (
  trigger_id        varchar(64) PRIMARY KEY,
  agent_id          varchar(64) NOT NULL,
  last_evaluated_at timestamp,
  -- 'matched' | 'nothing' | 'error'
  last_result       varchar(20),
  last_matched      integer     NOT NULL DEFAULT 0,
  -- How many consecutive checks found nobody. Lets the card say "47
  -- quiet checks in a row" instead of just "found nothing", which is the
  -- difference between reassuring and ambiguous.
  consecutive_empty integer     NOT NULL DEFAULT 0,
  last_fired_at     timestamp,
  last_error        text,
  updated_at        timestamp   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trigger_status_agent_idx ON trigger_status (agent_id);
