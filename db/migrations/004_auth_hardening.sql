-- 004_auth_hardening.sql: usernames and shared auth rate limits

-- Usernames are permanent account handles: case-insensitive unique and validated.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_username_ci_unique
  ON players ((LOWER(username)))
  WHERE username IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'players_username_format'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_username_format
      CHECK (
        username IS NULL
        OR username ~ '^[a-z0-9_]{3,24}$'
      );
  END IF;
END $$;

-- Shared rate limiting state for auth endpoints (works across app instances).
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope VARCHAR(64) NOT NULL,
  key VARCHAR(320) NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL,
  PRIMARY KEY (scope, key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_window ON auth_rate_limits(window_start);
