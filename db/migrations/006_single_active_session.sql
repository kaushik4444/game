-- 006_single_active_session.sql: one active session per account, enforced by the database.
-- Step 1 keeps data safe: for any account that currently has several active sessions (earlier versions allowed it),
-- only the newest stays active; the others are REVOKED (never deleted). Step 2 adds the partial unique index.
-- Reverse with: DROP INDEX IF EXISTS ux_auth_sessions_one_active;  (revoked sessions stay revoked).
UPDATE auth_sessions s
   SET revoked_at = NOW()
 WHERE s.revoked_at IS NULL
   AND EXISTS (
     SELECT 1 FROM auth_sessions n
      WHERE n.player_id = s.player_id
        AND n.revoked_at IS NULL
        AND (n.created_at > s.created_at OR (n.created_at = s.created_at AND n.id > s.id))
   );
CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_sessions_one_active ON auth_sessions(player_id) WHERE revoked_at IS NULL;
