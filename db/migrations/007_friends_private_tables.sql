-- 007_friends_private_tables.sql: persistent relationships and private-table invitation metadata.

CREATE TABLE IF NOT EXISTS friendships (
  player_a_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_b_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT friendships_canonical_pair CHECK (player_a_id < player_b_id),
  PRIMARY KEY (player_a_id, player_b_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_player_b ON friendships(player_b_id, created_at DESC);

CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT friend_requests_distinct_players CHECK (requester_id <> recipient_id),
  CONSTRAINT friend_requests_valid_status CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_friend_requests_pending_pair ON friend_requests(requester_id, recipient_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient_status_created ON friend_requests(recipient_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friend_requests_requester_status_created ON friend_requests(requester_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS private_table_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  invitee_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_id VARCHAR(32) NOT NULL,
  room_code VARCHAR(12) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT private_table_invitations_distinct_players CHECK (inviter_id <> invitee_id),
  CONSTRAINT private_table_invitations_valid_game CHECK (game_id IN ('wizard', 'twentynine', 'poker', 'themind')),
  CONSTRAINT private_table_invitations_valid_code CHECK (room_code ~ '^[A-Z]{6}$'),
  CONSTRAINT private_table_invitations_valid_status CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  CONSTRAINT private_table_invitations_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_private_table_invitations_pending_pair ON private_table_invitations(inviter_id, invitee_id, room_code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_private_table_invitations_invitee_status_expiry ON private_table_invitations(invitee_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_private_table_invitations_inviter_status_created ON private_table_invitations(inviter_id, status, created_at DESC);
