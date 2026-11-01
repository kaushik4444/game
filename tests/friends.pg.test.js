'use strict';
require('./helpers/env');
// Friends and invitation persistence/API on a disposable PostgreSQL database only.
const assert = require('node:assert/strict');
const testdb = require('./helpers/testdb');
const { Browser, registerAndVerify } = require('./helpers/auth');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const quiet = () => ({ log() {}, warn() {}, error() {} });
const PW = 'TestPass123!';

(async () => {
  const t = await testdb.create();
  try {
    process.env.DATABASE_URL = t.url;
    const dbPool = require('../db/pool');
    const { start } = require('../server');
    const srv = await start({ port: 0, trustProxy: false, matchLog: quiet() });
    try {
      const x = await t.client();
      const q = async (sql, params) => (await x.query(sql, params)).rows;
      let seq = 0;
      const user = async (tag) => {
        seq++;
        const username = `${tag.toLowerCase()}_${seq}`.slice(0, 24);
        const email = `${username}@test.local`;
        const created = await registerAndVerify(srv.port, { username, email, password: PW, displayName: tag });
        const session = await created.browser.get('/api/auth/session');
        return { ...created, id: session.json.player.id, username: session.json.player.username, email };
      };
      const a = await user('Alpha'); const b = await user('Bravo'); const c = await user('Charlie');
      const anon = new Browser(srv.port); await anon.csrf();
      const establishFriendship = async (requester, recipient) => {
        const sent = await requester.browser.post('/api/me/friend-requests', { username: recipient.username });
        assert.equal(sent.status, 201, JSON.stringify(sent.json));
        const accepted = await recipient.browser.post('/api/me/friend-requests/accept', { requestId: sent.json.request.id });
        assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
      };
      const breakFriendship = async (playerA, playerB) => {
        const [aId, bId] = playerA.id < playerB.id ? [playerA.id, playerB.id] : [playerB.id, playerA.id];
        await q('DELETE FROM friendships WHERE player_a_id=$1 AND player_b_id=$2', [aId, bId]);
        await q("UPDATE private_table_invitations SET status='revoked', updated_at=NOW() WHERE status='pending' AND ((inviter_id=$1 AND invitee_id=$2) OR (inviter_id=$2 AND invitee_id=$1))", [playerA.id, playerB.id]);
      };

      console.log('authentication and request creation');
      await test('requires authentication and CSRF, validates names, prevents self and duplicate requests', async () => {
        assert.equal((await anon.get('/api/me/friends')).status, 401);
        assert.equal((await anon.post('/api/me/friend-requests', { username: b.username })).status, 401);
        assert.equal((await a.browser.post('/api/me/friend-requests', { username: b.username }, { csrf: false })).status, 403);
        assert.equal((await a.browser.post('/api/me/friend-requests', { username: 'a$' })).status, 400);
        assert.equal((await a.browser.post('/api/me/friend-requests', { username: a.username })).status, 404);
        const first = await a.browser.post('/api/me/friend-requests', { username: b.username });
        assert.equal(first.status, 201, JSON.stringify(first.json));
        assert.equal((await a.browser.post('/api/me/friend-requests', { username: b.username })).status, 409);
        assert.equal((await a.browser.get('/api/me/friend-requests?direction=outgoing')).json.requests[0].player_id, b.id);
        assert.equal((await b.browser.get('/api/me/friend-requests')).json.requests[0].player_id, a.id);
        assert.equal((await a.browser.get('/api/me/friends/search?username=_')).status, 200);
        const search = await a.browser.get('/api/me/friends/search?username=bravo');
        assert.equal(search.status, 200);
        assert.ok(search.json.players.some((p) => p.id === b.id));
        assert.ok(!JSON.stringify(search.json).includes(b.email));
        assert.equal((await b.browser.get('/api/me/friends/search?username=%25')).status, 400);
        assert.equal((await b.browser.get('/api/me/friends/search?username=%5C')).status, 400);
      });

      await test('reverse-direction requests atomically accept the existing request', async () => {
        const reverse = await b.browser.post('/api/me/friend-requests', { username: a.username });
        assert.equal(reverse.status, 201, JSON.stringify(reverse.json));
        assert.equal(reverse.json.request.status, 'accepted');
        assert.equal((await a.browser.get('/api/me/friends')).json.friends.length, 1);
        assert.equal((await b.browser.get('/api/me/friends')).json.friends.length, 1);
        assert.equal((await q('SELECT count(*)::int AS n FROM friendships WHERE player_a_id=$1 OR player_b_id=$1', [a.id]))[0].n, 1);
        assert.equal((await a.browser.post('/api/me/friends/remove', { friendId: b.id })).status, 200);
      });

      await test('acceptance, decline and cancellation are owner-checked and single-use', async () => {
        await breakFriendship(a, c);
        const sent = await a.browser.post('/api/me/friend-requests', { username: c.username });
        assert.equal(sent.status, 201, JSON.stringify(sent.json));
        const requestId = sent.json.request.id;
        assert.equal((await a.browser.post('/api/me/friend-requests/accept', { requestId })).status, 404, 'sender cannot accept');
        assert.equal((await b.browser.post('/api/me/friend-requests/accept', { requestId })).status, 404, 'unrelated user cannot accept');
        assert.equal((await c.browser.post('/api/me/friend-requests/accept', { requestId })).status, 200);
        assert.equal((await c.browser.post('/api/me/friend-requests/accept', { requestId })).status, 404);
        await breakFriendship(a, c);
        const cancelReq = await a.browser.post('/api/me/friend-requests', { username: b.username });
        assert.equal((await a.browser.post('/api/me/friend-requests/cancel', { requestId: cancelReq.json.request.id })).status, 200);
        assert.equal((await b.browser.post('/api/me/friend-requests/decline', { requestId: cancelReq.json.request.id })).status, 404);
        const declineReq = await a.browser.post('/api/me/friend-requests', { username: c.username });
        assert.equal((await c.browser.post('/api/me/friend-requests/decline', { requestId: declineReq.json.request.id })).status, 200);
      });

      console.log('private table invitation metadata');
      await test('only friends may be invited; validation, ownership and expiry are checked', async () => {
        await establishFriendship(a, b);
        await breakFriendship(a, c); // Keep this pair unrelated for the negative invitation check.
        const expiry = () => new Date(Date.now() + 3600000).toISOString();
        assert.equal((await a.browser.post('/api/me/table-invitations', { username: c.username, gameId: 'wizard', roomCode: 'ABCDEF', expiresAt: expiry() })).status, 404);
        assert.equal((await a.browser.post('/api/me/table-invitations', { username: b.username, gameId: 'saboteur', roomCode: 'ABCDEF', expiresAt: expiry() })).status, 400);
        assert.equal((await a.browser.post('/api/me/table-invitations', { username: b.username, gameId: 'wizard', roomCode: 'A B', expiresAt: expiry() })).status, 400);
        const created = await a.browser.post('/api/me/table-invitations', { username: b.username, gameId: 'wizard', roomCode: 'ABCDEF', expiresAt: expiry() });
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const id = created.json.invitation.id;
        assert.equal((await c.browser.post('/api/me/table-invitations/accept', { invitationId: id })).status, 404);
        assert.equal((await b.browser.post('/api/me/table-invitations/accept', { invitationId: id })).status, 200);
        assert.equal((await b.browser.post('/api/me/table-invitations/accept', { invitationId: id })).status, 404);
        const revoke = await a.browser.post('/api/me/table-invitations', { username: b.username, gameId: 'poker', roomCode: 'GHIJKL', expiresAt: expiry() });
        assert.equal((await b.browser.post('/api/me/table-invitations/revoke', { invitationId: revoke.json.invitation.id })).status, 404);
        assert.equal((await a.browser.post('/api/me/table-invitations/revoke', { invitationId: revoke.json.invitation.id })).status, 200);
        const expired = await q("INSERT INTO private_table_invitations (inviter_id, invitee_id, game_id, room_code, created_at, expires_at) VALUES ($1, $2, 'wizard', 'MNOPQR', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute') RETURNING id", [a.id, b.id]);
        assert.equal((await b.browser.post('/api/me/table-invitations/accept', { invitationId: expired[0].id })).status, 404);
        assert.equal((await b.browser.get('/api/me/table-invitations')).json.invitations.some((i) => i.id === expired[0].id), false);
      });

      await test('removal winning the pair lock prevents concurrent invitation acceptance', async () => {
        const expiry = new Date(Date.now() + 3600000).toISOString();
        const created = await a.browser.post('/api/me/table-invitations', { username: b.username, gameId: 'wizard', roomCode: 'RSTUVW', expiresAt: expiry });
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const invitationId = created.json.invitation.id;
        const [removeLock, acceptLock] = await Promise.all([t.client(), t.client()]);
        try {
          const [playerA, playerB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
          await removeLock.query('BEGIN');
          await removeLock.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${playerA}:${playerB}`]);
          const accepting = b.browser.post('/api/me/table-invitations/accept', { invitationId });
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const locked = await acceptLock.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [`${playerA}:${playerB}`]);
            if (!locked.rows[0].ok) { waiting = true; break; }
            await acceptLock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`${playerA}:${playerB}`]);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(waiting, 'acceptance must contend on the pair lock');
          await removeLock.query('DELETE FROM friendships WHERE player_a_id=$1 AND player_b_id=$2', [playerA, playerB]);
          await removeLock.query("UPDATE private_table_invitations SET status='revoked', updated_at=NOW() WHERE id=$1 AND status='pending'", [invitationId]);
          await removeLock.query('COMMIT');
          const accepted = await Promise.race([accepting, new Promise((_, reject) => setTimeout(() => reject(new Error('invitation acceptance timed out')), 5000))]);
          assert.equal(accepted.status, 404, JSON.stringify(accepted.json));
          assert.equal((await q('SELECT status FROM private_table_invitations WHERE id=$1', [invitationId]))[0].status, 'revoked');
          assert.equal((await q('SELECT count(*)::int AS n FROM friendships WHERE player_a_id=$1 AND player_b_id=$2', [playerA, playerB]))[0].n, 0);
        } finally {
          await removeLock.query('ROLLBACK').catch(() => {});
          await removeLock.end();
          await acceptLock.end();
        }
      });

      await test('acceptance before removal remains accepted in serialized order', async () => {
        await establishFriendship(a, b);
        const expiry = new Date(Date.now() + 3600000).toISOString();
        const created = await a.browser.post('/api/me/table-invitations', { username: b.username, gameId: 'wizard', roomCode: 'UVWXYZ', expiresAt: expiry });
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const accepted = await b.browser.post('/api/me/table-invitations/accept', { invitationId: created.json.invitation.id });
        assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
        assert.equal((await a.browser.post('/api/me/friends/remove', { friendId: b.id })).status, 200);
        assert.equal((await q('SELECT status FROM private_table_invitations WHERE id=$1', [created.json.invitation.id]))[0].status, 'accepted');
      });

      await test('constraints reject malformed records and account deletion cascades all social rows', async () => {
        assert.equal((await a.browser.post('/api/me/friends/remove', { friendId: b.id })).status, 404);
        await establishFriendship(a, c);
        assert.equal((await a.browser.post('/api/me/friends/remove', { friendId: c.id })).status, 200);
        assert.equal((await c.browser.post('/api/me/friends/remove', { friendId: a.id })).status, 404);
        assert.equal((await c.browser.post('/api/me/friend-requests/decline', { requestId: '00000000-0000-4000-8000-000000000000' })).status, 404);
        const pending = await q("INSERT INTO friend_requests (requester_id, recipient_id) VALUES ($1, $2) RETURNING id", [a.id, b.id]);
        await assert.rejects(q("INSERT INTO friend_requests (requester_id, recipient_id) VALUES ($1, $2)", [a.id, b.id]), (e) => e.code === '23505');
        await q('DELETE FROM players WHERE id = $1', [a.id]);
        for (const [table, columns] of [
          ['friendships', ['player_a_id', 'player_b_id']],
          ['friend_requests', ['requester_id', 'recipient_id']],
          ['private_table_invitations', ['inviter_id', 'invitee_id']],
        ]) {
          assert.equal((await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${columns.map((col) => `${col}=$1`).join(' OR ')}`, [a.id]))[0].n, 0, `${table} cascades on player removal`);
        }
        assert.ok(pending[0].id);
      });

      await x.end();
    } finally { await srv.close(); }
    await dbPool.close();
  } finally { await t.drop(); }
  console.log(`\n${passed} friends PostgreSQL tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
