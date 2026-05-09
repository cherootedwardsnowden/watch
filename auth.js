const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
const JWT_EXPIRES = '30d';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'lisa';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Axor0101@@';

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

function generateUsername(seed) {
  const adjectives = ['silver', 'crimson', 'midnight', 'cosmic', 'shadow', 'lunar', 'velvet', 'noble', 'stellar', 'royal'];
  const nouns = ['fox', 'wolf', 'phoenix', 'falcon', 'tiger', 'panther', 'eagle', 'raven', 'lion', 'hawk'];
  const a = adjectives[crypto.randomInt(0, adjectives.length)];
  const n = nouns[crypto.randomInt(0, nouns.length)];
  const num = crypto.randomInt(1000, 9999);
  return `${a}_${n}_${num}`;
}

function generatePassword(length = 14) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*';
  let out = '';
  const buf = crypto.randomBytes(length * 2);
  for (let i = 0; out.length < length && i < buf.length; i++) {
    const idx = buf[i] % chars.length;
    out += chars[idx];
  }
  if (!/[A-Z]/.test(out)) out = 'A' + out.slice(1);
  if (!/[0-9]/.test(out)) out = out.slice(0, -1) + '7';
  if (!/[!@#$%^&*]/.test(out)) out = out.slice(0, -2) + '!' + out.slice(-1);
  return out;
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || '0.0.0.0';
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.auth || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { req.user = null; return next(); }
  const decoded = verifyToken(token);
  if (!decoded) { req.user = null; return next(); }

  if (decoded.role === 'admin') {
    req.user = { id: 'admin', username: ADMIN_USERNAME, role: 'admin', subscriptionActive: true };
    return next();
  }

  const user = db.findById('users', decoded.uid);
  if (!user) { req.user = null; return next(); }
  req.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: 'user',
    subscriptionExpiresAt: user.subscriptionExpiresAt || 0,
    subscriptionActive: user.subscriptionExpiresAt && user.subscriptionExpiresAt > Date.now()
  };
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  next();
}

function requireSubscriber(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (!req.user.subscriptionActive && req.user.role !== 'admin') {
    return res.status(402).json({ error: 'subscription_required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin_required' });
  next();
}

async function adminLogin(username, password) {
  if (username !== ADMIN_USERNAME) return null;
  if (password !== ADMIN_PASSWORD) return null;
  return signToken({ role: 'admin', username });
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateUsername,
  generatePassword,
  signToken,
  verifyToken,
  authMiddleware,
  requireUser,
  requireSubscriber,
  requireAdmin,
  adminLogin,
  getClientIp,
  ADMIN_USERNAME
};
