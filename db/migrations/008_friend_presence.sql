-- 008_friend_presence.sql: support indexed room invitation authorization.
CREATE INDEX IF NOT EXISTS idx_private_table_invitations_accepted_room
  ON private_table_invitations(inviter_id, room_code, game_id, invitee_id, expires_at)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS idx_friendships_player_a ON friendships(player_a_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friendships_player_b ON friendships(player_b_id, created_at DESC);
