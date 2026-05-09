process.on('uncaughtException', (e) => { try { console.error('[uncaughtException]', e && e.stack || e); } catch (_) {} });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', e && e.stack || e); } catch (_) {} });

console.log('[boot] node ' + process.version + ' platform=' + process.platform + ' arch=' + process.arch);

try { require('dotenv').config(); console.log('[boot] dotenv ok'); } catch (e) { console.warn('[boot] dotenv skipped:', e.message); }

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const { RateLimiterMemory } = require('rate-limiter-flexible');
console.log('[boot] core deps loaded');

const db = require('./db'); console.log('[boot] db ok');
const auth = require('./auth'); console.log('[boot] auth ok');
const mail = require('./mail'); console.log('[boot] mail ok');
const payment = require('./payment'); console.log('[boot] payment ok');
const video = require('./video'); console.log('[boot] video ok');
const tokens = require('./tokens'); console.log('[boot] tokens ok');
const i18n = require('./i18n'); console.log('[boot] i18n ok');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
console.log('[boot] PORT=' + PORT + ' PUBLIC_URL=' + PUBLIC_URL);

const app = express();
app.set('trust proxy', true);

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), now: Date.now(), videoModule: !!video });
});
app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok'));

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      "style-src": ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      "font-src": ["'self'", 'https://fonts.gstatic.com', 'data:'],
      "img-src": ["'self'", 'data:', 'blob:'],
      "media-src": ["'self'", 'blob:'],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

