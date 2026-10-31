'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Reliable, non-blocking persistence of finished matches.
 *
 *  - enqueue() returns at once; the game never waits for the database.
 *  - A transient failure (connection lost, timeout, deadlock, serialization failure, server restarting, too many
 *    connections) is retried a bounded number of times with growing delays. A permanent failure (bad data, constraint
 *    violation, missing table) is not retried: repeating it cannot help.
 *  - Retrying is safe because every record carries a match key and the database ignores a second insert of the same key.
 *  - A write that finally fails is logged loudly with enough detail to repair by hand, reported through onGiveUp, and
 *    NEVER counted as saved.
 *  - Before the first attempt the record is written to a small file in the spool directory and removed once the database
 *    has it. After a crash or restart the leftovers are replayed (replaySpool). On a host with an ephemeral disk this
 *    covers process restarts but not a redeploy onto a fresh machine.
 *  - drain() lets shutdown wait for pending writes (SIGTERM on deploy).
 */

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CONNECTION_ENDED']);
const TRANSIENT_SQLSTATE = /^(08|40|53|57|58)/; // connection exception, transaction rollback, resources, operator intervention (incl. statement timeout), system error

function isTransient(err) {
  if (!err) return false;
  const code = err.code;
  if (code) return TRANSIENT_CODES.has(code) || TRANSIENT_SQLSTATE.test(String(code)) || code === '55P03' || code === '25006';
  // pg reports a dropped connection and a connect timeout without a code
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect|terminating connection|Client has encountered a connection error/i.test(err.message || '');
}

const DEFAULT_DELAYS = [500, 1500, 4000, 10000, 20000]; // 5 retries, about 36 s in total

function defaultSpoolDir(env) {
  const v = env.MATCH_SPOOL_DIR;
  if (v === 'off') return null;
  return v || path.join(os.tmpdir(), 'tableverse-match-spool');
}

function createMatchQueue({ record, spoolDir = null, delays = DEFAULT_DELAYS, log = console, onGiveUp = null, onSaved = null } = {}) {
  if (typeof record !== 'function') throw new Error('createMatchQueue needs a record function');
  const pending = new Map(); // matchKey -> promise (also the in-process duplicate guard)
  const timers = new Set();
  const stats = { saved: 0, duplicates: 0, retried: 0, failed: 0 };
  let closed = false;

  const fileFor = (key) => path.join(spoolDir, `${key}.json`);
  function spoolWrite(key, rec) {
    if (!spoolDir) return;
    try {
      fs.mkdirSync(spoolDir, { recursive: true });
      const tmp = fileFor(key) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(rec));
      fs.renameSync(tmp, fileFor(key));
    } catch (e) {
      log.error(`[matches] could not spool ${key} (a restart now would lose it): ${e.message}`);
    }
  }
  function spoolRemove(key, suffix) {
    if (!spoolDir) return;
    try {
      if (suffix) fs.renameSync(fileFor(key), fileFor(key).replace(/\.json$/, suffix));
      else fs.unlinkSync(fileFor(key));
    } catch { /* already gone */ }
  }

  const sleep = (ms) =>
    new Promise((resolve) => {
      const entry = { resolve };
      entry.t = setTimeout(() => { timers.delete(entry); resolve(); }, ms);
      timers.add(entry);
    });

  const summary = (rec) => `match ${rec.matchKey} (${rec.gameId}, table ${rec.roomCode}, players: ${(rec.participants || []).map((p) => p.name).join(', ')})`;

  async function run(rec, key) {
    let lastErr = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        stats.retried++;
        const wait = Math.round(delays[attempt - 1] * (0.8 + Math.random() * 0.4)); // jitter
        log.warn(`[matches] retry ${attempt}/${delays.length} in ${wait} ms for ${summary(rec)}: ${lastErr.message}`);
        await sleep(wait);
        if (closed) break;
      }
      try {
        const res = await record(rec);
        if (res && res.duplicate) stats.duplicates++;
        else stats.saved++;
        spoolRemove(key);
        if (attempt > 0) log.log(`[matches] saved ${summary(rec)} after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
        if (onSaved) onSaved(rec, res);
        return { status: res && res.duplicate ? 'duplicate' : 'saved', attempts: attempt + 1 };
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) {
          log.error(`[matches] NOT SAVED (permanent error, not retrying) ${summary(rec)}: ${err.code ? err.code + ' ' : ''}${err.message}`);
          spoolRemove(key, '.failed'); // keep for inspection; replaying it would fail the same way
          return fail(rec, err, attempt + 1);
        }
      }
    }
    // out of retries (or shutting down): the spool file stays so the next start can try again
    log.error(`[matches] NOT SAVED after ${delays.length} retries ${summary(rec)}: ${lastErr.message}${spoolDir ? ' (kept in the spool for the next start)' : ' (no spool configured: this result is lost)'}`);
    return fail(rec, lastErr, delays.length + 1);
  }

  function fail(rec, err, attempts) {
    stats.failed++;
    if (onGiveUp) {
      try { onGiveUp(rec, err); } catch (e) { log.error('[matches] onGiveUp failed: ' + e.message); }
    }
    return { status: 'failed', attempts, error: err.message };
  }

  /** Never rejects and never throws: the caller is the game loop. */
  function enqueue(rec) {
    try {
      if (closed) return Promise.resolve({ status: 'failed', attempts: 0, error: 'shutting down' });
      const key = rec.matchKey || require('crypto').randomUUID();
      if (!rec.matchKey) rec = { ...rec, matchKey: key };
      if (pending.has(key)) return pending.get(key); // same game queued twice in this process
      spoolWrite(key, rec);
      const p = run(rec, key).catch((e) => {
        log.error('[matches] unexpected queue error: ' + e.message);
        return { status: 'failed', attempts: 0, error: e.message };
      }).finally(() => pending.delete(key));
      pending.set(key, p);
      return p;
    } catch (e) {
      log.error('[matches] could not queue a match: ' + e.message);
      return Promise.resolve({ status: 'failed', attempts: 0, error: e.message });
    }
  }

  /** Re-queue records left in the spool by a previous run. Returns how many were found. */
  function replaySpool() {
    if (!spoolDir) return 0;
    let files;
    try { files = fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
    let n = 0;
    for (const f of files) {
      const key = f.slice(0, -5);
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(spoolDir, f), 'utf8'));
        if (!rec || !Array.isArray(rec.participants) || !rec.gameId) throw new Error('not a match record');
        n++;
        log.log(`[matches] replaying ${summary(rec)} from the spool`);
        enqueue(rec);
      } catch (e) {
        log.error(`[matches] unreadable spool file ${f}: ${e.message}`);
        spoolRemove(key, '.bad');
      }
    }
    return n;
  }

  /** Wait until nothing is pending, or until timeoutMs. Resolves true when everything finished. */
  async function drain(timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    while (pending.size && Date.now() < until) {
      await Promise.race([Promise.allSettled([...pending.values()]), new Promise((r) => setTimeout(r, Math.max(1, until - Date.now())))]);
    }
    return pending.size === 0;
  }

  /** Stop retrying (shutdown): unsaved records stay in the spool. */
  function close() {
    closed = true;
    for (const e of timers) { clearTimeout(e.t); e.resolve(); } // wake the sleepers: they see `closed` and stop
    timers.clear();
  }

  return { enqueue, replaySpool, drain, close, stats: () => ({ ...stats, pending: pending.size }), isTransient };
}

module.exports = { createMatchQueue, isTransient, defaultSpoolDir, DEFAULT_DELAYS };
