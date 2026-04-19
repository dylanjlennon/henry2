-- Henry provenance schema, migration 007.
-- Adds 'email' trigger type for inbound email searches.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS invocations_trigger_check;
ALTER TABLE invocations ADD CONSTRAINT invocations_trigger_check
  CHECK (trigger IN ('slack-slash','slack-mention','api','cli','scheduled','web','email'));

CREATE INDEX IF NOT EXISTS idx_invocations_email
  ON invocations (created_at DESC)
  WHERE trigger = 'email';