app.use('/api/payment/ipn', express.raw({ type: '*/*', limit: '1mb' }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use(auth.authMiddleware);

const ipLimiter = new RateLimiterMemory({ points: 200, duration: 60 });
const loginLimiter = new RateLimiterMemory({ points: 8, duration: 5 * 60 });
app.use(async (req, res, next) => {
  if (req.path === '/health' || req.path === '/healthz') return next();
  const ip = auth.getClientIp(req);
  try { await ipLimiter.consume(ip); next(); }
  catch (e) { res.status(429).json({ error: 'rate_limited' }); }
});

function setAuthCookie(res, token) {
  res.cookie('auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearAuthCookie(res) {
  res.clearCookie('auth', { path: '/' });
}

const STATIC_FILES = new Set([
  'style.css', 'app.js', 'home.js', 'login.js', 'register.js',
  'pay.js', 'admin.js', 'watch.js', 'i18n_client.js'
]);
app.get('/static/:file', (req, res) => {
  const f = req.params.file;
  if (!STATIC_FILES.has(f)) return res.status(404).end();
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

app.get('/api/i18n', (req, res) => {
  res.json({
    supported: i18n.SUPPORTED,
    default: i18n.DEFAULT_LANG,
    detected: i18n.detectLang(req),
    translations: i18n.allLangs()
  });
});

app.post('/api/lang', (req, res) => {
  const lang = (req.body && req.body.lang) || '';
  if (!i18n.SUPPORTED.includes(lang)) return res.status(400).json({ error: 'bad_lang' });
  res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, path: '/' });
  res.json({ ok: true, lang });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/register', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const ip = auth.getClientIp(req);
    const sessionId = crypto.randomBytes(16).toString('hex');
    const slug = tokens.randomPath(3).replace(/\//g, '-') + '-' + crypto.randomBytes(8).toString('hex');

    const session = db.insert('payments', {
      id: sessionId,
      slug,
      email,
      ip,
      status: 'pending',
      payCurrency: null,
      payAmount: null,
      payAddress: null,
      paymentId: null,
      orderId: null,
      priceUsd: payment.PRICE_USD,
      subscriptionDays: payment.SUB_DAYS,
      expiresAt: null,
      paidAt: null
    });

    res.json({
      ok: true,
      sessionId,
      slug,
      url: `/pay/${slug}`
    });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/payment/currencies', async (req, res) => {
  if (!payment.hasApiKey()) {
    return res.json({
      ok: true,
      offline: true,
      currencies: ['btc', 'eth', 'usdttrc20', 'usdterc20', 'ltc', 'doge', 'sol', 'xmr', 'bnbbsc', 'trx']
    });
  }
  const list = await payment.getCurrencies();
  res.json({ ok: true, currencies: list });
});

function findPaymentBySlug(slug) {
  return db.findOne('payments', p => p.slug === slug);
}

app.get('/api/pay/:slug/info', (req, res) => {
  const p = findPaymentBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (p.ip !== auth.getClientIp(req)) {
    return res.status(403).json({ error: 'ip_mismatch' });
  }
  res.json({
    ok: true,
    sessionId: p.id,
    slug: p.slug,
    email: p.email,
    status: p.status,
    priceUsd: p.priceUsd,
    payCurrency: p.payCurrency,
    payAmount: p.payAmount,
    payAddress: p.payAddress,
    expiresAt: p.expiresAt,
    paidAt: p.paidAt,
    subscriptionDays: p.subscriptionDays
  });
});

app.post('/api/pay/:slug/estimate', async (req, res) => {
  const p = findPaymentBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (p.ip !== auth.getClientIp(req)) return res.status(403).json({ error: 'ip_mismatch' });
  const currency = String((req.body && req.body.currency) || '').toLowerCase();
  if (!currency) return res.status(400).json({ error: 'no_currency' });

  if (!payment.hasApiKey()) {
    const fakeRates = { btc: 0.000076, eth: 0.0014, usdttrc20: 5.05, usdterc20: 5.05, ltc: 0.052, doge: 35, sol: 0.025, xmr: 0.026, bnbbsc: 0.0085, trx: 25 };
    const amount = fakeRates[currency] || 1;
    return res.json({ ok: true, demo: true, currency_from: 'usd', currency_to: currency, estimated_amount: amount });
  }

  try {
    const est = await payment.estimatePrice(currency);
    res.json({ ok: true, ...est });
  } catch (e) {
    res.status(400).json({ error: 'estimate_failed', detail: e.response?.data || e.message });
  }
});

app.post('/api/pay/:slug/create', async (req, res) => {
  const p = findPaymentBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (p.ip !== auth.getClientIp(req)) return res.status(403).json({ error: 'ip_mismatch' });
  if (p.status === 'paid') return res.status(400).json({ error: 'already_paid' });

  const currency = String((req.body && req.body.currency) || '').toLowerCase();
  if (!currency) return res.status(400).json({ error: 'no_currency' });

  if (!payment.hasApiKey()) {
    return res.status(503).json({ error: 'nowpayments_not_configured', detail: 'Set NOWPAYMENTS_API_KEY in environment.' });
  }

  try {
    const ipnUrl = `${PUBLIC_URL}/api/payment/ipn`;
    const created = await payment.createPayment({
      payCurrency: currency,
      email: p.email,
      ip: p.ip,
      sessionId: p.id,
      ipnUrl
    });

    const expiresAt = Date.now() + 5 * 60 * 1000;

    db.update('payments', p.id, {
      status: 'awaiting_payment',
      payCurrency: currency,
      payAmount: created.pay_amount,
      payAddress: created.pay_address,
      paymentId: created.payment_id,
      orderId: created.order_id,
      expiresAt,
      paymentExtraId: created.payin_extra_id || null,
      network: created.network || null
    });

    res.json({
      ok: true,
      payAddress: created.pay_address,
      payAmount: created.pay_amount,
      payCurrency: currency,
      paymentId: created.payment_id,
      expiresAt,
      network: created.network || null,
      payinExtraId: created.payin_extra_id || null
    });
  } catch (e) {
    console.error('[payment.create]', e.response?.data || e.message);
    res.status(400).json({ error: 'create_failed', detail: e.response?.data || e.message });
  }
});

async function finalizePayment(p) {
  const fresh = db.findById('payments', p.id);
  if (!fresh || fresh.status === 'paid') return fresh;

  const username = auth.generateUsername();
  const password = auth.generatePassword();
  const hash = await auth.hashPassword(password);

  const expiresAt = Date.now() + (fresh.subscriptionDays || payment.SUB_DAYS) * 24 * 60 * 60 * 1000;
  const user = db.insert('users', {
    email: fresh.email,
    username,
    passwordHash: hash,
    subscriptionExpiresAt: expiresAt,
    paymentSessionId: fresh.id
  });

  db.update('payments', fresh.id, {
    status: 'paid',
    paidAt: Date.now(),
    userId: user.id
  });

  mail.enqueue({
    to: fresh.email,
    type: 'credentials',
    payload: { username, password, expiresAt }
  });

  mail.sendCredentials({
    to: fresh.email,
    username,
    password,
    loginUrl: `${PUBLIC_URL}/login`,
    expiresAt
  }).then(r => {
    if (!r.ok) console.error('[mail.sendCredentials] failed:', r.error);
  }).catch(e => console.error('[mail.sendCredentials] threw:', e.message));

  return db.findById('payments', fresh.id);
}

app.get('/api/pay/:slug/status', async (req, res) => {
  const p = findPaymentBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (p.ip !== auth.getClientIp(req)) return res.status(403).json({ error: 'ip_mismatch' });

  if (p.status === 'paid') {
    return res.json({ ok: true, status: 'paid', paidAt: p.paidAt });
  }

  if (p.status === 'awaiting_payment' && p.paymentId && payment.hasApiKey()) {
    try {
      const st = await payment.getPaymentStatus(p.paymentId);
      const status = (st.payment_status || '').toLowerCase();
      if (payment.isPaidStatus(status)) {
        await finalizePayment(p);
        return res.json({ ok: true, status: 'paid' });
      }
      if (payment.isFailedStatus(status)) {
        db.update('payments', p.id, { status: 'failed', failedAt: Date.now(), failureReason: status });
        return res.json({ ok: true, status: 'failed' });
      }
      if (p.expiresAt && Date.now() > p.expiresAt && !payment.isWaitingStatus(status) && status !== 'confirming') {
        db.update('payments', p.id, { status: 'expired', failedAt: Date.now() });
        return res.json({ ok: true, status: 'expired' });
      }
      return res.json({ ok: true, status: 'awaiting_payment', remoteStatus: status, expiresAt: p.expiresAt });
    } catch (e) {
      console.error('[pay.status]', e.response?.data || e.message);
      return res.json({ ok: true, status: p.status, expiresAt: p.expiresAt, error: 'remote_check_failed' });
    }
  }

  if (p.expiresAt && Date.now() > p.expiresAt && p.status === 'awaiting_payment') {
    db.update('payments', p.id, { status: 'expired', failedAt: Date.now() });
    return res.json({ ok: true, status: 'expired' });
  }

  res.json({ ok: true, status: p.status, expiresAt: p.expiresAt });
});

app.post('/api/payment/ipn', async (req, res) => {
  try {
    const raw = req.body;
    const sig = req.headers['x-nowpayments-sig'];
    if (!payment.verifyIpnSignature(raw, sig)) {
      console.warn('[ipn] bad signature');
      return res.status(400).json({ error: 'bad_signature' });
    }
    const data = JSON.parse(raw.toString('utf8'));
    const orderId = data.order_id || '';
    const sessionId = orderId.startsWith('sub_') ? orderId.slice(4) : null;
    const p = sessionId ? db.findById('payments', sessionId) : null;
    if (!p) return res.json({ ok: true, ignored: true });

    db.update('payments', p.id, {
      remoteStatus: data.payment_status,
      ipnPayload: data
    });

    if (payment.isPaidStatus(data.payment_status)) {
      await finalizePayment(p);
    } else if (payment.isFailedStatus(data.payment_status)) {
      db.update('payments', p.id, { status: 'failed', failureReason: data.payment_status });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[ipn]', e);
    res.status(500).json({ error: 'ipn_error' });
  }
});

app.post('/api/login', async (req, res) => {
  const ip = auth.getClientIp(req);
  try { await loginLimiter.consume(ip); }
  catch (e) { return res.status(429).json({ error: 'rate_limited' }); }

  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) return res.status(400).json({ error: 'missing_credentials' });

  if (username === auth.ADMIN_USERNAME) {
    const tok = await auth.adminLogin(username, password);
    if (!tok) return res.status(401).json({ error: 'invalid_credentials' });
    setAuthCookie(res, tok);
    return res.json({ ok: true, role: 'admin', username });
  }

  const user = db.findOne('users', u => u.username === username || u.email.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await auth.verifyPassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const tok = auth.signToken({ uid: user.id });
  setAuthCookie(res, tok);
  res.json({
    ok: true,
    role: 'user',
    username: user.username,
    subscriptionActive: user.subscriptionExpiresAt > Date.now()
  });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

function publicVideoView(v) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    duration: v.duration,
    width: v.width,
    height: v.height,
    status: v.status,
    createdAt: v.createdAt,
    readyAt: v.readyAt,
    thumb: `/thumbs/${v.id}/thumb.jpg`,
    poster: `/thumbs/${v.id}/poster.jpg`
  };
}

app.get('/api/videos', (req, res) => {
  const list = db.all('videos').filter(v => v.status === 'ready')
    .sort((a, b) => (b.readyAt || 0) - (a.readyAt || 0))
    .map(publicVideoView);
  res.json({ ok: true, videos: list });
});

app.get('/api/videos/:id', (req, res) => {
  const v = db.findById('videos', req.params.id);
  if (!v || v.status !== 'ready') return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, video: publicVideoView(v) });
});

app.get('/thumbs/:videoId/:file', (req, res) => {
  const kind = req.params.file === 'poster.jpg' ? 'poster' : 'thumb';
  const p = video.getThumb(req.params.videoId, kind);
  if (!p) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(p);
});

app.post('/api/videos/:id/play', (req, res) => {
  const v = db.findById('videos', req.params.id);
  if (!v || v.status !== 'ready') return res.status(404).json({ error: 'not_found' });
  const ip = auth.getClientIp(req);

  let mode = 'preview';
  if (req.user) {
    if (req.user.role === 'admin') mode = 'full';
    else if (req.user.subscriptionActive) mode = 'full';
  }

  const session = tokens.createStreamSession({
    videoId: v.id,
    userId: req.user?.id || null,
    ip,
    mode
  });

  const playlistUrl = `/stream/${session.pathSlug}/playlist.m3u8?t=${session.playlistToken}&s=${session.sessionId}`;
  res.json({
    ok: true,
    mode,
    playlistUrl,
    expiresAt: session.expiresAt,
    previewSeconds: video.PREVIEW_SECONDS,
    videoId: v.id,
    title: v.title,
    description: v.description,
    duration: v.duration
  });
});

function decodeStreamRequest(req) {
  const sid = req.query.s;
  const tok = req.query.t;
  const decoded = tokens.verify(tok);
  if (!decoded) return { error: 'bad_token' };
  if (sid && decoded.sid !== sid) return { error: 'sid_mismatch' };
  const session = tokens.getSession(decoded.sid);
  const ip = auth.getClientIp(req);
  if (!tokens.isSessionValid(session, ip)) return { error: 'invalid_session' };
  if (session.videoId !== decoded.vid) return { error: 'vid_mismatch' };
  return { decoded, session, ip };
}

app.get('/stream/*', (req, res, next) => {
  const url = req.path;
  const m = url.match(/^\/stream\/(.+?)\/(playlist\.m3u8|key\.bin|seg\.ts)$/);
  if (!m) return res.status(404).end();
  const slug = m[1];
  const kind = m[2];

  const decResult = decodeStreamRequest(req);
  if (decResult.error) return res.status(403).json({ error: decResult.error });
  const { decoded, session } = decResult;

  if (session.pathSlug !== slug) return res.status(403).json({ error: 'slug_mismatch' });

  if (kind === 'playlist.m3u8') {
    if (decoded.kind !== 'playlist') return res.status(403).json({ error: 'wrong_kind' });
    const text = video.getPlaylistForVideo(session.videoId, session.mode, (line) => {
      if (line.startsWith('#EXT-X-KEY')) {
        const newKeyToken = tokens.buildKeyToken(session);
        const newUri = `/stream/${session.pathSlug}/key.bin?t=${newKeyToken}&s=${session.id}`;
        return line.replace(/URI="[^"]*"/, `URI="${newUri}"`);
      }
      if (line.endsWith('.ts')) {
        const segName = line.trim();
        const segToken = tokens.buildSegmentToken(session, segName);
        return `/stream/${session.pathSlug}/seg.ts?t=${segToken}&s=${session.id}`;
      }
      return line;
    });
    if (!text) return res.status(404).end();
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(text);
    return;
  }

  if (kind === 'key.bin') {
    if (decoded.kind !== 'key') return res.status(403).json({ error: 'wrong_kind' });
    const key = video.getKeyForVideo(session.videoId, session.mode);
    if (!key) return res.status(404).end();
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(key);
    return;
  }

  if (kind === 'seg.ts') {
    if (decoded.kind !== 'segment') return res.status(403).json({ error: 'wrong_kind' });
    const segPath = video.getSegmentPath(session.videoId, session.mode, decoded.seg);
    if (!segPath) return res.status(404).end();
    res.set('Content-Type', 'video/MP2T');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    fs.createReadStream(segPath).pipe(res);
    return;
  }

  res.status(404).end();
});

const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const id = req.params.uploadId;
    const dir = path.join(video.UPLOAD_TMP, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const idx = String(req.params.index || '0').padStart(8, '0');
    cb(null, `chunk_${idx}`);
  }
});
const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/admin/upload/init', auth.requireAdmin, (req, res) => {
  const { fileName, fileSize, totalChunks, title, description } = req.body || {};
  if (!fileName || !totalChunks) return res.status(400).json({ error: 'missing_fields' });
  const uploadId = crypto.randomBytes(12).toString('hex');
  const upload = db.insert('uploads', {
    id: uploadId,
    fileName,
    fileSize,
    totalChunks,
    receivedChunks: [],
    title: title || fileName,
    description: description || '',
    status: 'uploading',
    createdAt: Date.now()
  });
  res.json({ ok: true, uploadId, upload });
});

