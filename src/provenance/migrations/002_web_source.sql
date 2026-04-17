-- Henry provenance schema, migration 002.
--
-- Adds web-UI support to the invocations table:
--   - 'web' trigger type for browser-originated requests
--   - ip_hash column (SHA-256 of client IP) for rate limiting — never raw IP
--
-- Run this against your Neon database before deploying the web UI.

-- Expand the trigger check constraint to include 'web'.
ALTER TABLE invocations DROP CONSTRAINT IF EXISTS invocations_trigger_check;
ALTER TABLE invocations ADD CONSTRAINT invocations_trigger_check
  CHECK (trigger IN ('slack-slash','slack-mention','api','cli','scheduled','web'));

-- Add hashed IP column for web rate limiting.
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS ip_hash TEXT;

-- Partial index for efficient web-run history queries.
CREATE INDEX IF NOT EXISTS idx_invocations_web
  ON invocations (created_at DESC)
  WHERE trigger = 'web';

CREATE INDEX IF NOT EXISTS idx_runs_invocation_web
  ON runs (invocation_id, started_at DESC);
