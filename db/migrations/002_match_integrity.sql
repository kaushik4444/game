-- 002_match_integrity.sql: idempotent match recording and honest stats.

-- One key per game played; the server generates it when the game starts, so recording the same game twice is a no-op.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_key UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_match_key ON matches(match_key) WHERE match_key IS NOT NULL;

-- A player who left mid-game (a bot finished their seat) is kept in the record but not counted in their stats.
ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS left_early BOOLEAN NOT NULL DEFAULT FALSE;
