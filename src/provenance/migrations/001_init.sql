-- Henry provenance schema, migration 001.
--
-- One database, five tables, fully traceable:
--   invocations       — who asked (Slack user / API / CLI)
--   runs              — one orchestrator execution
--   fetcher_calls     — one fetcher within a run
--   http_hits         — every external HTTP request made
--   artifacts         — every file produced + its sha256

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS invocations (
  id                 UUID PRIMARY KEY,
  trigger            TEXT NOT NULL CHECK (trigger IN ('slack-slash','slack-mention','api','cli','scheduled')),
  slack_team_id      TEXT,
  slack_user_id      TEXT,
  slack_channel_id   TEXT,
  slack_channel_name TEXT,
  slack_thread_ts    TEXT,
  raw_input          TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS invocations_slack_channel_idx
  ON invocations (slack_channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id                UUID PRIMARY KEY,
  invocation_id     UUID NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  henry_version     TEXT NOT NULL,
  county            TEXT NOT NULL,
  pin               TEXT NOT NULL,
  gis_pin           TEXT NOT NULL,
  address           TEXT,
  owner_name        TEXT,
  centroid_lon      DOUBLE PRECISION,
  centroid_lat      DOUBLE PRECISION,
  deed_book         TEXT,
  deed_page         TEXT,
  plat_book         TEXT,
  plat_page         TEXT,
  resolution_source TEXT NOT NULL,
  resolution_confidence DOUBLE PRECISION NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  started_at        TIMESTAMPTZ NOT NULL,
  finished_at       TIMESTAMPTZ,
  duration_ms       INTEGER,
  fetchers_total    INTEGER NOT NULL DEFAULT 0,
  fetchers_completed INTEGER NOT NULL DEFAULT 0,
  fetchers_failed   INTEGER NOT NULL DEFAULT 0,
  fetchers_skipped  INTEGER NOT NULL DEFAULT 0,
  artifacts_produced INTEGER NOT NULL DEFAULT 0,
  http_hits         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS runs_pin_idx ON runs (county, pin, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS fetcher_calls (
  id              UUID PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  fetcher_id      TEXT NOT NULL,
  fetcher_version TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped','timeout')),
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  error           TEXT,
  data            JSONB
);

CREATE INDEX IF NOT EXISTS fetcher_calls_run_id_idx ON fetcher_calls (run_id);

CREATE TABLE IF NOT EXISTS http_hits (
  id                   UUID PRIMARY KEY,
  run_id               UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  fetcher_call_id      UUID REFERENCES fetcher_calls(id) ON DELETE CASCADE,
  method               TEXT NOT NULL,
  url                  TEXT NOT NULL,
  request_hash         TEXT NOT NULL,
  source_label         TEXT NOT NULL,
  status               INTEGER,
  response_bytes       INTEGER,
  response_sha256      TEXT,
  response_content_type TEXT,
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ NOT NULL,
  duration_ms          INTEGER NOT NULL,
  error                TEXT,
  attempt              INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS http_hits_run_id_idx ON http_hits (run_id);
CREATE INDEX IF NOT EXISTS http_hits_request_hash_idx ON http_hits (request_hash);
CREATE INDEX IF NOT EXISTS http_hits_source_label_idx ON http_hits (source_label, started_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id               UUID PRIMARY KEY,
  run_id           UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  fetcher_call_id  UUID NOT NULL REFERENCES fetcher_calls(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  source_url       TEXT,
  storage_uri      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS artifacts_run_id_idx ON artifacts (run_id);
CREATE INDEX IF NOT EXISTS artifacts_sha256_idx ON artifacts (sha256);
