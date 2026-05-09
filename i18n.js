const fs = require('fs');
const path = require('path');

const SUPPORTED = ['en', 'tr', 'ru', 'ar', 'ja', 'es', 'fr', 'de', 'zh'];
const DEFAULT_LANG = 'en';

const cache = {};

function loadLang(code) {
  if (cache[code]) return cache[code];
  const file = path.join(__dirname, `lang_${code}.json`);
  if (!fs.existsSync(file)) {
    if (code === DEFAULT_LANG) {
      cache[code] = {};
      return cache[code];
    }
    return loadLang(DEFAULT_LANG);
  }
  try {
    cache[code] = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    cache[code] = {};
  }
  return cache[code];
}

function detectLang(req) {
  const cookieLang = req.cookies?.lang;
  if (cookieLang && SUPPORTED.includes(cookieLang)) return cookieLang;
  const al = (req.headers['accept-language'] || '').toLowerCase();
  for (const part of al.split(',')) {
    const code = part.trim().split(';')[0].split('-')[0];
    if (SUPPORTED.includes(code)) return code;
  }
  return DEFAULT_LANG;
}

function t(code, key, fallback) {
  const dict = loadLang(code);
  if (dict[key]) return dict[key];
  const def = loadLang(DEFAULT_LANG);
  return def[key] || fallback || key;
}

function allLangs() {
  const out = {};
  for (const code of SUPPORTED) out[code] = loadLang(code);
  return out;
}

module.exports = { SUPPORTED, DEFAULT_LANG, loadLang, detectLang, t, allLangs };
