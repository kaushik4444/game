-- 001_init.sql: Tableverse core database schema
-- Permanent player identities, secure session token hashes, and completed match records.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core player record (independent of authentication method)
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(32) UNIQUE,
  display_name VARCHAR(32) NOT NULL,
  avatar VARCHAR(16) NOT NULL DEFAULT '🧙',
  is_anonymous BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_players_username ON players(username) WHERE username IS NOT NULL;

-- Hashed session bearer tokens for reconnects and multi-device support
CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE, -- SHA-256 hex digest of the raw bearer token
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_player ON auth_sessions(player_id);

-- Completed matches / games archive
CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code VARCHAR(12) NOT NULL,
  game_id VARCHAR(32) NOT NULL,
  seats INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  options JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_matches_game_id ON matches(game_id);
CREATE INDEX IF NOT EXISTS idx_matches_finished_at ON matches(finished_at DESC);

-- Participants and scores per match
CREATE TABLE IF NOT EXISTS match_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE SET NULL, -- Null if bot or guest
  player_name VARCHAR(32) NOT NULL,
  seat INT NOT NULL,
  score INT NOT NULL DEFAULT 0,
  is_winner BOOLEAN NOT NULL DEFAULT FALSE,
  is_bot BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_match_participants_match ON match_participants(match_id);
CREATE INDEX IF NOT EXISTS idx_match_participants_player ON match_participants(player_id) WHERE player_id IS NOT NULL;
