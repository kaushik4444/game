'use strict';

const db = require('./pool');

const mem = new Map();

function nowMs() { return Date.now(); }

function hitMemory(scope, key, limit, windowMs) {
  const k = `${scope}:${key}`;
  const now = nowMs();
  if (mem.size > 5000) for (const [key, v] of mem) if (now >= v.resetAt) mem.delete(key); // keep the in-memory table from growing forever
  const entry = mem.get(k);
  if (!entry || now >= entry.resetAt) {
    mem.set(k, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetMs: windowMs, count: 1 };
  }
  entry.count += 1;
  const allowed = entry.count <= limit;
  return { allowed, remaining: Math.max(0, limit - entry.count), resetMs: Math.max(0, entry.resetAt - now), count: entry.count };
}

async function hitDb(scope, key, limit, windowMs) {
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const sql = `
    WITH bucket AS (
      SELECT to_timestamp(floor(extract(epoch FROM NOW()) / $3::int) * $3::int) AS ws
    ),
    up AS (
      INSERT INTO auth_rate_limits(scope, key, window_start, count)
      SELECT $1, $2, ws, 1 FROM bucket
      ON CONFLICT (scope, key, window_start)
      DO UPDATE SET count = auth_rate_limits.count + 1
      RETURNING count, window_start
    )
    SELECT count,
           GREATEST(0, ($3::int - extract(epoch FROM (NOW() - window_start)))::int) AS reset_seconds
    FROM up`;

  const r = await db.query(sql, [scope, key, windowSeconds]); // every parameter must be used by the SQL, or PostgreSQL cannot type it
  const row = r.rows[0] || { count: 1, reset_seconds: windowSeconds };
  const count = Number(row.count) || 1;
  const allowed = count <= limit;
  return { allowed, remaining: Math.max(0, limit - count), resetMs: (Number(row.reset_seconds) || windowSeconds) * 1000, count };
}

async function hitRateLimit({ scope, key, limit, windowMs }) {
  if (!scope || !key || !Number.isFinite(limit) || !Number.isFinite(windowMs)) {
    throw new Error('rate limit config invalid');
  }
  if (db.hasDatabase()) return hitDb(scope, key, limit, windowMs);
  return hitMemory(scope, key, limit, windowMs);
}

module.exports = { hitRateLimit };
