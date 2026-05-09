const crypto = require('crypto');
const db = require('./db');

const STREAM_SECRET = process.env.STREAM_SECRET || 'dev-stream-secret-change-me';

const PREVIEW_TTL_MS = 60 * 1000;
const FULL_TTL_MS = 60 * 60 * 1000;

function randomPath(parts = 4) {
  const pieces = [];
  for (let i = 0; i < parts; i++) {
    const len = 8 + crypto.randomInt(0, 16);
    pieces.push(crypto.randomBytes(len).toString('base64url').slice(0, len));
  }
  return pieces.join('/');
}

function sign(payload) {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json).toString('base64url');
  const mac = crypto.createHmac('sha256', STREAM_SECRET).update(data).digest('base64url');
  return `${data}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, mac] = parts;
  const expected = crypto.createHmac('sha256', STREAM_SECRET).update(data).digest('base64url');
  let macBuf, expBuf;
  try {
    macBuf = Buffer.from(mac);
    expBuf = Buffer.from(expected);
  } catch (e) { return null; }
  if (macBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(macBuf, expBuf)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function createStreamSession({ videoId, userId, ip, mode }) {
  const ttl = mode === 'preview' ? PREVIEW_TTL_MS : FULL_TTL_MS;
  const sessionId = crypto.randomBytes(16).toString('hex');
  const session = {
    id: sessionId,
    videoId,
    userId: userId || null,
    ip,
    mode,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttl,
    revoked: false,
    pathSlug: randomPath(3 + crypto.randomInt(0, 3))
  };
  db.insert('streamTokens', session);

  const playlistToken = sign({
    sid: session.id,
    vid: videoId,
    ip,
    mode,
    kind: 'playlist',
    exp: session.expiresAt,
    nonce: crypto.randomBytes(8).toString('hex')
  });

  return {
    sessionId,
    pathSlug: session.pathSlug,
    playlistToken,
    expiresAt: session.expiresAt,
    mode
  };
}

function buildSegmentToken(session, segName) {
  return sign({
    sid: session.id,
    vid: session.videoId,
    ip: session.ip,
    mode: session.mode,
    kind: 'segment',
    seg: segName,
    exp: session.expiresAt,
    nonce: crypto.randomBytes(6).toString('hex')
  });
}

function buildKeyToken(session) {
  return sign({
    sid: session.id,
    vid: session.videoId,
    ip: session.ip,
    mode: session.mode,
    kind: 'key',
    exp: session.expiresAt,
    nonce: crypto.randomBytes(6).toString('hex')
  });
}

function getSession(sessionId) {
  return db.findById('streamTokens', sessionId);
}

function isSessionValid(session, ip) {
  if (!session) return false;
  if (session.revoked) return false;
  if (session.expiresAt < Date.now()) return false;
  if (session.ip && ip && session.ip !== ip) return false;
  return true;
}

function revoke(sessionId) {
  db.update('streamTokens', sessionId, { revoked: true });
}

function gcExpired() {
  const now = Date.now();
  const expired = db.find('streamTokens', t => t.expiresAt < now - 24 * 60 * 60 * 1000);
  for (const t of expired) db.remove('streamTokens', t.id);
}

setInterval(gcExpired, 60 * 60 * 1000).unref?.();

module.exports = {
  createStreamSession,
  buildSegmentToken,
  buildKeyToken,
  verify,
  getSession,
  isSessionValid,
  revoke,
  randomPath
};
