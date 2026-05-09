const nodemailer = require('nodemailer');
const axios = require('axios');
const db = require('./db');

const HOST = process.env.MAILEROO_HOST || 'smtp.maileroo.com';
const PORT = parseInt(process.env.MAILEROO_PORT || '587', 10);
const USER = process.env.MAILEROO_USER || 'verify@b5aeb42773c11cf3.maileroo.org';
const PASS = process.env.MAILEROO_PASS || 'cd7a7d20b7d1eee0be03b001';
const FROM = process.env.MAILEROO_FROM || USER;
const API_KEY = process.env.MAILEROO_API_KEY || '86be3f0e5f7b3c6cb12c122630496f011fd4d0ebc544453d4cb5d6d31734a343';

let transporter = null;
function getTransport() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,
    auth: { user: USER, pass: PASS },
    requireTLS: PORT !== 465,
    tls: { minVersion: 'TLSv1.2' }
  });
  return transporter;
}

async function sendViaApi({ to, subject, html, text }) {
  try {
    const resp = await axios.post('https://smtp.maileroo.com/send', {
      from: FROM,
      to,
      subject,
      html,
      plain: text
    }, {
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return { ok: true, info: resp.data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message };
  }
}

async function sendMail({ to, subject, html, text }) {
  let lastErr = null;
  try {
    const t = getTransport();
    const info = await t.sendMail({ from: FROM, to, subject, html, text });
    return { ok: true, via: 'smtp', info };
  } catch (e) {
    lastErr = e;
    console.error('[mail] smtp send failed, trying API:', e.message);
  }
  const apiResult = await sendViaApi({ to, subject, html, text });
  if (apiResult.ok) return { ok: true, via: 'api', info: apiResult.info };
  console.error('[mail] api send failed:', apiResult.error);
  return { ok: false, error: lastErr?.message || apiResult.error };
}

function credentialsTemplate({ username, password, loginUrl, expiresAt, lang }) {
  const exp = new Date(expiresAt).toUTCString();
  const subj = 'Your Premium Subscription is Active';
  const text = `Welcome!

Your payment was confirmed and your subscription is active until ${exp}.

Login URL: ${loginUrl}
Username: ${username}
Password: ${password}

Please save these credentials in a safe place. You can change your password after first login.

If you did not request this, please ignore this email.`;
  const html = `
<!doctype html>
<html><body style="font-family:Inter,Arial,sans-serif;background:#0b0b10;color:#e6e6ea;padding:24px">
  <div style="max-width:560px;margin:auto;background:#15151c;border:1px solid #23232d;border-radius:14px;padding:28px">
    <h1 style="margin:0 0 16px;font-size:22px;color:#fff">Welcome to the Club</h1>
    <p style="line-height:1.6;color:#bdbdc7">Your crypto payment has been confirmed and your premium membership is now active.</p>
    <div style="background:#0f0f15;border:1px solid #23232d;border-radius:10px;padding:18px;margin:18px 0">
      <div style="font-size:12px;color:#8a8a96;margin-bottom:6px">USERNAME</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:16px;color:#fff;margin-bottom:14px">${username}</div>
      <div style="font-size:12px;color:#8a8a96;margin-bottom:6px">PASSWORD</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:16px;color:#fff">${password}</div>
    </div>
    <p style="line-height:1.6;color:#bdbdc7;margin:0 0 18px">Subscription valid until <strong style="color:#fff">${exp}</strong>.</p>
    <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#5e8bff);color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600">Open Login Page</a>
    <p style="font-size:12px;color:#6a6a78;margin-top:24px">Keep these credentials private. We will never ask for your password.</p>
  </div>
</body></html>`;
  return { subject: subj, text, html };
}

async function sendCredentials({ to, username, password, loginUrl, expiresAt, lang }) {
  const tmpl = credentialsTemplate({ username, password, loginUrl, expiresAt, lang });
  return sendMail({ to, subject: tmpl.subject, html: tmpl.html, text: tmpl.text });
}

async function processQueue() {
  const queue = db.all('emailQueue').filter(q => q.status === 'pending');
  for (const job of queue) {
    db.update('emailQueue', job.id, { status: 'sending', attempts: (job.attempts || 0) + 1 });
    const r = await sendMail(job.payload);
    if (r.ok) {
      db.update('emailQueue', job.id, { status: 'sent', sentAt: Date.now(), via: r.via });
    } else {
      const attempts = (job.attempts || 0) + 1;
      db.update('emailQueue', job.id, {
        status: attempts >= 5 ? 'failed' : 'pending',
        lastError: r.error,
        attempts
      });
    }
  }
}

function enqueue(payload) {
  return db.insert('emailQueue', { status: 'pending', attempts: 0, payload });
}

function startWorker() {
  setInterval(() => {
    processQueue().catch(e => console.error('[mail-queue]', e));
  }, 30 * 1000);
}

module.exports = { sendMail, sendCredentials, enqueue, processQueue, startWorker };