app.get('/api/admin/upload/:uploadId/state', auth.requireAdmin, (req, res) => {
  const u = db.findById('uploads', req.params.uploadId);
  if (!u) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, upload: u });
});

app.post('/api/admin/upload/:uploadId/chunk/:index', auth.requireAdmin, chunkUpload.single('chunk'), (req, res) => {
  const u = db.findById('uploads', req.params.uploadId);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const idx = parseInt(req.params.index, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= u.totalChunks) return res.status(400).json({ error: 'bad_index' });

  const received = new Set(u.receivedChunks || []);
  received.add(idx);
  db.update('uploads', u.id, { receivedChunks: Array.from(received).sort((a, b) => a - b) });
  res.json({ ok: true, index: idx, received: received.size, total: u.totalChunks });
});

app.post('/api/admin/upload/:uploadId/complete', auth.requireAdmin, async (req, res) => {
  const u = db.findById('uploads', req.params.uploadId);
  if (!u) return res.status(404).json({ error: 'not_found' });
  if ((u.receivedChunks || []).length !== u.totalChunks) return res.status(400).json({ error: 'incomplete' });

  const dir = path.join(video.UPLOAD_TMP, u.id);
  const finalName = `${u.id}_${Date.now()}_${u.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const finalPath = path.join(video.VIDEO_DIR, finalName);

  const out = fs.createWriteStream(finalPath);
  for (let i = 0; i < u.totalChunks; i++) {
    const chunkPath = path.join(dir, `chunk_${String(i).padStart(8, '0')}`);
    if (!fs.existsSync(chunkPath)) {
      out.destroy();
      try { fs.unlinkSync(finalPath); } catch (e) {}
      return res.status(400).json({ error: 'missing_chunk', index: i });
    }
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(chunkPath);
      rs.on('end', resolve);
      rs.on('error', reject);
      rs.pipe(out, { end: false });
    });
  }
  await new Promise((resolve) => out.end(resolve));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

  const videoId = db.id();
  const newVideo = db.insert('videos', {
    id: videoId,
    title: u.title || u.fileName,
    description: u.description || '',
    originalName: u.fileName,
    status: 'processing',
    duration: 0
  });

  db.update('uploads', u.id, { status: 'processing', videoId });

  video.enqueueProcessing({
    videoId,
    sourcePath: finalPath,
    originalName: u.fileName,
    title: u.title || u.fileName,
    description: u.description || ''
  });

  res.json({ ok: true, videoId, video: newVideo });
});

app.delete('/api/admin/upload/:uploadId', auth.requireAdmin, (req, res) => {
  const u = db.findById('uploads', req.params.uploadId);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const dir = path.join(video.UPLOAD_TMP, u.id);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  db.update('uploads', u.id, { status: 'cancelled' });
  res.json({ ok: true });
});

app.get('/api/admin/uploads', auth.requireAdmin, (req, res) => {
  const list = db.all('uploads').sort((a, b) => b.createdAt - a.createdAt);
  res.json({ ok: true, uploads: list });
});

app.get('/api/admin/videos', auth.requireAdmin, (req, res) => {
  const list = db.all('videos').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ ok: true, videos: list });
});

app.delete('/api/admin/videos/:id', auth.requireAdmin, (req, res) => {
  const v = db.findById('videos', req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  video.deleteVideoFiles(v.id);
  db.remove('videos', v.id);
  res.json({ ok: true });
});

app.put('/api/admin/videos/:id', auth.requireAdmin, (req, res) => {
  const v = db.findById('videos', req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const { title, description } = req.body || {};
  const patch = {};
  if (typeof title === 'string') patch.title = title;
  if (typeof description === 'string') patch.description = description;
  const updated = db.update('videos', v.id, patch);
  res.json({ ok: true, video: updated });
});

app.get('/api/admin/payments', auth.requireAdmin, (req, res) => {
  const list = db.all('payments').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ ok: true, payments: list });
});

app.get('/api/admin/users', auth.requireAdmin, (req, res) => {
  const list = db.all('users').map(u => ({
    id: u.id, email: u.email, username: u.username,
    subscriptionExpiresAt: u.subscriptionExpiresAt,
    createdAt: u.createdAt,
    active: u.subscriptionExpiresAt > Date.now()
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ ok: true, users: list });
});

app.get('/api/admin/stats', auth.requireAdmin, (req, res) => {
  const users = db.all('users');
  const payments = db.all('payments');
  const videos = db.all('videos');
  const now = Date.now();
  res.json({
    ok: true,
    stats: {
      totalUsers: users.length,
      activeSubscribers: users.filter(u => u.subscriptionExpiresAt > now).length,
      totalPayments: payments.length,
      paidPayments: payments.filter(p => p.status === 'paid').length,
      pendingPayments: payments.filter(p => p.status === 'awaiting_payment' || p.status === 'pending').length,
      failedPayments: payments.filter(p => p.status === 'failed' || p.status === 'expired').length,
      totalVideos: videos.length,
      readyVideos: videos.filter(v => v.status === 'ready').length,
      processingVideos: videos.filter(v => v.status === 'processing').length
    }
  });
});

function sendPage(name) {
  return (req, res) => {
    const p = path.join(__dirname, name);
    if (!fs.existsSync(p)) return res.status(404).send('not found');
    res.sendFile(p);
  };
}

app.get('/', sendPage('index.html'));
app.get('/login', sendPage('login.html'));
app.get('/register', sendPage('register.html'));
app.get('/pay/*', sendPage('pay.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/watch/:id', sendPage('watch.html'));

app.use((err, req, res, next) => {
  console.error('[err]', err);
  res.status(500).json({ error: 'server_error', detail: err.message });
});

console.log('[boot] routes registered, starting listener...');

const server = app.listen(PORT, '0.0.0.0', () => {
  const addr = server.address();
  console.log(`[server] listening on ${addr.address}:${addr.port} (public=${PUBLIC_URL})`);
  console.log(`[server] admin user=${auth.ADMIN_USERNAME}`);
  if (!payment.hasApiKey()) console.warn('[server] WARNING: NOWPAYMENTS_API_KEY not set, payment creation will fail.');

  try { mail.startWorker(); console.log('[boot] mail worker started'); }
  catch (e) { console.error('[boot] mail worker failed:', e.message); }

  setInterval(async () => {
    try {
      if (!payment.hasApiKey()) return;
      const pending = db.find('payments', p => p.status === 'awaiting_payment' && p.paymentId);
      for (const p of pending) {
        try {
          const st = await payment.getPaymentStatus(p.paymentId);
          const status = (st.payment_status || '').toLowerCase();
          db.update('payments', p.id, { remoteStatus: status });
          if (payment.isPaidStatus(status)) await finalizePayment(p);
          else if (payment.isFailedStatus(status)) db.update('payments', p.id, { status: 'failed', failureReason: status });
          else if (p.expiresAt && Date.now() > p.expiresAt + 30 * 60 * 1000) db.update('payments', p.id, { status: 'expired' });
        } catch (e) {
          console.error('[bg-poll]', p.id, e.message);
        }
      }
    } catch (e) { console.error('[bg-poll-loop]', e); }
  }, 60 * 1000);
});

server.on('error', (err) => {
  console.error('[server] listen error:', err.code || err.message, err);
  process.exit(1);
});
