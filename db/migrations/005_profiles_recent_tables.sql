-- 005_profiles_recent_tables.sql: per-account recent tables (additive; no existing table or row is changed).
-- Recent tables used to live in each browser's localStorage, so they were per device and shared by every account that
-- used it. They now belong to the player and follow them across devices. Deleting the account removes them.
CREATE TABLE IF NOT EXISTS player_recent_tables (
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  room_code VARCHAR(12) NOT NULL,
  game_id VARCHAR(32) NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, room_code)
);
CREATE INDEX IF NOT EXISTS idx_player_recent_tables_recent ON player_recent_tables(player_id, last_seen_at DESC);
