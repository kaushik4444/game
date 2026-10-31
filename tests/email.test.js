'use strict';
// The email adapter against a FAKE provider: configuration errors are loud, delivery failures never pretend to have
// sent, and nothing secret (address, token, link, provider body) ever reaches the logs.
require('./helpers/env');
const assert = require('node:assert/strict');
const { makeAuthEmailSender } = require('../lib/email');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}

const quietLog = () => { const lines = { log: [], error: [] }; return { lines, log: (m) => lines.log.push(String(m)), error: (m) => lines.error.push(String(m)) }; };
const ENV = { EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'Tableverse <noreply@example.test>', PUBLIC_APP_URL: 'https://play.example.test', RESEND_API_KEY: 'secret-api-key' };

(async () => {
  console.log('configuration');
  await test('without the settings the sender is disabled and says so instead of pretending', async () => {
    const s = makeAuthEmailSender({ env: {}, fetch: async () => { throw new Error('must not be called'); }, logger: quietLog() });
    assert.equal(s.enabled, false);
    assert.throws(() => s.assertReady(), /EMAIL_PROVIDER=resend/);
    await assert.rejects(s.sendVerification({ email: 'a@b.test', token: 't' }), /EMAIL_PROVIDER=resend/);
  });
  await test('each missing variable is named, and the API key is never part of the message', () => {
    for (const [key, re] of [
      ['EMAIL_FROM', /EMAIL_FROM/],
      ['PUBLIC_APP_URL', /PUBLIC_APP_URL/],
      ['RESEND_API_KEY', /RESEND_API_KEY/],
    ]) {
      const env = { ...ENV }; delete env[key];
      assert.throws(() => makeAuthEmailSender({ env, fetch: async () => ({}), logger: quietLog() }).assertReady(), re);
    }
  });

  console.log('delivery through a fake provider');
  await test('a successful send posts the verify link to the provider and logs only a masked address', async () => {
    const calls = []; const log = quietLog();
    const s = makeAuthEmailSender({ env: ENV, logger: log, fetch: async (url, o) => { calls.push({ url, o }); return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'email_123' }) }; } });
    const out = await s.sendVerification({ email: 'Zoe.Doe@Example.TEST', token: 'abc123token' });
    assert.equal(out.provider, 'resend');
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.match(calls[0].o.headers.Authorization, /^Bearer secret-api-key$/);
    const body = JSON.parse(calls[0].o.body);
    assert.deepEqual(body.to, ['Zoe.Doe@Example.TEST']);
    assert.ok(body.html.includes('https://play.example.test/verify-email.html?token=abc123token'), 'the link points at the landing page with the token');
    assert.equal(log.lines.error.length, 0);
    const line = log.lines.log.join('\n');
    assert.match(line, /\[email\] sent verify_email email to z\*\*\*e@example\.test \(email_123\)/, line);
    assert.doesNotMatch(line, /abc123token|Zoe\.Doe@|secret-api-key|api\.resend\.com/, 'the log line leaks no token, full address, key or endpoint');
  });
  await test('a password-reset mail uses the reset landing page', async () => {
    const calls = [];
    const s = makeAuthEmailSender({ env: ENV, logger: quietLog(), fetch: async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; } });
    await s.sendPasswordReset({ email: 'a@b.test', token: 'tkn' });
    assert.ok(calls[0].html.includes('/reset-password.html?token=tkn'));
  });
  await test('provider failure: send() rejects (the caller must not claim the mail went out) and the log is sanitized', async () => {
    const log = quietLog();
    // the provider echoes the whole request back in its error body: the worst case for a log leak
    const leaky = 'invalid recipient Zoe.Doe@Example.TEST for https://play.example.test/verify-email.html?token=abc123token key=secret-api-key';
    const s = makeAuthEmailSender({ env: ENV, logger: log, fetch: async () => ({ ok: false, status: 422, text: async () => leaky }) });
    await assert.rejects(s.sendVerification({ email: 'Zoe.Doe@Example.TEST', token: 'abc123token' }), /Email delivery failed/);
    assert.equal(log.lines.log.length, 0, 'nothing is logged as a success');
    const line = log.lines.error.join('\n');
    assert.match(line, /delivery failed \(verify_email\) to z\*\*\*e@example\.test/, line);
    assert.doesNotMatch(line, /Zoe\.Doe@|abc123token|secret-api-key/, 'even a leaking provider body never reaches the log verbatim');
    assert.match(line, /invalid recipient/, 'the harmless part of the error is still there for debugging');
  });
  await test('a non-json error body is used only in its sanitized, short form', async () => {
    const log = quietLog();
    const raw = 'x'.repeat(500) + 'token=secrethere';
    const s = makeAuthEmailSender({ env: ENV, logger: log, fetch: async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); }, text: async () => raw }) });
    await assert.rejects(s.sendPasswordReset({ email: 'a@b.test', token: 't' }), /Email delivery failed/);
    const line = log.lines.error.join('\n');
    assert.match(line, /HTTP 502|xxxx/, 'the status or the excerpt is kept');
    assert.ok(line.length < 320, 'the excerpt is short: ' + line.length);
    assert.doesNotMatch(line, /token=secrethere/, 'a raw token in an html error page is stripped');
  });
  await test('two sends of the same token carry the same Idempotency-Key, a retry does not duplicate the mail', async () => {
    const keys = [];
    const s = makeAuthEmailSender({ env: ENV, logger: quietLog(), fetch: async (url, o) => { keys.push(o.headers['Idempotency-Key']); return { ok: true, status: 200, json: async () => ({}) }; } });
    await s.sendVerification({ email: 'a@b.test', token: 't1' });
    await s.sendVerification({ email: 'a@b.test', token: 't1' });
    await s.sendVerification({ email: 'a@b.test', token: 't2' });
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.match(keys[0], /^[0-9a-f]{64}$/, 'the key is a hash, not the raw token');
    assert.doesNotMatch(keys.join(' '), /t1|t2/);
  });

  console.log(`\n${passed} email adapter tests passed`);
})();
