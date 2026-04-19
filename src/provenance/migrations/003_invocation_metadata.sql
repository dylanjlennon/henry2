-- Henry provenance schema, migration 003.
--
-- Adds a metadata JSONB column to invocations for passive browser signals:
--   user_agent, country, city, referer, accept_language
-- All fields are server-side only — no client JS needed.

ALTER TABLE invocations ADD COLUMN IF NOT EXISTS metadata JSONB;
