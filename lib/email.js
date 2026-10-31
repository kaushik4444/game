'use strict';

const crypto = require('crypto');

const trim = (v) => String(v || '').trim();

function maskEmail(email) {
  const e = trim(email).toLowerCase();
  const at = e.indexOf('@');
  if (at <= 1) return '***';
  return `${e.slice(0, 1)}***${e.slice(at - 1)}`;
}

/**
 * A provider's error body can echo the recipient address or even the link we just sent, so it is never logged as-is:
 * email addresses and token query strings are stripped, non-printable characters removed, and the excerpt kept short.
 * The status code and the harmless part of the message stay, which is what makes an outage debuggable.
 */
function safeExcerpt(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w.-]+\.[\w-]+/g, '***@***')
    .replace(/\btoken=[^\s"'&,)>]+/gi, 'token=***')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 160)
    .trim();
}

function makeAuthEmailSender(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || global.fetch;
  const logger = opts.logger || console;

  const provider = trim(env.EMAIL_PROVIDER || '').toLowerCase();
  const from = trim(env.EMAIL_FROM);
  const publicAppUrl = trim(env.PUBLIC_APP_URL).replace(/\/$/, '');
  const resendApiKey = trim(env.RESEND_API_KEY);

  const enabled = provider === 'resend';

  const assertReady = () => {
    if (!enabled) throw new Error('Transactional email is not configured. Set EMAIL_PROVIDER=resend.');
    if (!from) throw new Error('EMAIL_FROM is required for transactional email.');
    if (!publicAppUrl) throw new Error('PUBLIC_APP_URL is required for transactional email links.');
    if (!resendApiKey) throw new Error('RESEND_API_KEY is required for EMAIL_PROVIDER=resend.');
    if (typeof fetchImpl !== 'function') throw new Error('global fetch() is unavailable for email delivery.');
  };

  const build = ({ purpose, to, token }) => {
    const p = purpose === 'verify_email'
      ? {
          subject: 'Verify your Tableverse account',
          path: '/verify-email.html',
          intro: 'Welcome to Tableverse. Verify your email to enter the lobby.',
          cta: 'Verify email',
        }
      : {
          subject: 'Reset your Tableverse password',
          path: '/reset-password.html',
          intro: 'We received a request to reset your Tableverse password.',
          cta: 'Reset password',
        };

    const url = `${publicAppUrl}${p.path}?token=${encodeURIComponent(token)}`;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.45;color:#111">
      <p>${p.intro}</p>
      <p><a href="${url}" style="display:inline-block;padding:10px 14px;background:#1f6feb;color:#fff;text-decoration:none;border-radius:8px">${p.cta}</a></p>
      <p style="word-break:break-all">If the button does not work, open this link:<br><a href="${url}">${url}</a></p>
      <p>If you did not request this, you can safely ignore this email.</p>
    </div>`;
    const text = `${p.intro}\n\n${p.cta}: ${url}\n\nIf you did not request this, you can safely ignore this email.`;
    return { to, subject: p.subject, html, text };
  };

  const send = async ({ purpose, to, token }) => {
    assertReady();
    const msg = build({ purpose, to, token });
    const idempotencyKey = crypto.createHash('sha256').update(`${purpose}:${to}:${token}`).digest('hex');
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });

    // the body can only be read once: take the text, then try to parse it as json
    let raw = '';
    try { raw = await res.text(); } catch { /* ignore */ }
    let body = null;
    try { body = JSON.parse(raw); } catch { /* not json: the raw excerpt is used instead */ }

    if (!res.ok) {
      // only a redacted excerpt: a provider error can echo the address, the link we sent or even our own key
      let detail = safeExcerpt((body && (body.error?.message || body.message)) || raw);
      if (resendApiKey) detail = detail.split(resendApiKey).join('***');
      logger.error(`[email] delivery failed (${purpose}) to ${maskEmail(to)}: ${detail || `HTTP ${res.status}`}`);
      throw new Error('Email delivery failed. Please try again in a moment.');
    }

    const id = body && body.id ? String(body.id).slice(0, 64) : 'no-id';
    logger.log(`[email] sent ${purpose} email to ${maskEmail(to)} (${id})`);
    return { provider: 'resend', id: body && body.id ? body.id : null };
  };

  return {
    enabled,
    provider: enabled ? 'resend' : null,
    assertReady,
    async sendVerification({ email, token }) { return send({ purpose: 'verify_email', to: email, token }); },
    async sendPasswordReset({ email, token }) { return send({ purpose: 'password_reset', to: email, token }); },
  };
}

module.exports = { makeAuthEmailSender };
