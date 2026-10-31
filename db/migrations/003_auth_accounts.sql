-- 003_auth_accounts.sql: provider-independent accounts (email/password now, OAuth later)

-- Login methods linked to a permanent player id.
CREATE TABLE IF NOT EXISTS auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  provider_user_id VARCHAR(320) NOT NULL,
  email VARCHAR(320),
  password_hash TEXT,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_identities_provider_user_unique UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_player ON auth_identities(player_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_email_unique ON auth_identities ((LOWER(email))) WHERE email IS NOT NULL;

-- Revocable sessions with expiry (NULL on old rows means legacy/non-expiring).
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_valid ON auth_sessions(token_hash) WHERE revoked_at IS NULL;

-- Email verification and password reset, single-use and expiring.
CREATE TABLE IF NOT EXISTS auth_email_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  purpose VARCHAR(32) NOT NULL,
  email VARCHAR(320) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_player ON auth_email_tokens(player_id);
CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_lookup ON auth_email_tokens(token_hash, purpose) WHERE used_at IS NULL;

-- Existing anonymous rows stay anonymous. New email accounts are created with is_anonymous=FALSE.
